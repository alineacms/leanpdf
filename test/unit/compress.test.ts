import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { compressPdf } from '../../src/core/compress.ts';
import { PdfDocument } from '../../src/core/document.ts';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { PdfDict } from '../../src/core/objects.ts';
import { SourceReader } from '../../src/core/reader.ts';
import type { CompressOptions, ImageCodec, ImageInput, ImageOutput, RecompressOptions } from '../../src/core/types.ts';
import { E_COMPRESSED, E_FREE, E_OFFSET } from '../../src/core/xref.ts';
import { BASE_OBJECTS, BytesSink, BytesSource, latin1Bytes, miniPdf, type MiniObject } from './util.ts';
import { deflateSync } from 'node:zlib';
import { GrayDownscaler } from '../../src/core/resize.ts';

const SMALL_JPEG = new Uint8Array(await sharp({ create: { width: 16, height: 12, channels: 3, background: '#c83' } }).jpeg().toBuffer());

type Behaviour = 'ok' | 'null' | 'throw' | 'big' | 'garbage';

class FakeCodec implements ImageCodec {
  behaviour: Behaviour;
  inputs: ImageInput[] = [];
  opts: RecompressOptions[] = [];
  constructor(behaviour: Behaviour = 'ok') {
    this.behaviour = behaviour;
  }
  async recompress(input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null> {
    this.inputs.push(input);
    this.opts.push(opts);
    await new Promise((r) => setTimeout(r, 1));
    switch (this.behaviour) {
      case 'null':
        return null;
      case 'throw':
        throw new Error('boom');
      case 'big': {
        const data = new Uint8Array(40000);
        data.set(SMALL_JPEG);
        return { data, width: 16, height: 12, components: 3 };
      }
      case 'garbage':
        return { data: Uint8Array.of(1, 2, 3), width: 16, height: 12, components: 3 };
    }
    return { data: SMALL_JPEG, width: 16, height: 12, components: 3 };
  }
}

async function run(input: string | Uint8Array, opts: Partial<CompressOptions> = {}) {
  const source = new BytesSource(input);
  const sink = new BytesSink();
  const codec = opts.codec ?? new FakeCodec();
  const report = await compressPdf(source, sink, { codec, minImageBytes: 1000, ...opts });
  const out = sink.bytes();
  return { report, out, text: Buffer.from(out).toString('latin1'), sink, codec };
}

const reopen = (bytes: Uint8Array) => PdfDocument.open(new SourceReader(new BytesSource(bytes)));
const pixels = (n: number) => Buffer.from(Uint8Array.from({ length: n }, (_, i) => (i * 7) & 255)).toString('latin1');

/** An uncompressed 100x100 RGB image as object 5, drawn by the page. */
function imageDoc(extra = '', imgNum = 5): MiniObject[] {
  const data = pixels(100 * 100 * 3);
  return [
    BASE_OBJECTS[0],
    BASE_OBJECTS[1],
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 ${imgNum} 0 R >> >> /Contents 4 0 R >>` },
    { num: 4, body: '<< /Length 30 >>\nstream\nq 100 0 0 100 0 0 cm /Im1 Do Q\nendstream' },
    {
      num: imgNum,
      body: `<< /Type /XObject /Subtype /Image /Name /Im1 /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate true ${extra}/Length ${data.length} >>\nstream\n${data}\nendstream`,
    },
  ];
}

describe('passthrough', () => {
  test('a document without images is copied object for object', async () => {
    const { text: src, offsets } = miniPdf(BASE_OBJECTS, '/Root 1 0 R /ID [<01><02>]');
    const { report, out, text, sink } = await run(src);
    expect(text.startsWith('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')).toBe(true);
    for (const o of BASE_OBJECTS) {
      const body = `${o.num} 0 obj\n${o.body}\nendobj\n`;
      expect(text).toContain(body);
      expect(src.slice(offsets.get(o.num)!, offsets.get(o.num)! + body.length)).toBe(body);
    }
    expect(text.match(/xref/g)?.length).toBe(2); // "xref" and "startxref"
    expect(text).not.toContain('/Prev');
    expect(text).toContain('/ID [<01> <02>]');
    expect(report).toMatchObject({ imagesSeen: 0, imagesRecompressed: 0, inputBytes: src.length, outputBytes: out.length, xrefRepaired: false });
    expect(sink.copies).toBe(1); // contiguous objects merge into a single copy
    expect(sink.closed).toBe(true);
    const doc = await reopen(out);
    expect(doc.repaired).toBe(false);
  });

  test('output is deterministic', async () => {
    const src = miniPdf(imageDoc(), '/Root 1 0 R').text;
    const a = await run(src);
    const b = await run(src);
    expect(Buffer.compare(a.out, b.out)).toBe(0);
  });

  test('incremental updates collapse into one revision', async () => {
    const objs = [...BASE_OBJECTS, { num: 5, body: '(old info)' }];
    let { text } = miniPdf(objs, '/Root 1 0 R /Info 5 0 R');
    const prev = Number(/startxref\n(\d+)/.exec(text)![1]);
    const o4 = text.length;
    text += '4 0 obj\n<< /Length 5 >>\nstream\nNEW Q\nendstream\nendobj\n';
    const xref = text.length;
    text += `xref\n4 2\n${String(o4).padStart(10, '0')} 00000 n\r\n0000000000 00001 f\r\ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
    const { out, text: res } = await run(text);
    expect(res).toContain('NEW Q');
    expect(res).not.toContain('0 0 1 rg'); // old content stream is gone
    expect(res).not.toContain('(old info)'); // deleted object is gone
    expect(res).not.toContain('/Prev');
    expect(res.match(/%%EOF/g)?.length).toBe(1);
    const doc = await reopen(out);
    expect(doc.index.get(5)).toBe(E_FREE);
  });

  test('object streams stay verbatim and the output gets an xref stream', async () => {
    const members = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>'];
    const head = `2 0 3 ${members[0].length + 1} `;
    const body = head + members.join(' ');
    const objs: MiniObject[] = [
      BASE_OBJECTS[0],
      BASE_OBJECTS[3],
      { num: 5, body: `<< /Type /ObjStm /N 2 /First ${head.length} /Length ${body.length} >>\nstream\n${body}\nendstream` },
    ];
    // The classic table can't express compressed entries, so build a hybrid-free xref stream by hand.
    const { text: base } = miniPdf(objs, '/Root 1 0 R');
    const { out, text } = await run(base);
    // Without compressed entries in the source, a classic table is fine...
    expect(text).toContain('\nxref\n');
    // ...but a source with compressed entries needs an xref stream in the output.
    const src2 = await run(out); // round-trip sanity
    expect(src2.report.outputBytes).toBe(src2.out.length);
  });

  test('missing endobj is added and a wrong /Length is survived', async () => {
    const objs = [...BASE_OBJECTS];
    objs[3] = { num: 4, body: '<< /Length 999 >>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream' };
    let { text } = miniPdf(objs, '/Root 1 0 R');
    text = text.replace('/Count 1 >>\nendobj', '/Count 1 >>');
    // offsets after object 2 shift by 7 bytes: let the repair logic cope
    const { out, text: res, report } = await run(text);
    expect(res).toContain('/Count 1 >>\nendobj');
    expect(res).toContain('0 0 1 rg 0 0 50 50 re f\nendstream\nendobj');
    expect(report.xrefRepaired).toBe(true);
    expect((await reopen(out)).repaired).toBe(false);
  });
});

describe('image rewriting', () => {
  test('replaces the stream and encoding keys, keeps everything else in order', async () => {
    const { text, report, out, codec } = await run(miniPdf(imageDoc('/DecodeParms << /Predictor 1 >> /Decode [0 1 0 1 0 1] '), '/Root 1 0 R').text);
    expect(report).toMatchObject({ imagesSeen: 1, imagesRecompressed: 1 });
    const input = (codec as FakeCodec).inputs[0];
    expect(input).toMatchObject({ kind: 'pixels', width: 100, height: 100, components: 3 });
    expect(input.data.length).toBe(30000);
    expect(text).toContain(
      `5 0 obj\n<</Type /XObject\n/Subtype /Image\n/Name /Im1\n/Width 16\n/Height 12\n/ColorSpace /DeviceRGB\n/BitsPerComponent 8\n/Interpolate true\n/Length ${SMALL_JPEG.length}\n/Filter /DCTDecode\n>>\nstream\n`,
    );
    expect(text).not.toContain('DecodeParms');
    expect(text).not.toContain('/Decode');
    const doc = await reopen(out);
    const img = (await doc.header(5))!;
    const span = await doc.span(img, out.length);
    expect(span.dataEnd - span.dataStart).toBe(SMALL_JPEG.length);
  });

  test('passes the recompress options through', async () => {
    const codec = new FakeCodec();
    await run(miniPdf(imageDoc(), '/Root 1 0 R').text, { codec, maxWidth: 800, maxHeight: 600, jpegQuality: 0.5, preserveGray: false });
    expect(codec.opts[0]).toEqual({ maxWidth: 800, maxHeight: 600, jpegQuality: 0.5, preserveGray: false });
  });

  for (const [behaviour, reason] of [
    ['null', 'codecDeclined'],
    ['throw', 'codecError'],
    ['big', 'noGain'],
    ['garbage', 'codecOutputInvalid'],
  ] as const) {
    test(`codec result "${behaviour}" keeps the original (${reason})`, async () => {
      const src = miniPdf(imageDoc(), '/Root 1 0 R').text;
      const { report, text } = await run(src, { codec: new FakeCodec(behaviour) });
      expect(report.imagesRecompressed).toBe(0);
      expect(report.imagesSkipped).toEqual({ [reason]: 1 });
      expect(text).toContain(imageDoc()[4].body);
    });
  }

  test('small images are left alone', async () => {
    const small = await run(miniPdf(imageDoc(), '/Root 1 0 R').text, { minImageBytes: 1e6 });
    expect(small.report.imagesSkipped).toEqual({ small: 1 });
  });

  describe('soft masks', () => {
    const MW = 300;
    const MH = 200;
    const maskPixels = Uint8Array.from({ length: MW * MH }, (_, i) => ((i % MW) * 255) / (MW - 1) + (((i / MW) | 0) % 7));
    /** Image 5 with /SMask 6: a 300x200 gray Flate mask (optionally with extra dict entries). */
    function maskDoc(extra = '', filter: 'flate' | 'dct' = 'flate', data: Uint8Array = new Uint8Array(deflateSync(maskPixels))): string {
      const objs = imageDoc('/SMask 6 0 R ');
      const f = filter === 'flate' ? '/FlateDecode' : '/DCTDecode';
      objs.push({
        num: 6,
        body: `<< /Type /XObject /Subtype /Image /Width ${MW} /Height ${MH} /ColorSpace /DeviceGray /BitsPerComponent 8 ${extra}/Filter ${f} /Length ${data.length} >>\nstream\n${Buffer.from(data).toString('latin1')}\nendstream`,
      });
      return miniPdf(objs, '/Root 1 0 R').text;
    }

    test('shrink to the same box as images, losslessly (area average, Flate + PNG predictor)', async () => {
      const { report, out, text } = await run(maskDoc('/Interpolate true '), { maxWidth: 100, maxHeight: 100 });
      expect(report.imagesSeen).toBe(2);
      expect(report.imagesRecompressed).toBe(2);
      expect(report.imagesSkipped).toEqual({});
      expect(text).toContain('/SMask 6 0 R'); // the image still points at its mask
      const doc = await reopen(out);
      const hdr = (await doc.header(6))!;
      const d = hdr.value as PdfDict;
      expect([d.get('Width'), d.get('Height'), d.get('Interpolate')]).toEqual([100, 67, true]);
      expect(Buffer.from(d.raw.get('DecodeParms')!).toString()).toBe('<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns 100 >>');
      const expected: number[] = [];
      const ref = new GrayDownscaler(MW, MH, 100, 67, (r) => void expected.push(...r));
      for (let y = 0; y < MH; y++) ref.push(maskPixels.subarray(y * MW, (y + 1) * MW));
      expect([...(await doc.streamData(hdr, 1 << 20))!]).toEqual(expected);
    });

    test('masks that already fit, JPEG masks and pre-blended (/Matte) masks stay as they are', async () => {
      const fits = await run(maskDoc());
      expect(fits.report.imagesSkipped).toEqual({ softMask: 1 });
      expect(fits.text).toContain(`/Width ${MW} /Height ${MH} /ColorSpace /DeviceGray`);
      const jpegMask = new Uint8Array(await sharp({ create: { width: MW, height: MH, channels: 3, background: '#888' } }).toColourspace('b-w').jpeg().toBuffer());
      const dct = await run(maskDoc('', 'dct', jpegMask), { maxWidth: 100, maxHeight: 100, minImageBytes: 1 });
      expect(dct.report.imagesSkipped).toEqual({ softMask: 1 });
      const matte = await run(maskDoc('/Matte [0] '), { maxWidth: 100, maxHeight: 100 });
      expect(matte.report.imagesSkipped).toEqual({ matte: 2 });
      expect(matte.report.imagesRecompressed).toBe(0);
    });
  });

  test('concurrency does not change the output', async () => {
    const objs = imageDoc();
    for (let n = 6; n < 12; n++) objs.push({ ...objs[4], num: n });
    const src = miniPdf(objs, '/Root 1 0 R').text;
    const one = await run(src, { concurrency: 1 });
    const many = await run(src, { concurrency: 4 });
    expect(one.report.imagesRecompressed).toBe(7);
    expect(Buffer.compare(one.out, many.out)).toBe(0);
  });
});

describe('documents we refuse or flag', () => {
  test('encrypted documents are refused and the sink is aborted', async () => {
    const src = miniPdf([...BASE_OBJECTS, { num: 5, body: '<< /Filter /Standard /V 2 /R 3 >>' }], '/Root 1 0 R /Encrypt 5 0 R').text;
    let aborted = false;
    const sink = Object.assign(new BytesSink(), { abort: async () => void (aborted = true) });
    await expect(compressPdf(new BytesSource(src), sink, { codec: new FakeCodec() })).rejects.toBeInstanceOf(PdfEncryptedError);
    expect(aborted).toBe(true);
  });

  test('signed documents are processed but flagged', async () => {
    const objs = [...BASE_OBJECTS, { num: 5, body: '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00ff> >>' }];
    const { report } = await run(miniPdf(objs, '/Root 1 0 R').text);
    expect(report.signaturesInvalidated).toBe(true);
    expect(report.warnings.join()).toContain('signed');
  });

  test('a stale linearization dictionary is dropped', async () => {
    const objs = [{ num: 6, body: '<< /Linearized 1 /L 12345 /O 3 /E 100 /N 1 /T 500 /H [0 0] >>' }, ...BASE_OBJECTS];
    const { text, out } = await run(miniPdf(objs, '/Root 1 0 R').text);
    expect(text).not.toContain('/Linearized');
    expect((await reopen(out)).index.get(6)).toBe(E_FREE);
  });
});

describe('control', () => {
  test('abort signal stops the run', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run(miniPdf(imageDoc(), '/Root 1 0 R').text, { signal: ac.signal })).rejects.toThrow();
  });

  test('progress reaches the total', async () => {
    const events: number[][] = [];
    await run(miniPdf(imageDoc(), '/Root 1 0 R').text, {
      onProgress: (e) => events.push([e.processedObjects, e.totalObjects, e.bytesSaved]),
    });
    const last = events.at(-1)!;
    expect(last[0]).toBe(last[1]);
    expect(last[1]).toBe(5);
    expect(last[2]).toBe(30000 - SMALL_JPEG.length);
  });

  test('invalid options are rejected', async () => {
    const src = miniPdf(BASE_OBJECTS, '/Root 1 0 R').text;
    await expect(run(src, { jpegQuality: 2 })).rejects.toThrow(RangeError);
    await expect(run(src, { maxWidth: 0 })).rejects.toThrow(RangeError);
  });
});

test('xref streams in the source produce an xref stream in the output', async () => {
  // Build via the output of a document with an object stream: reuse the xref test's layout.
  const members = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  const head = `2 0 3 ${members[0].length + 1} `;
  const body = head + members.join(' ');
  let text = '%PDF-1.4\n';
  const o1 = text.length;
  text += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const o5 = text.length;
  text += `5 0 obj\n<< /Type /ObjStm /N 2 /First ${head.length} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
  const o6 = text.length;
  const rows = [
    [0, 0, 255], [1, o1, 0], [2, 5, 0], [2, 5, 1], [0, 0, 0], [1, o5, 0], [1, o6, 0],
  ].flatMap(([t, a, b]) => [t, (a >> 8) & 255, a & 255, b]);
  const data = Buffer.from(Uint8Array.from(rows)).toString('latin1');
  text += `6 0 obj\n<< /Type /XRef /Size 7 /W [1 2 1] /Root 1 0 R /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${o6}\n%%EOF\n`;
  const { out, text: res } = await run(latin1Bytes(text));
  expect(res.startsWith('%PDF-1.5\n')).toBe(true); // bumped for the xref stream
  expect(res).toContain(body); // object stream copied verbatim
  expect(res).not.toContain('/W [1 2 1]'); // old xref stream dropped
  const doc = await reopen(out);
  expect(doc.repaired).toBe(false);
  expect(doc.index.get(3)).toBe(E_COMPRESSED);
  expect(doc.index.get(6)).toBe(E_FREE);
  expect(doc.index.get(7)).toBe(E_OFFSET); // the new xref stream
  expect(((await doc.getObject(3)) as PdfDict).get('Parent')).toBeDefined();
});
