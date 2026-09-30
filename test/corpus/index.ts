/**
 * The end-to-end corpus, generated in TypeScript at test time and cached under test/.corpus/
 * (keyed by a hash of the generator sources, so edits invalidate the cache).
 *
 * Each fixture states what the compressor should do with it; test/e2e.test.ts checks that.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompressOptions } from '../../src/core/types.ts';
import {
  bytes, damage, DocBuilder, drawImage, drawText, flate, imageDict, paragraph, vectorArt, type BuildOptions, type BuiltPdf,
} from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import {
  alphaRamp, bitmap, flat, grayProfile, jpeg, photo, pngPredict, scan, srgbProfile, tiffPredict, to16Bit, toIndexed,
  withAdobeMarker, withSofMarker, type JpegOptions, type Pixels,
} from './images.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(HERE, '..', '.corpus');

export interface Expect {
  /** Exact number of images recompressed. */
  recompressed: number;
  /** Exact skip-reason counts (missing = none). */
  skipped?: Record<string, number>;
  /** report.xrefRepaired; undefined = don't care. */
  repaired?: boolean;
  signed?: boolean;
  /** compressPdf must reject with PdfEncryptedError. */
  encrypted?: boolean;
  /** Intentionally damaged: qpdf may complain about the input; the output must be no worse. */
  damaged?: boolean;
  /** 0-based pages that contain no recompressible image and must render pixel-identically. */
  staticPages?: number[];
  /** Number of source objects the compressor drops (old xref streams, linearization dict). */
  dropped?: number;
}

export interface Fixture {
  name: string;
  about: string;
  /** Generation needs the qpdf binary. */
  needsQpdf?: boolean;
  options?: Partial<Omit<CompressOptions, 'codec'>>;
  expect: Expect;
  build(): Promise<Uint8Array>;
  /**
   * The same document without the damage, for fixtures mupdf cannot render faithfully: the
   * output is compared against this instead of the input.
   */
  renderReference?(): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------
// Image helpers

const csOf = (comps: number): string => (comps === 1 ? '/DeviceGray' : comps === 3 ? '/DeviceRGB' : '/DeviceCMYK');

interface ImgOpts {
  colorSpace?: string;
  extra?: string;
  length?: number | 'indirect';
}

async function addJpeg(b: DocBuilder, p: Pixels, o: JpegOptions & ImgOpts & { data?: Uint8Array; parms?: string } = {}): Promise<number> {
  const data = o.data ?? (await jpeg(p, o));
  const spec = { width: p.width, height: p.height, colorSpace: o.colorSpace ?? csOf(o.cmyk ? 4 : p.comps), filter: '/DCTDecode', decodeParms: o.parms, extra: o.extra };
  return b.stream(imageDict(spec), data, { length: o.length });
}

type PngMode = Parameters<typeof pngPredict>[1];

function addFlate(b: DocBuilder, p: Pixels, o: ImgOpts & { predictor?: number; mode?: PngMode; bpc?: number; data?: Uint8Array } = {}): number {
  const pred = o.predictor ?? 1;
  let raw = o.data ?? p.data;
  let parms: string | undefined;
  if (pred >= 10) {
    raw = pngPredict(p, o.mode ?? 'best').data;
    parms = `<< /Predictor ${pred} /Colors ${p.comps} /BitsPerComponent 8 /Columns ${p.width} >>`;
  } else if (pred === 2) {
    raw = tiffPredict(p);
    parms = `<< /Predictor 2 /Colors ${p.comps} /BitsPerComponent 8 /Columns ${p.width} >>`;
  }
  const spec = { width: p.width, height: p.height, colorSpace: o.colorSpace ?? csOf(p.comps), bpc: o.bpc, filter: '/FlateDecode', decodeParms: parms, extra: o.extra };
  return b.stream(imageDict(spec), flate(raw), { length: o.length });
}

function addRaw(b: DocBuilder, p: Pixels, o: ImgOpts = {}): number {
  return b.stream(imageDict({ width: p.width, height: p.height, colorSpace: o.colorSpace ?? csOf(p.comps), extra: o.extra }), p.data, { length: o.length });
}

/** Lay images out on one A4 page in a grid, with a caption per image. Returns the page number. */
function gridPage(b: DocBuilder, title: string, images: { num: number; w: number; h: number; label?: string }[], cols = 2): number {
  const xo: Record<string, number> = {};
  let content = drawText(title, 40, 800, 16);
  const cellW = 515 / cols;
  const rows = Math.ceil(images.length / cols);
  const cellH = 720 / Math.max(rows, 1);
  images.forEach((im, i) => {
    const name = `Im${i}`;
    xo[name] = im.num;
    const scale = Math.min((cellW - 10) / im.w, (cellH - 24) / im.h);
    const x = 40 + (i % cols) * cellW;
    const y = 780 - (Math.floor(i / cols) + 1) * cellH + 16;
    content += drawImage(name, x, y, im.w * scale, im.h * scale);
    content += drawText(im.label ?? name, x, y - 12, 8);
  });
  return b.page({ content, xobjects: xo });
}

function textPage(b: DocBuilder, title: string, seed: number): number {
  return b.page({ content: drawText(title, 40, 800, 18) + paragraph(40, 760, 30, 10, seed) + vectorArt(60, 60, 470, 200, seed) });
}

// ---------------------------------------------------------------------------------------------
// Document recipes shared by several fixtures

/** A few RGB and gray photos plus text and vector pages; last page has no images. */
async function brochure(seed: number, scale = 1, opts: { lengthRef?: boolean } = {}): Promise<DocBuilder> {
  const b = new DocBuilder();
  const s = (v: number): number => Math.round(v * scale);
  const len = opts.lengthRef ? ('indirect' as const) : undefined;
  const hero = photo(s(2000), s(1333), seed + 1);
  const a = photo(s(1200), s(900), seed + 2);
  const g = photo(s(900), s(1200), seed + 3, 1);
  const heroN = await addJpeg(b, hero, { quality: 92, length: len });
  const aN = await addJpeg(b, a, { quality: 95 });
  const gN = await addJpeg(b, g, { quality: 90 });
  b.page({
    content:
      drawText('Brochure: summer collection', 40, 800, 22, '0.1 0.2 0.5') +
      drawImage('Hero', 40, 420, 515, 343) +
      paragraph(40, 400, 18, 10, seed) +
      vectorArt(40, 60, 515, 90, seed),
    xobjects: { Hero: heroN },
  }, { length: len });
  b.page({
    content: drawText('Details', 40, 800, 18) + drawImage('A', 40, 440, 300, 225) + drawImage('G', 360, 420, 190, 253) + paragraph(40, 400, 25, 10, seed + 1),
    xobjects: { A: aN, G: gN },
  });
  textPage(b, 'Contact and prices', seed + 2);
  b.obj(`<< /Title (Brochure ${seed}) /Producer (pdfgen) >>`);
  return b;
}

function built(b: DocBuilder, name: string, o: BuildOptions = {}): Uint8Array {
  b.finish(name);
  return b.build(o).bytes;
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const JPX_FIXTURE = join(HERE, 'fixtures', 'gradient.jp2');

const SKIP_ENCODINGS: Expect = {
  recompressed: 0,
  skipped: {
    bitsPerComponent: 1, decode: 1, colorKeyMask: 1, jpx: 1, jbig2: 1, ccitt: 1, imageMask: 1, small: 1,
    jpegTransform: 2, jpegUnsupported: 1, noGain: 1, filter: 1, predictor: 1,
  },
  staticPages: [0, 1, 2],
  // qpdf warns about the lossless (SOF3) JPEG it cannot decode.
  damaged: true,
};

export const fixtures: Fixture[] = [
  {
    name: 'scan-gray-flate',
    about: 'Scanned pages: large grayscale Flate images (~200 dpi A4), PNG predictors, plus a text page',
    expect: { recompressed: 3, staticPages: [3] },
    async build() {
      const b = new DocBuilder();
      const imgs = [
        addFlate(b, scan(1700, 2400, 11), { predictor: 15, mode: 'best' }),
        addFlate(b, scan(1700, 2400, 12), { predictor: 12, mode: 2 }),
        addFlate(b, scan(1240, 1754, 13)),
      ];
      for (const im of imgs) b.page({ content: drawImage('Scan', 0, 0, 595, 842), xobjects: { Scan: im } });
      textPage(b, 'OCR notes', 3);
      return built(b, 'scan');
    },
  },
  {
    name: 'brochure-photos',
    about: 'Photo-heavy brochure: large RGB and gray DCT images, text, vector art, indirect /Length',
    expect: { recompressed: 3, staticPages: [2] },
    async build() {
      return built(await brochure(100, 1, { lengthRef: true }), 'brochure');
    },
  },
  {
    name: 'xref-stream-objstm',
    about: 'Brochure with a cross-reference stream and object streams',
    expect: { recompressed: 3, staticPages: [2], dropped: 1 },
    async build() {
      return built(await brochure(200, 0.5), 'xrefstm', { xref: 'stream', objStm: true, version: '1.5' });
    },
  },
  {
    name: 'hybrid',
    about: 'Hybrid file: classic table plus /XRefStm pointing at an xref stream for object-stream members',
    expect: { recompressed: 3, staticPages: [2], dropped: 1 },
    async build() {
      return built(await brochure(300, 0.5), 'hybrid', { xref: 'hybrid', objStm: true, version: '1.5' });
    },
  },
  {
    name: 'hybrid-free-entries',
    about: 'Hybrid file whose table lists the object-stream members as free entries (/XRefStm must win)',
    // mupdf lets the free table entries win and finds no pages; compare with the plain hybrid.
    expect: { recompressed: 3, staticPages: [2], dropped: 1 },
    async build() {
      return built(await brochure(300, 0.5), 'hybrid', { xref: 'hybrid', objStm: true, version: '1.5', hybridFreeEntries: true });
    },
    async renderReference() {
      return fixtureBytes(byName('hybrid'));
    },
  },
  {
    name: 'incremental-replace',
    about: 'Incremental update replacing an image object and the document info',
    expect: { recompressed: 2, staticPages: [2] },
    async build() {
      const b = new DocBuilder();
      const img = await addJpeg(b, photo(1000, 750, 401), { quality: 92 });
      const gray = addFlate(b, photo(800, 600, 402, 1), { predictor: 11, mode: 1 });
      gridPage(b, 'Original image', [{ num: img, w: 1000, h: 750 }], 1);
      gridPage(b, 'Gray', [{ num: gray, w: 800, h: 600 }], 1);
      textPage(b, 'Unchanged text', 4);
      const info = b.obj('<< /Title (v1) >>');
      b.trailer('Info', `${info} 0 R`);
      b.finish('incr-replace');
      b.update();
      const p = photo(1100, 700, 403);
      b.setStream(img, imageDict({ width: p.width, height: p.height, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), await jpeg(p, { quality: 93 }));
      b.setObj(info, '<< /Title (v2) /ModDate (D:20260101000000Z) >>');
      return b.build({ xref: 'table' }).bytes;
    },
  },
  {
    name: 'incremental-delete',
    about: 'Three sections (table, xref stream with object stream, xref stream): an image deleted, a page rewritten',
    expect: { recompressed: 2, staticPages: [1], dropped: 2 },
    async build() {
      const b = new DocBuilder();
      const keep = await addJpeg(b, photo(900, 600, 501), { quality: 92 });
      const gone = await addJpeg(b, photo(900, 600, 502), { quality: 92 });
      const p0 = gridPage(b, 'Two images', [{ num: keep, w: 900, h: 600 }, { num: gone, w: 900, h: 600 }], 1);
      textPage(b, 'Static', 5);
      b.finish('incr-delete');
      b.update();
      const content = b.stream('', bytes(drawText('One image left', 40, 800, 16) + drawImage('Im0', 40, 300, 450, 300)));
      b.setObj(p0, b.pageDict({ content: '', xobjects: { Im0: keep } }, content));
      b.free(gone, 1);
      b.update();
      const late = addFlate(b, photo(700, 500, 503), { predictor: 14, mode: 4 });
      const p2 = b.obj(b.pageDict({ content: '', xobjects: { L: late } }, b.stream('', bytes(drawImage('L', 40, 400, 350, 250)))));
      b.pages.push(p2);
      b.setObj(b.pagesNum, b.pagesDict());
      return b.build({ xref: ['table', 'stream', 'stream'], objStm: [false, true, false], version: '1.5' }).bytes;
    },
  },
  {
    name: 'incremental-objstm',
    about: 'Xref streams in both sections; the update redefines objects that lived in an object stream',
    expect: { recompressed: 2, staticPages: [1], dropped: 2 },
    async build() {
      const b = new DocBuilder();
      const img = addFlate(b, photo(800, 600, 601), { predictor: 15 });
      const p0 = gridPage(b, 'Before', [{ num: img, w: 800, h: 600 }], 1);
      textPage(b, 'Static', 6);
      b.finish('incr-objstm');
      b.update();
      const img2 = await addJpeg(b, photo(900, 650, 602), { quality: 94 });
      b.setObj(p0, b.pageDict({ content: '', xobjects: { Im0: img, Im1: img2 } }, b.stream('', bytes(drawImage('Im0', 40, 450, 400, 300) + drawImage('Im1', 40, 60, 400, 290)))));
      b.setObj(b.catalog, `<< /Type /Catalog /Pages ${b.pagesNum} 0 R /PageMode /UseNone >>`);
      return b.build({ xref: 'stream', objStm: true, version: '1.5' }).bytes;
    },
  },
  {
    name: 'broken-offsets',
    about: 'Classic table with several wrong offsets (catalog, image, content, font)',
    expect: { recompressed: 3, staticPages: [2], repaired: true, damaged: true },
    async build() {
      const b = await brochure(700, 0.5);
      b.finish('broken');
      return b.build({ badOffsets: { [b.catalog]: 3, 4: 117, 7: -5, [b.font]: 1 } }).bytes;
    },
  },
  {
    name: 'junk-before-header',
    about: '700 bytes of junk before %PDF-; offsets are relative to the header',
    expect: { recompressed: 3, staticPages: [2] },
    async build() {
      const junk = 'X-Mailer: something\r\nContent-Type: application/pdf\r\n\r\n' + 'j'.repeat(640) + '\n';
      return damage.prefix(built(await brochure(800, 0.5), 'junk'), junk);
    },
  },
  {
    name: 'wrong-length',
    about: 'Streams whose /Length is too long, too short or missing an endstream at /Length',
    expect: { recompressed: 2, staticPages: [1], damaged: true },
    async build() {
      const b = new DocBuilder();
      const p1 = photo(700, 500, 901);
      const long = b.stream(imageDict({ width: 700, height: 500, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), flate(p1.data), { length: 100 });
      const j = await jpeg(photo(800, 600, 902), { quality: 92 });
      const short = b.stream(imageDict({ width: 800, height: 600, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), j, { length: j.length + 5000 });
      gridPage(b, 'Wrong lengths', [{ num: long, w: 700, h: 500 }, { num: short, w: 800, h: 600 }], 1);
      b.page({ content: drawText('Content stream with a bad length', 40, 800, 14) + vectorArt(40, 300, 500, 300, 9) }, { length: 7 });
      return built(b, 'wrong-length');
    },
  },
  {
    name: 'missing-endobj',
    about: 'Objects without endobj, a stream without endstream',
    expect: { recompressed: 1, staticPages: [1], damaged: true },
    async build() {
      const b = new DocBuilder();
      const img = b.stream(imageDict({ width: 700, height: 500, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), await jpeg(photo(700, 500, 1001), { quality: 94 }), { noEndobj: true });
      gridPage(b, 'Image without endobj', [{ num: img, w: 700, h: 500 }], 1);
      textPage(b, 'Plain page', 10);
      // Unreferenced, so renderers never have to guess where its data ends.
      b.stream('/Type /Metadata /Subtype /XML', bytes('<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>'), { noEndstream: true });
      b.obj('<< /Title (no endobj) >>', { noEndobj: true });
      return built(b, 'missing-endobj');
    },
  },
  {
    name: 'truncated-xref',
    about: 'File cut in the middle of its xref table: trailer, startxref and %%EOF lost',
    expect: { recompressed: 3, staticPages: [2], repaired: true, damaged: true },
    async build() {
      const b = await brochure(1100, 0.5);
      b.finish('trunc-xref');
      const r = b.build();
      return damage.truncate(r.bytes, r.xrefOffsets[0] + 60);
    },
  },
  {
    name: 'truncated-object',
    about: 'File cut inside the data of its last object (an image): no xref at all',
    expect: { recompressed: 1, repaired: true, damaged: true, staticPages: [2] },
    async build() {
      const b = new DocBuilder();
      const ok = await addJpeg(b, photo(800, 600, 1201), { quality: 93 });
      const lastPage = b.alloc();
      gridPage(b, 'Complete image', [{ num: ok, w: 800, h: 600 }], 1);
      textPage(b, 'Text', 12);
      b.pages.splice(1, 0, lastPage);
      b.finish('trunc-obj');
      const cut = b.alloc();
      b.setObj(lastPage, b.pageDict({ content: '', xobjects: { T: cut } }, b.stream('', bytes(drawImage('T', 40, 300, 400, 300)))));
      b.setStream(cut, imageDict({ width: 600, height: 450, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), flate(photo(600, 450, 1202).data));
      const r = b.build();
      const at = r.objects.get(cut)!.offset;
      return damage.truncate(r.bytes, at + 40000);
    },
  },
  {
    name: 'garbage-after-eof',
    about: 'Two KB of garbage after the final %%EOF',
    expect: { recompressed: 3, staticPages: [2], damaged: true /* qpdf only looks for startxref in the last KB */ },
    async build() {
      const r = new Rng(1300);
      const junk = Array.from({ length: 2000 }, () => String.fromCharCode(r.int(32, 126))).join('');
      return damage.suffix(built(await brochure(1300, 0.5), 'garbage'), '\n' + junk.replace(/startxref|%%EOF|obj|trailer|xref/g, '....'));
    },
  },
  {
    name: 'xref-off-by-one',
    about: 'First xref subsection numbered "1 N" while listing object 0 first',
    expect: { recompressed: 3, staticPages: [2], damaged: true /* qpdf rejects the "1 N" numbering */ },
    async build() {
      return built(await brochure(1400, 0.5), 'offbyone', { offByOne: true, xrefEol: ' \n' });
    },
    // mupdf cannot make sense of the off-by-one table.
    async renderReference() {
      return built(await brochure(1400, 0.5), 'offbyone');
    },
  },
  {
    name: 'png-filters',
    about: 'Flate images with PNG predictors 10-15, one filter type per image, cycling and adaptive rows, identity /Decode',
    expect: { recompressed: 8 },
    async build() {
      const b = new DocBuilder();
      const imgs: { num: number; w: number; h: number; label: string }[] = [];
      const modes: [number, PngMode][] = [[10, 0], [11, 1], [12, 2], [13, 3], [14, 4], [15, 'best']];
      for (const [pred, mode] of modes) {
        const p = photo(640, 480, 1500 + pred);
        imgs.push({ num: addFlate(b, p, { predictor: pred, mode }), w: 640, h: 480, label: `Predictor ${pred} filter ${mode}` });
      }
      const g = photo(640, 480, 1520, 1);
      imgs.push({ num: addFlate(b, g, { predictor: 15, mode: 'cycle' }), w: 640, h: 480, label: 'gray cycle' });
      const g2 = photo(640, 480, 1521, 1);
      imgs.push({ num: addFlate(b, g2, { predictor: 15, mode: 'best', extra: '/Decode [0 1]' }), w: 640, h: 480, label: 'gray identity decode' });
      gridPage(b, 'PNG predictors (1)', imgs.slice(0, 4));
      gridPage(b, 'PNG predictors (2)', imgs.slice(4));
      return built(b, 'png-filters');
    },
  },
  {
    name: 'tiff-predictor',
    about: 'Flate images with TIFF predictor 2, RGB and gray',
    expect: { recompressed: 2 },
    async build() {
      const b = new DocBuilder();
      const rgb = addFlate(b, photo(800, 600, 1601), { predictor: 2 });
      const gray = addFlate(b, photo(800, 600, 1602, 1), { predictor: 2 });
      gridPage(b, 'TIFF predictor', [{ num: rgb, w: 800, h: 600 }, { num: gray, w: 800, h: 600 }], 1);
      return built(b, 'tiff');
    },
  },
  {
    name: 'uncompressed-and-chains',
    about: 'Uncompressed RGB and gray images and a [/FlateDecode /DCTDecode] image',
    expect: { recompressed: 3 },
    async build() {
      const b = new DocBuilder();
      const rgb = addRaw(b, photo(500, 400, 1701));
      const gray = addRaw(b, photo(500, 400, 1702, 1));
      const j = await jpeg(photo(900, 700, 1703), { quality: 96 });
      const chain = b.stream(imageDict({ width: 900, height: 700, colorSpace: '/DeviceRGB', filter: '[/FlateDecode /DCTDecode]' }), flate(j));
      gridPage(b, 'Raw and chained', [{ num: rgb, w: 500, h: 400 }, { num: gray, w: 500, h: 400 }, { num: chain, w: 900, h: 700 }]);
      return built(b, 'raw');
    },
  },
  {
    name: 'grayscale',
    about: 'Grayscale DCT (larger than the default max size) and gray Flate images',
    expect: { recompressed: 2 },
    async build() {
      const b = new DocBuilder();
      const dct = await addJpeg(b, photo(2200, 1500, 1801, 1), { quality: 92 });
      const fl = addFlate(b, photo(900, 700, 1802, 1), { predictor: 11, mode: 1 });
      gridPage(b, 'Gray', [{ num: dct, w: 2200, h: 1500 }, { num: fl, w: 900, h: 700 }], 1);
      return built(b, 'gray');
    },
  },
  {
    name: 'soft-masks',
    about: 'An image with an SMask, an image whose SMask has /Matte, and the masks themselves',
    // The small mask fits the box and stays; the pre-blended image and its /Matte mask stay together.
    expect: { recompressed: 1, skipped: { softMask: 1, matte: 2 } },
    async build() {
      const b = new DocBuilder();
      const m1 = addFlate(b, alphaRamp(800, 600, 1901));
      const withMask = await addJpeg(b, photo(800, 600, 1902), { quality: 93, extra: `/SMask ${m1} 0 R` });
      const alpha = alphaRamp(700, 500, 1903);
      const m2 = b.stream(imageDict({ width: 700, height: 500, colorSpace: '/DeviceGray', filter: '/FlateDecode', extra: '/Matte [0 0 0]' }), flate(alpha.data));
      // Pre-multiplied colour for the matte image.
      const pm = photo(700, 500, 1904);
      for (let i = 0; i < 700 * 500; i++) for (let k = 0; k < 3; k++) pm.data[3 * i + k] = Math.round((pm.data[3 * i + k] * alpha.data[i]) / 255);
      const matte = addFlate(b, pm, { predictor: 15, extra: `/SMask ${m2} 0 R` });
      b.page({
        content: drawText('Soft masks', 40, 800, 16) + '0.9 0.2 0.2 rg 40 380 515 400 re f\n' + drawImage('A', 60, 420, 480, 360) + drawImage('B', 60, 40, 420, 300),
        xobjects: { A: withMask, B: matte },
      });
      return built(b, 'smask');
    },
  },
  {
    name: 'soft-masks-shrunk',
    about: 'A large photo with a large alpha mask: both shrink to the same box (the mask losslessly, as Flate)',
    expect: { recompressed: 2, skipped: {} },
    async build() {
      const b = new DocBuilder();
      const mask = addFlate(b, alphaRamp(2400, 1800, 1911), { predictor: 12 });
      const img = await addJpeg(b, photo(2400, 1800, 1912), { quality: 93, extra: `/SMask ${mask} 0 R` });
      b.page({
        content: drawText('Shrunk soft mask', 40, 800, 16) + '0.2 0.4 0.9 rg 40 380 515 400 re f\n' + drawImage('A', 60, 420, 480, 360),
        xobjects: { A: img },
      });
      return built(b, 'smask-shrunk');
    },
  },
  {
    name: 'skip-colorspaces',
    about: 'CMYK (JPEG and Flate), Indexed, Separation, DeviceN, Lab, CalRGB and missing colour spaces',
    expect: { recompressed: 0, skipped: { cmyk: 2, indexed: 1, separation: 1, deviceN: 1, lab: 1, colorSpace: 1, noColorSpace: 1 }, staticPages: [0, 1] },
    async build() {
      const b = new DocBuilder();
      const p = photo(600, 400, 2001);
      const g = photo(600, 400, 2002, 1);
      const cmykJ = await addJpeg(b, p, { cmyk: true, quality: 92 });
      const cmykPx: Pixels = { width: 600, height: 400, comps: 4, data: new Uint8Array(600 * 400 * 4) };
      for (let i = 0; i < 600 * 400; i++) for (let k = 0; k < 3; k++) cmykPx.data[4 * i + k] = 255 - p.data[3 * i + k];
      const cmykF = addFlate(b, cmykPx);
      const idx = toIndexed(p);
      const hex = Array.from(idx.palette, (v) => v.toString(16).padStart(2, '0')).join('');
      const indexed = addFlate(b, { ...p, comps: 1, data: idx.data }, { colorSpace: `[/Indexed /DeviceRGB 215 <${hex}>]` });
      const tint = b.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.6 1 0] /N 1 >>');
      const sep = addFlate(b, g, { colorSpace: `[/Separation /Spot /DeviceCMYK ${tint} 0 R]` });
      const fn = b.stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1 0 1]', bytes('{ 0 0 }'));
      const twoCh: Pixels = { width: 600, height: 400, comps: 1, data: new Uint8Array(600 * 400 * 2) };
      for (let i = 0; i < 600 * 400; i++) (twoCh.data[2 * i] = p.data[3 * i]), (twoCh.data[2 * i + 1] = p.data[3 * i + 1]);
      const devn = b.stream(imageDict({ width: 600, height: 400, colorSpace: `[/DeviceN [/Cyan /Magenta] /DeviceCMYK ${fn} 0 R]`, filter: '/FlateDecode' }), flate(twoCh.data));
      const lab = addFlate(b, p, { colorSpace: '[/Lab << /WhitePoint [0.9505 1 1.089] /Range [-100 100 -100 100] >>]' });
      const cal = addFlate(b, p, { colorSpace: '[/CalRGB << /WhitePoint [0.9505 1 1.089] >>]' });
      const none = b.stream(`/Type /XObject /Subtype /Image /Width 600 /Height 400 /BitsPerComponent 8 /Filter /FlateDecode`, flate(g.data));
      const L = (num: number, label: string) => ({ num, w: 600, h: 400, label });
      gridPage(b, 'Colour spaces (1)', [L(cmykJ, 'CMYK JPEG'), L(cmykF, 'CMYK Flate'), L(indexed, 'Indexed'), L(sep, 'Separation')]);
      gridPage(b, 'Colour spaces (2)', [L(devn, 'DeviceN'), L(lab, 'Lab'), L(cal, 'CalRGB'), L(none, 'none')]);
      return built(b, 'skip-cs');
    },
  },
  {
    name: 'skip-encodings',
    about: '16-bit, /Decode [1 0], colour-key mask, JPX, JBIG2, CCITT, image mask, small, JPEG transforms, lossless JPEG, no gain, odd filters',
    expect: SKIP_ENCODINGS,
    async build() {
      const b = new DocBuilder();
      const p = photo(600, 400, 2101);
      const g = photo(600, 400, 2102, 1);
      const L = (num: number, label: string, w = 600, h = 400) => ({ num, w, h, label });
      const b16 = b.stream(imageDict({ width: 600, height: 400, colorSpace: '/DeviceRGB', bpc: 16, filter: '/FlateDecode' }), flate(to16Bit(p)));
      const inv = addFlate(b, g, { extra: '/Decode [1 0]' });
      const ck = addFlate(b, p, { extra: '/Mask [0 60 0 60 0 60]' });
      const jpx = b.stream(imageDict({ width: 96, height: 64, colorSpace: '/DeviceRGB', filter: '/JPXDecode' }), new Uint8Array(readFileSync(JPX_FIXTURE)));
      const jbig2 = b.stream(imageDict({ width: 64, height: 64, bpc: 1, colorSpace: '/DeviceGray', filter: '/JBIG2Decode' }), new Rng(7).bytes(300));
      const ccitt = b.stream(imageDict({ width: 64, height: 64, bpc: 1, colorSpace: '/DeviceGray', filter: '/CCITTFaxDecode', decodeParms: '<< /K -1 /Columns 64 >>' }), new Rng(8).bytes(300));
      const mask = b.stream(`/Type /XObject /Subtype /Image /Width 512 /Height 512 /ImageMask true /BitsPerComponent 1 /Filter /FlateDecode`, flate(bitmap(512, 512)));
      const small = await addJpeg(b, photo(120, 90, 2103), { quality: 80 });
      const ct0 = await addJpeg(b, p, { quality: 92, parms: '<< /ColorTransform 0 >>' });
      const adobe = await addJpeg(b, p, { quality: 92, data: withAdobeMarker(await jpeg(p, { quality: 92 }), 0) });
      const lossless = await addJpeg(b, p, { data: withSofMarker(await jpeg(p, { quality: 92 }), 0xc3) });
      const noGain = await addJpeg(b, photo(1400, 1000, 2104), { quality: 25 });
      const hexData = bytes(Buffer.from(g.data).toString('hex') + '>');
      const ahx = b.stream(imageDict({ width: 600, height: 400, colorSpace: '/DeviceGray', filter: '/ASCIIHexDecode' }), hexData);
      const badPred = b.stream(imageDict({ width: 600, height: 400, colorSpace: '/DeviceRGB', filter: '/FlateDecode', decodeParms: '<< /Predictor 15 /Colors 1 /Columns 600 >>' }), flate(pngPredict({ ...g }, 2).data));
      gridPage(b, 'Encodings (1)', [L(b16, '16-bit'), L(inv, 'Decode [1 0]'), L(ck, 'colour key'), L(jpx, 'JPX', 96, 64), L(jbig2, 'JBIG2', 64, 64), L(ccitt, 'CCITT', 64, 64)]);
      gridPage(b, 'Encodings (2)', [L(mask, 'image mask', 512, 512), L(small, 'small', 120, 90), L(ct0, 'ColorTransform 0'), L(adobe, 'Adobe transform 0')]);
      gridPage(b, 'Encodings (3)', [L(lossless, 'SOF3'), L(noGain, 'q25', 1400, 1000), L(ahx, 'ASCIIHex'), L(badPred, 'bad predictor')]);
      return built(b, 'skip-enc');
    },
  },
  {
    name: 'icc-based',
    about: 'ICCBased N=3 (sRGB profile) DCT and Flate images and an ICCBased N=1 gray Flate image',
    expect: { recompressed: 3 },
    async build() {
      const b = new DocBuilder();
      const rgbIcc = b.stream('/N 3 /Alternate /DeviceRGB /Filter /FlateDecode', flate(await srgbProfile()));
      const grayIcc = b.stream('/N 1 /Alternate /DeviceGray', grayProfile());
      const cs3 = `[/ICCBased ${rgbIcc} 0 R]`;
      const dct = await addJpeg(b, photo(900, 600, 2201), { quality: 93, colorSpace: cs3 });
      const fl = addFlate(b, photo(700, 500, 2202), { predictor: 15, colorSpace: cs3 });
      const gray = addFlate(b, photo(700, 500, 2203, 1), { predictor: 12, mode: 2, colorSpace: `[/ICCBased ${grayIcc} 0 R]` });
      gridPage(b, 'ICC based', [{ num: dct, w: 900, h: 600 }, { num: fl, w: 700, h: 500 }, { num: gray, w: 700, h: 500 }]);
      return built(b, 'icc');
    },
  },
  {
    name: 'text-only',
    about: 'No images at all; a gen-2 info object',
    expect: { recompressed: 0, staticPages: [0, 1] },
    async build() {
      const b = new DocBuilder();
      textPage(b, 'Plain text 1', 1);
      textPage(b, 'Plain text 2', 2);
      const info = b.alloc();
      b.setObj(info, '<< /Title (gen two) >>', { gen: 2 });
      b.trailer('Info', `${info} 2 R`);
      return built(b, 'text');
    },
  },
  {
    name: 'signed',
    about: 'A signature field with /ByteRange and a /Contents placeholder',
    expect: { recompressed: 3, signed: true, staticPages: [2] },
    async build() {
      const b = await brochure(2400, 0.5);
      const sig = b.obj(`<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 1000 3000 500] /Contents <${'0'.repeat(2048)}> /M (D:20260101000000Z) >>`, { compressible: false });
      const field = b.obj(`<< /FT /Sig /T (Signature1) /V ${sig} 0 R /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /F 132 >>`);
      b.catalogExtra = ` /AcroForm << /Fields [${field} 0 R] /SigFlags 3 >>`;
      return built(b, 'signed');
    },
  },
  {
    name: 'encrypted-handmade',
    about: 'Trailer with a hand-written /Encrypt dictionary',
    expect: { recompressed: 0, encrypted: true },
    async build() {
      const b = await brochure(2500, 0.25);
      const enc = b.obj(`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -44 >>`, { compressible: false });
      b.trailer('Encrypt', `${enc} 0 R`);
      return built(b, 'enc-hand');
    },
  },
  {
    name: 'encrypted-qpdf',
    about: 'AES-256 encrypted by qpdf',
    needsQpdf: true,
    expect: { recompressed: 0, encrypted: true },
    async build() {
      return qpdfTransform(built(await brochure(2600, 0.25), 'enc-qpdf'), ['--encrypt', 'user', 'owner', '256', '--']);
    },
  },
  {
    name: 'linearized',
    about: 'Brochure linearized by qpdf (classic tables, first-page xref, hint stream)',
    needsQpdf: true,
    expect: { recompressed: 3, staticPages: [2], dropped: 1 },
    async build() {
      return qpdfTransform(built(await brochure(2700, 0.5), 'lin'), ['--linearize']);
    },
  },
  {
    name: 'linearized-objstm',
    about: 'Brochure linearized by qpdf with generated object streams',
    needsQpdf: true,
    expect: { recompressed: 3, staticPages: [2], dropped: 3 },
    async build() {
      return qpdfTransform(built(await brochure(2800, 0.5), 'linobj'), ['--linearize', '--object-streams=generate']);
    },
  },
  {
    name: 'qpdf-objstreams-png',
    about: 'png-filters rewritten by qpdf --object-streams=generate',
    needsQpdf: true,
    expect: { recompressed: 8, dropped: 1 },
    async build() {
      return qpdfTransform(await fixtureBytes(byName('png-filters')), ['--object-streams=generate']);
    },
  },
  {
    name: 'qpdf-objstreams-skip',
    about: 'skip-encodings rewritten by qpdf --object-streams=generate',
    needsQpdf: true,
    // qpdf re-encodes the ASCIIHex image with Flate, which makes it recompressible.
    expect: { ...SKIP_ENCODINGS, recompressed: 1, skipped: (({ filter: _, ...rest }) => rest)(SKIP_ENCODINGS.skipped!), staticPages: [0, 1], dropped: 1 },
    async build() {
      return qpdfTransform(await fixtureBytes(byName('skip-encodings')), ['--object-streams=generate']);
    },
  },
  {
    name: 'qpdf-objstreams-incremental',
    about: 'incremental-delete flattened by qpdf with object streams',
    needsQpdf: true,
    expect: { recompressed: 2, staticPages: [1], dropped: 1 },
    async build() {
      return qpdfTransform(await fixtureBytes(byName('incremental-delete')), ['--object-streams=generate']);
    },
  },
];

function byName(name: string): Fixture {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Cache

let cacheKey: string | undefined;

/** Hash of the generator sources (and the JPEG encoder version): the cache directory name. */
function corpusKey(): string {
  if (cacheKey) return cacheKey;
  const h = createHash('sha256');
  const files = [join(HERE, '..', 'support', 'pdfgen.ts'), join(HERE, '..', 'support', 'prng.ts'), JPX_FIXTURE];
  for (const f of readdirSync(HERE).sort()) if (f.endsWith('.ts')) files.push(join(HERE, f));
  for (const f of files) h.update(readFileSync(f));
  h.update(process.versions.bun ?? process.version);
  return (cacheKey = h.digest('hex').slice(0, 16));
}

const inflight = new Map<string, Promise<Uint8Array>>();

/** Bytes of a fixture, generated on first use and cached on disk. */
export function fixtureBytes(f: Fixture): Promise<Uint8Array> {
  let p = inflight.get(f.name);
  if (!p) {
    p = (async () => {
      const dir = join(CORPUS_DIR, corpusKey());
      const path = join(dir, `${f.name}.pdf`);
      if (existsSync(path)) return new Uint8Array(readFileSync(path));
      if (f.needsQpdf && !hasQpdf) throw new Error(`fixture ${f.name} needs qpdf`);
      const data = await f.build();
      mkdirSync(dir, { recursive: true });
      // Drop corpora generated by older versions of the generators.
      for (const d of readdirSync(CORPUS_DIR)) if (d !== corpusKey()) rmSync(join(CORPUS_DIR, d), { recursive: true, force: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, path);
      return data;
    })();
    inflight.set(f.name, p);
  }
  return p;
}

/** Fixtures that can be generated in this environment. */
export function availableFixtures(): Fixture[] {
  return fixtures.filter((f) => !f.needsQpdf || hasQpdf);
}

export { byName as fixture };
