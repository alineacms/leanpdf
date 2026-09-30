import { describe, expect, test } from 'bun:test';
import { decodeStream, openStream } from '../../src/core/decode.ts';
import { PdfRef } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { bytes, DocBuilder, flate } from '../support/pdfgen.ts';
import { BytesSource } from './util.ts';

/** PNG Up-filtered rows (predictor 12). */
function pngUp(data: Uint8Array, cols: number): Uint8Array {
  const rows = data.length / cols;
  const out = new Uint8Array(rows * (cols + 1));
  for (let y = 0; y < rows; y++) {
    out[y * (cols + 1)] = 2;
    for (let x = 0; x < cols; x++) out[y * (cols + 1) + 1 + x] = (data[y * cols + x] - (y ? data[(y - 1) * cols + x] : 0)) & 255;
  }
  return out;
}

const samples = Uint8Array.from({ length: 300 * 1000 }, (_, i) => (i * 7 + (i >> 9)) & 255);

async function fixture() {
  const b = new DocBuilder();
  const n = {
    raw: b.stream('', samples),
    flate: b.stream('/Filter /FlateDecode', flate(samples)),
    predicted: b.stream('/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 300 >>', flate(pngUp(samples, 300))),
    abbreviated: b.stream('/Filter /Fl', flate(samples)),
    hex: b.stream('/Filter /ASCIIHexDecode', bytes(Buffer.from(samples.subarray(0, 5000)).toString('hex') + '>')),
    jpeg: b.stream('/Filter [/FlateDecode /DCTDecode]', flate(bytes('not really a jpeg'))),
    truncated: b.stream('/Filter /FlateDecode', flate(samples).subarray(0, 20000)),
    badPredictor: b.stream('/Filter /FlateDecode /DecodeParms << /Predictor 2 /BitsPerComponent 4 >>', flate(samples)),
  };
  b.page({ content: '' });
  const doc = await openPdf(new BytesSource(b.finish().build().bytes));
  return { doc, n };
}

/** Everything a streamed read delivers, copied piece by piece, and the pieces' sizes. */
async function drain(s: NonNullable<Awaited<ReturnType<typeof openStream>>>, stopAfter = Infinity) {
  const parts: Uint8Array[] = [];
  const ok = await s.read((c) => {
    parts.push(c.slice());
    return parts.length >= stopAfter;
  });
  return { ok, data: Buffer.concat(parts), sizes: parts.map((p) => p.length) };
}

describe('openStream', () => {
  test('delivers the same bytes as decodeStream, streaming raw, Flate and predicted data', async () => {
    const { doc, n } = await fixture();
    for (const k of ['raw', 'flate', 'predicted', 'abbreviated', 'hex'] as const) {
      const s = await openStream(doc, new PdfRef(n[k], 0));
      const whole = await decodeStream(doc, new PdfRef(n[k], 0));
      const r = await drain(s!);
      expect(r.ok).toBe(true);
      expect(Buffer.compare(r.data, Buffer.from(whole!.data))).toBe(0);
      if (k === 'raw' || k === 'flate' || k === 'predicted') expect(r.sizes.length).toBeGreaterThan(1);
      // Predicted data arrives a row at a time.
      if (k === 'predicted') expect(new Set(r.sizes)).toEqual(new Set([300]));
    }
  });

  test('stops when asked', async () => {
    const { doc, n } = await fixture();
    for (const k of ['raw', 'flate', 'predicted'] as const) {
      const r = await drain((await openStream(doc, new PdfRef(n[k], 0)))!, 2);
      expect(r.sizes.length).toBe(2);
    }
  });

  test('stops at an image codec, with its bytes', async () => {
    const { doc, n } = await fixture();
    const s = (await openStream(doc, new PdfRef(n.jpeg, 0)))!;
    expect(s.codec).toBe('DCTDecode');
    expect(Buffer.from((await drain(s)).data).toString()).toBe('not really a jpeg');
  });

  test('truncated data: what decoded; unusable predictors: null', async () => {
    const { doc, n } = await fixture();
    // Whether truncation reads as an error depends on the runtime's DecompressionStream.
    const r = await drain((await openStream(doc, new PdfRef(n.truncated, 0)))!);
    expect(r.data.length).toBeGreaterThan(0);
    expect(Buffer.compare(r.data, Buffer.from(samples.subarray(0, r.data.length)))).toBe(0);
    expect(await openStream(doc, new PdfRef(n.badPredictor, 0))).toBeNull();
  });
});
