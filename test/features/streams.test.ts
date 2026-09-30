import { describe, expect, test } from 'bun:test';
import { SharpImageCodec } from '../../src/codecs/sharp.ts';
import { compressImages } from '../../src/core/compress.ts';
import { readStream } from '../../src/core/decode.ts';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { nameOf, PdfDict, PdfRef } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { recompressStreams } from '../../src/features/streams.ts';
import { photo } from '../corpus/images.ts';
import { Rng } from '../support/prng.ts';
import { bytes, DocBuilder, drawImage, drawText, flate, imageDict, paragraph, vectorArt } from '../support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfTransform } from '../support/qpdf.ts';
import { renderPdf, sameRaster } from '../support/render.ts';
import { BytesSink, BytesSource } from '../unit/util.ts';

if (!hasQpdf) console.warn(QPDF_MISSING);

async function run(input: Uint8Array, plugins: Plugin[], concurrency = 1) {
  const sink = new BytesSink();
  const report = await rewritePdf(new BytesSource(input), sink, plugins, { concurrency });
  return { out: sink.bytes(), report };
}

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

function expectValid(out: Uint8Array): void {
  if (!hasQpdf) return;
  const r = qpdfCheck(out);
  if (r.code !== 0) console.error(r.output);
  expect(r.code).toBe(0);
}

function expectSameRendering(a: Uint8Array, b: Uint8Array): void {
  const x = renderPdf(a, 8);
  const y = renderPdf(b, 8);
  expect(y.pageCount).toBe(x.pageCount);
  x.pages.forEach((p, i) => expect(sameRaster(p!, y.pages[i]!)).toBe(true));
}

/** Uncompressed content streams and an image, plus streams that must be left alone. */
function doc(objStm = false) {
  const b = new DocBuilder();
  const n: Record<string, number> = {};
  const img = photo(200, 150, 7);
  n.img = b.stream(imageDict({ width: 200, height: 150, colorSpace: '/DeviceRGB' }), img.data);
  n.page0 = b.page({ content: drawText('Raw content', 40, 800, 18) + paragraph(40, 760, 40, 10, 3) + drawImage('Im', 300, 300, 200, 150), xobjects: { Im: n.img } }, { raw: true });
  n.page1 = b.page({ content: vectorArt(40, 300, 500, 300, 4) + paragraph(40, 800, 20, 10, 5) }, { raw: true, length: 'indirect' });
  n.page2 = b.page({ content: paragraph(40, 800, 30, 10, 9) });
  n.flated = b.stream('/Filter /FlateDecode', flate(bytes('already compressed '.repeat(50))));
  n.xmp = b.stream('/Type /Metadata /Subtype /XML', bytes(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${'metadata '.repeat(40)}</x:xmpmeta>`));
  n.parms = b.stream('/DecodeParms << /Predictor 12 /Columns 4 >>', bytes('xxxx'.repeat(100)));
  n.tiny = b.stream('', bytes('q Q'));
  n.embedded = b.stream('/Type /EmbeddedFile', bytes('embedded text '.repeat(200)));
  n.noise = b.stream('', new Rng(5).bytes(4000));
  n.fs = b.obj(`<< /Type /Filespec /F (a.txt) /EF << /F ${n.embedded} 0 R >> >>`);
  b.catalogExtra = ` /Metadata ${n.xmp} 0 R /Names << /EmbeddedFiles << /Names [(a.txt) ${n.fs} 0 R] >> >> /Extra [${n.flated} 0 R ${n.parms} 0 R ${n.tiny} 0 R ${n.noise} 0 R]`;
  b.finish('streams');
  return { bytes: b.build(objStm ? { xref: 'stream', objStm: true, version: '1.5' } : {}).bytes, n };
}

async function streamDict(b: Uint8Array, num: number): Promise<PdfDict> {
  return (await (await open(b)).getObject(num)) as PdfDict;
}

async function contentsOf(b: Uint8Array, page: number): Promise<number> {
  return ((await streamDict(b, page)).get('Contents') as PdfRef).num;
}

describe('recompressStreams', () => {
  for (const objStm of [false, true]) {
    test(`compresses unfiltered streams losslessly${objStm ? ' (object streams)' : ''}`, async () => {
      const { bytes: input, n } = doc(objStm);
      expectValid(input);
      const plugin = recompressStreams();
      const { out, report } = await run(input, [plugin]);
      expectValid(out);
      expectSameRendering(input, out);
      expect(out.length).toBeLessThan(input.length - 10_000);
      const src = await open(input);
      const dst = await open(out);
      const compressed = [n.img, n.embedded, await contentsOf(input, n.page0), await contentsOf(input, n.page1)];
      for (const num of compressed) {
        const d = (await dst.getObject(num)) as PdfDict;
        expect(nameOf(d.get('Filter'))).toBe('FlateDecode');
        expect(d.get('DL')).toBeUndefined();
        expect(await readStream(dst, new PdfRef(num, 0))).toEqual(await readStream(src, new PdfRef(num, 0)));
      }
      // Left alone: already filtered, metadata, a /DecodeParms without filter, tiny, incompressible.
      for (const num of [n.flated, n.xmp, n.parms, n.tiny, n.noise]) {
        expect((await dst.getObject(num)) as PdfDict).toEqual((await src.getObject(num)) as PdfDict);
      }
      expect(plugin.report).toEqual({ streamsSeen: 6, streamsCompressed: 4, bytesSaved: plugin.report.bytesSaved });
      expect(plugin.report.bytesSaved).toBeGreaterThan(input.length - out.length - 1000);
      expect(report.outputBytes).toBe(out.length);
    });
  }

  test('images: false leaves images to others', async () => {
    const { bytes: input, n } = doc();
    const plugin = recompressStreams({ images: false });
    const { out } = await run(input, [plugin]);
    expectValid(out);
    expect((await streamDict(out, n.img)).get('Filter')).toBeUndefined();
    expect(plugin.report.streamsCompressed).toBe(3);
  });

  test('the same output whatever the concurrency', async () => {
    const { bytes: input } = doc();
    const a = await run(input, [recompressStreams()], 1);
    const b = await run(input, [recompressStreams()], 4);
    expect(b.out).toEqual(a.out);
  });

  test('encrypted documents are rejected, also next to a decrypting plugin', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(doc().bytes, ['--encrypt', 'u', 'o', '256', '--']);
    await expect(run(enc, [recompressStreams()])).rejects.toBeInstanceOf(PdfEncryptedError);
    await expect(run(enc, [{ decrypts: true }, recompressStreams()])).rejects.toBeInstanceOf(PdfEncryptedError);
  });

  test('after compressImages, images go to compressImages', async () => {
    const { bytes: input, n } = doc();
    const images = compressImages({ codec: new SharpImageCodec(), minImageBytes: 1000 });
    const streams = recompressStreams();
    const { out } = await run(input, [images, streams]);
    expectValid(out);
    expect(images.report.imagesRecompressed).toBe(1);
    expect(nameOf((await streamDict(out, n.img)).get('Filter'))).toBe('DCTDecode');
    expect(streams.report.streamsCompressed).toBe(3);
    // Put first, it takes the image itself (losslessly).
    const first = await run(input, [recompressStreams(), compressImages({ codec: new SharpImageCodec(), minImageBytes: 1000 })]);
    expect(nameOf((await streamDict(first.out, n.img)).get('Filter'))).toBe('FlateDecode');
  });
});
