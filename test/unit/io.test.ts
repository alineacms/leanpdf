/** Every function that reads takes a Blob, bytes or a source; every one that writes, a sink or a WritableStream. */
import { describe, expect, test } from 'bun:test';
import { compressPdf, mergePdfs, openPdf, repairPdf, rewritePdf, BlobPartsSink, getPages, type ImageCodec } from '../../src/index.ts';
import { decryptPdf, openEncryptedPdf } from '../../src/features/decrypt.ts';
import { DocBuilder } from '../support/pdfgen.ts';

const pdf = (pages: number): Uint8Array => {
  const b = new DocBuilder();
  for (let i = 0; i < pages; i++) b.page({ width: 200, height: 100, content: `BT /F1 12 Tf 10 50 Td (Page ${i + 1}) Tj ET` });
  return b.finish().build().bytes;
};

/** A WritableStream that collects what it's given; `aborted` says whether it was aborted. */
function collector() {
  const chunks: Uint8Array[] = [];
  const state = { closed: false, aborted: false };
  const stream = new WritableStream<Uint8Array>({
    write: (c) => void chunks.push(c.slice()),
    close: () => void (state.closed = true),
    abort: () => void (state.aborted = true),
  });
  const bytes = () => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) out.set(c, (o += c.length) - c.length);
    return out;
  };
  return { stream, state, bytes };
}

const pageCount = async (b: Uint8Array) => (await getPages(await openPdf(b))).length;
const noCodec: ImageCodec = { recompress: async () => null };

describe('inputs and outputs', () => {
  const two = pdf(2);

  test('the same output from a Blob, bytes and an ArrayBuffer', async () => {
    const outs: Uint8Array[] = [];
    for (const input of [new Blob([two as Uint8Array<ArrayBuffer>]), two, two.slice().buffer]) {
      const sink = new BlobPartsSink();
      await rewritePdf(input, sink);
      outs.push(new Uint8Array(await sink.blob.arrayBuffer()));
    }
    expect(outs[1]).toEqual(outs[0]);
    expect(outs[2]).toEqual(outs[0]);
  });

  test('compressPdf and repairPdf write into a WritableStream, and close it', async () => {
    for (const run of [(o: WritableStream<Uint8Array>) => compressPdf(two, o, { codec: noCodec }), (o: WritableStream<Uint8Array>) => repairPdf(two, o)]) {
      const c = collector();
      const report = await run(c.stream);
      expect(c.state.closed).toBe(true);
      expect(c.bytes().length).toBe(report.outputBytes);
      expect(await pageCount(c.bytes())).toBe(2);
    }
  });

  test('mergePdfs takes mixed inputs', async () => {
    const c = collector();
    const r = await mergePdfs([new Blob([two as Uint8Array<ArrayBuffer>]), pdf(3), await openPdf(pdf(1))], c.stream);
    expect(r.pageCount).toBe(6);
    expect(await pageCount(c.bytes())).toBe(6);
  });

  test('decryptPdf and openEncryptedPdf take bytes (unencrypted input is copied)', async () => {
    const c = collector();
    const r = await decryptPdf(two, c.stream);
    expect(r.encrypted).toBe(false);
    expect(await pageCount(c.bytes())).toBe(2);
    expect((await getPages(await openEncryptedPdf(two))).length).toBe(2);
  });

  test('a failed write aborts the stream', async () => {
    const c = collector();
    await expect(rewritePdf(new TextEncoder().encode('not a pdf'), c.stream)).rejects.toThrow();
    expect(c.state.aborted).toBe(true);
    expect(c.state.closed).toBe(false);
  });
});
