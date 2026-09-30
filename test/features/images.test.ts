import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { openPdf } from '../../src/core/open.ts';
import { extractImage, listImages, type ImageInfo } from '../../src/features/images.ts';
import { bitmap, jpeg, photo, pngPredict, tiffPredict, to16Bit, toIndexed, type Pixels } from '../corpus/images.ts';
import { bytes as latin1, bytesEqual, damage, DocBuilder, drawImage, flate, imageDict } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import { BytesSource } from '../unit/util.ts';

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

/** Deterministic damaged copies: byte flips, truncations, deleted and duplicated ranges. */
function* mutants(src: Uint8Array, count: number, seed: number): Generator<Uint8Array> {
  const r = new Rng(seed);
  for (let i = 0; i < count; i++) {
    const at = r.int(0, src.length - 1);
    const len = r.int(1, 400);
    switch (i % 4) {
      case 0: {
        const m = src.slice();
        for (let k = 0; k < 12; k++) m[r.int(0, m.length - 1)] = r.int(0, 255);
        yield m;
        break;
      }
      case 1:
        yield src.slice(0, at);
        break;
      case 2:
        yield Buffer.concat([src.subarray(0, at), src.subarray(Math.min(src.length, at + len))]);
        break;
      default:
        yield Buffer.concat([src.subarray(0, at), src.subarray(at, at + len), src.subarray(at)]);
    }
  }
}

/** Run `fn` on damaged copies of `src`: each must settle with a value or an Error. */
async function survives(src: Uint8Array, seed: number, fn: (doc: Awaited<ReturnType<typeof open>>) => Promise<unknown>): Promise<number> {
  let ok = 0;
  for (const m of mutants(src, 80, seed)) {
    try {
      await fn(await open(m));
      ok++;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  }
  return ok;
}

function mu(b: Uint8Array): mupdf.PDFDocument {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  return mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
}

const rgb = photo(40, 30, 1);
const gray = photo(20, 10, 2, 1);
const rgb2 = photo(24, 16, 3);
const icc = photo(16, 16, 4);
const cmyk: Pixels = { width: 8, height: 8, comps: 4, data: Uint8Array.from({ length: 256 }, (_, i) => (i * 5) & 255) };
const JPEG_RGB = await jpeg(photo(64, 48, 5));
const JPEG_GRAY = await jpeg(photo(32, 32, 6, 1));

interface Fixture {
  bytes: Uint8Array;
  n: Record<string, number>;
}

/**
 * Four pages of images: page 0 draws a JPEG and a predicted Flate RGB image with a soft mask;
 * page 1 a form containing a form (in a cycle) with a raw gray image and the same JPEG; page 2
 * a tiling pattern with a Flate-wrapped gray JPEG, an annotation appearance with an image mask,
 * and indexed, CMYK, ICC, Separation, inverted, 16-bit and TIFF-predicted images; page 3 none.
 */
function imagesDoc(): Fixture {
  const b = new DocBuilder();
  const n: Record<string, number> = {};
  n.jpeg = b.stream(imageDict({ width: 64, height: 48, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), JPEG_RGB);
  n.smask = b.stream(imageDict({ width: 40, height: 30, colorSpace: '/DeviceGray', filter: '/FlateDecode' }), flate(photo(40, 30, 9, 1).data));
  n.png = b.stream(
    imageDict({ width: 40, height: 30, colorSpace: '/DeviceRGB', filter: '/Fl', decodeParms: '<< /Predictor 15 /Colors 3 /Columns 40 >>', extra: `/SMask ${n.smask} 0 R` }),
    flate(pngPredict(rgb, 'cycle').data),
  );
  b.page({ content: drawImage('A', 0, 0, 64, 48) + drawImage('B', 100, 0, 40, 30), xobjects: { A: n.jpeg, B: n.png } });

  n.gray = b.stream(imageDict({ width: 20, height: 10, colorSpace: '/G' }), gray.data);
  const f1 = b.alloc();
  const f2 = b.alloc();
  b.setStream(f2, `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /G ${n.gray} 0 R /J ${n.jpeg} 0 R /Up ${f1} 0 R >> >>`, latin1('/G Do /J Do'));
  b.setStream(f1, `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /F2 ${f2} 0 R >> >>`, latin1('/F2 Do'));
  const bare = b.stream('/Type /XObject /Subtype /Form /BBox [0 0 1 1]', latin1(''));
  b.page({ content: '/F1 Do /Bare Do', xobjects: { F1: f1, Bare: bare } });

  n.flateDct = b.stream(imageDict({ width: 32, height: 32, colorSpace: '/DeviceGray', filter: '[/FlateDecode /DCTDecode]' }), flate(JPEG_GRAY));
  const pattern = b.stream(
    `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 32 32] /XStep 32 /YStep 32 /Resources << /XObject << /I ${n.flateDct} 0 R >> >>`,
    latin1('q 32 0 0 32 0 0 cm /I Do Q'),
  );
  n.mask = b.stream(imageDict({ width: 32, height: 32, bpc: 1, extra: '/ImageMask true' }), bitmap(32, 32));
  const ap = b.stream(`/Type /XObject /Subtype /Form /BBox [0 0 32 32] /Resources << /XObject << /M ${n.mask} 0 R >> >>`, latin1('/M Do'));
  const annot = b.obj(`<< /Type /Annot /Subtype /Stamp /Rect [0 0 32 32] /AP << /N << /On ${ap} 0 R /Off ${ap} 0 R >> >> >>`);
  const ix = toIndexed(rgb2);
  const palette = b.stream('', ix.palette);
  n.indexed = b.stream(imageDict({ width: 24, height: 16, colorSpace: `[/Indexed /DeviceRGB 215 ${palette} 0 R]`, filter: '/FlateDecode' }), flate(ix.data));
  n.cmyk = b.stream(imageDict({ width: 8, height: 8, colorSpace: '/DeviceCMYK' }), cmyk.data);
  const profile = b.stream('/N 3', new Uint8Array(0));
  n.icc = b.stream(imageDict({ width: 16, height: 16, colorSpace: `[/ICCBased ${profile} 0 R]`, filter: '/FlateDecode' }), flate(icc.data));
  const fn = b.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>');
  n.sep = b.stream(imageDict({ width: 20, height: 10, colorSpace: `[/Separation /Spot#201 /DeviceCMYK ${fn} 0 R]` }), gray.data);
  n.inverted = b.stream(imageDict({ width: 20, height: 10, colorSpace: '/DeviceGray', extra: '/Decode [1 0]' }), gray.data);
  n.deep = b.stream(imageDict({ width: 24, height: 16, colorSpace: '/DeviceRGB', bpc: 16, filter: '/FlateDecode' }), flate(to16Bit(rgb2)));
  n.tiff = b.stream(imageDict({ width: 24, height: 16, colorSpace: '/DeviceRGB', filter: '/FlateDecode', decodeParms: '<< /Predictor 2 /Colors 3 /Columns 24 >>' }), flate(tiffPredict(rgb2)));
  b.page({
    content: '/Pattern cs /P scn 0 0 100 100 re f /X Do /C Do /I Do /S Do /V Do /D Do /T Do',
    xobjects: { X: n.indexed, C: n.cmyk, I: n.icc, S: n.sep, V: n.inverted, D: n.deep, T: n.tiff },
    resources: ` /Pattern << /P ${pattern} 0 R >>`,
    extra: ` /Annots [${annot} 0 R]`,
  });
  b.page({ content: '' });
  // An image nobody uses.
  n.unused = b.stream(imageDict({ width: 1, height: 1, colorSpace: '/DeviceGray' }), new Uint8Array(1));
  return { bytes: b.finish().build().bytes, n };
}

function expected(f: Fixture): ImageInfo[] {
  const { n } = f;
  const base = { imageMask: false, hasSoftMask: false, bitsPerComponent: 8 };
  return [
    { ...base, num: n.jpeg, pages: [0, 1], width: 64, height: 48, colorSpace: 'DeviceRGB', filters: ['DCTDecode'], encodedBytes: JPEG_RGB.length },
    { ...base, num: n.png, pages: [0], width: 40, height: 30, colorSpace: 'DeviceRGB', filters: ['FlateDecode'], encodedBytes: flate(pngPredict(rgb, 'cycle').data).length, hasSoftMask: true },
    { ...base, num: n.gray, pages: [1], width: 20, height: 10, colorSpace: 'DeviceGray', filters: [], encodedBytes: 200 },
    { ...base, num: n.indexed, pages: [2], width: 24, height: 16, colorSpace: 'Indexed(DeviceRGB)', filters: ['FlateDecode'], encodedBytes: flate(toIndexed(rgb2).data).length },
    { ...base, num: n.cmyk, pages: [2], width: 8, height: 8, colorSpace: 'DeviceCMYK', filters: [], encodedBytes: 256 },
    { ...base, num: n.icc, pages: [2], width: 16, height: 16, colorSpace: 'ICCBased(RGB)', filters: ['FlateDecode'], encodedBytes: flate(icc.data).length },
    { ...base, num: n.sep, pages: [2], width: 20, height: 10, colorSpace: 'Separation(Spot 1)', filters: [], encodedBytes: 200 },
    { ...base, num: n.inverted, pages: [2], width: 20, height: 10, colorSpace: 'DeviceGray', filters: [], encodedBytes: 200 },
    { ...base, num: n.deep, pages: [2], width: 24, height: 16, colorSpace: 'DeviceRGB', filters: ['FlateDecode'], encodedBytes: flate(to16Bit(rgb2)).length, bitsPerComponent: 16 },
    { ...base, num: n.tiff, pages: [2], width: 24, height: 16, colorSpace: 'DeviceRGB', filters: ['FlateDecode'], encodedBytes: flate(tiffPredict(rgb2)).length },
    { ...base, num: n.flateDct, pages: [2], width: 32, height: 32, colorSpace: 'DeviceGray', filters: ['FlateDecode', 'DCTDecode'], encodedBytes: flate(JPEG_GRAY).length },
    { num: n.mask, pages: [2], width: 32, height: 32, bitsPerComponent: 1, filters: [], encodedBytes: bitmap(32, 32).length, imageMask: true, hasSoftMask: false },
  ];
}

describe('listImages', () => {
  test('page resources, nested forms (with a cycle), patterns and annotation appearances', async () => {
    const f = imagesDoc();
    expect(await listImages(await open(f.bytes))).toEqual(expected(f));
  });

  test('object streams and a damaged xref', async () => {
    const f = imagesDoc();
    const variants = [damage.startxref(f.bytes, 5)];
    for (const v of variants) expect(await listImages(await open(v))).toEqual(expected(f));
    if (!hasQpdf) return;
    // qpdf renumbers objects and sorts dictionary keys: compare everything but the numbers.
    const q = qpdfTransform(f.bytes, ['--object-streams=generate', '--compress-streams=n', '--decode-level=none']);
    const strip = (l: ImageInfo[]) => l.map(({ num: _, ...r }) => JSON.stringify(r, Object.keys(r).sort())).sort();
    const got = await listImages(await open(q));
    expect(strip(got)).toEqual(strip(expected(f)));
    const doc = await open(q);
    const j = await extractImage(doc, got.find((i) => i.width === 64)!.num);
    expect(j?.kind === 'jpeg' && bytesEqual(j.data, JPEG_RGB)).toBe(true);
  });

  test('dimensions and masks agree with mupdf', async () => {
    const f = imagesDoc();
    const m = mu(f.bytes);
    for (const i of await listImages(await open(f.bytes))) {
      const img = m.loadImage(m.newIndirect(i.num));
      expect([img.getWidth(), img.getHeight(), img.getImageMask()]).toEqual([i.width, i.height, i.imageMask]);
      expect(!!img.getMask()).toBe(i.hasSoftMask);
      img.destroy();
    }
    m.destroy();
  });

  test('damaged copies settle with a result or an Error', async () => {
    const n = await survives(imagesDoc().bytes, 5, async (doc) => {
      for (const i of await listImages(doc)) await extractImage(doc, i.num);
    });
    expect(n).toBeGreaterThan(20);
  });

  test('encrypted documents are rejected', async () => {
    if (!hasQpdf) return;
    const enc = await open(qpdfTransform(imagesDoc().bytes, ['--encrypt', '', 'o', '256', '--']));
    expect(listImages(enc)).rejects.toBeInstanceOf(PdfEncryptedError);
    expect(extractImage(enc, 5)).rejects.toBeInstanceOf(PdfEncryptedError);
  });
});

describe('extractImage', () => {
  test('JPEG data as stored, Flate-wrapped JPEG inflated', async () => {
    const f = imagesDoc();
    const doc = await open(f.bytes);
    expect(await extractImage(doc, f.n.jpeg)).toEqual({ kind: 'jpeg', data: JPEG_RGB });
    expect(await extractImage(doc, f.n.flateDct)).toEqual({ kind: 'jpeg', data: JPEG_GRAY });
  });

  test('8-bit gray and RGB samples: raw, PNG and TIFF predictors, ICC; same as mupdf', async () => {
    const f = imagesDoc();
    const doc = await open(f.bytes);
    const m = mu(f.bytes);
    const cases: [number, Pixels][] = [[f.n.png, rgb], [f.n.gray, gray], [f.n.icc, icc], [f.n.tiff, rgb2], [f.n.smask, photo(40, 30, 9, 1)]];
    for (const [num, px] of cases) {
      const got = await extractImage(doc, num);
      expect(got).toEqual({ kind: 'pixels', data: px.data, width: px.width, height: px.height, components: px.comps as 1 | 3 });
      const pix = m.loadImage(m.newIndirect(num)).toPixmap();
      expect(pix.getNumberOfComponents()).toBe(px.comps);
      const stride = pix.getStride();
      const all = pix.getPixels();
      const rows = new Uint8Array(px.data.length);
      const rowLen = px.width * px.comps;
      for (let y = 0; y < px.height; y++) rows.set(all.subarray(y * stride, y * stride + rowLen), y * rowLen);
      if (num !== f.n.icc) expect(bytesEqual(rows, px.data)).toBe(true); // mupdf color-manages ICC images
      pix.destroy();
    }
    m.destroy();
  });

  test('null for what it cannot produce', async () => {
    const f = imagesDoc();
    const doc = await open(f.bytes);
    for (const k of ['mask', 'indexed', 'cmyk', 'sep', 'inverted', 'deep']) expect(await extractImage(doc, f.n[k])).toBeNull();
    expect(await extractImage(doc, 1)).toBeNull(); // the catalog
    expect(await extractImage(doc, 99999)).toBeNull();
  });

  test('damaged image data', async () => {
    const b = new DocBuilder();
    const bad = b.stream(imageDict({ width: 40, height: 30, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), flate(rgb.data).subarray(0, 500));
    const short = b.stream(imageDict({ width: 40, height: 30, colorSpace: '/DeviceRGB' }), rgb.data.subarray(0, 100));
    const notJpeg = b.stream(imageDict({ width: 4, height: 4, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), latin1('garbage'));
    const huge = b.stream(imageDict({ width: 1e6, height: 1e6, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), flate(rgb.data));
    b.page({ content: '', xobjects: { A: bad, B: short, C: notJpeg, D: huge } });
    const doc = await open(b.finish().build().bytes);
    for (const n of [bad, short, notJpeg, huge]) expect(await extractImage(doc, n)).toBeNull();
    expect((await listImages(doc)).map((i) => i.num)).toEqual([bad, short, notJpeg, huge]);
  });
});
