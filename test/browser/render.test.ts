/**
 * renderPage in headless Chromium, compared with MuPDF on generated pages: vector graphics, color
 * spaces, images, text in each font format, shadings, patterns, transparency, annotations and
 * page geometry. Thresholds allow for anti-aliasing and font rasterization differences; `bad` is
 * the fraction of pixels that differ structurally.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { synthesize } from '../contract/contract.ts';
import { bytes, DocBuilder, flate } from '../support/pdfgen.ts';
import { ccittEncode } from '../render/ccitt-encoder.ts';
import { compare, debugPng, pixel, startSession, theirs, type Session } from './render-support.ts';

let session: Session | undefined;
let skip = '';

beforeAll(async () => {
  const s = await startSession();
  if ('skip' in s) skip = s.skip;
  else session = s;
}, 60_000);

afterAll(async () => {
  await session?.close();
}, 20_000);

/** Render with both renderers and compare; returns our raster for spot checks. */
async function check(name: string, pdf: Uint8Array, limits: { mae: number; bad: number }, page = 0, scale = 1) {
  const ours = await session!.ours(pdf, page, { scale });
  const ref = theirs(pdf, page, scale);
  await debugPng(name, ours, ref);
  expect(Math.abs(ours.width - ref.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(ours.height - ref.height)).toBeLessThanOrEqual(1);
  const d = compare(ours, ref);
  if (d.mae > limits.mae || d.bad > limits.bad) console.log(name, d, ours.warnings);
  expect(d.mae).toBeLessThan(limits.mae);
  expect(d.bad).toBeLessThan(limits.bad);
  return ours;
}

const page = (content: string, resources = '', extra = '', size = { width: 600, height: 400 }) => {
  const b = new DocBuilder();
  b.page({ ...size, content, resources, extra });
  return b;
};

const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe.skipIf(!!skip)('renderPage vs MuPDF', () => {
  test('paths: fills, strokes, dashes, caps and joins, clipping, fill rules, curves', async () => {
    const content = [
      '0.8 0.1 0.1 rg 40 40 160 100 re f',
      '0 0 1 RG 10 w 1 J 1 j 40 200 m 120 330 l 200 200 l S',
      '0 0 0 RG 3 w 2 J 0 j 240 330 m 300 200 l 360 330 l S',
      '[12 6] 0 d 2 w 0.3 0.3 0.3 RG 40 370 m 560 370 l S [] 0 d',
      'q 240 40 120 120 re W n 0.1 0.6 0.1 rg 200 0 m 400 200 l 400 0 l f Q',
      '0.2 0.2 0.8 rg 420 40 m 480 180 l 390 90 l 560 90 l 460 180 l h f*',
      '0.5 g 400 240 m 440 330 500 330 540 240 c 500 200 440 200 400 240 c f',
      '1 0.5 0 rg 0 0 1 RG 4 w 420 260 60 40 re B',
    ].join('\n');
    const ours = await check('paths', page(content).finish().build().bytes, { mae: 2, bad: 0.004 });
    expect(near(pixel(ours, 100, 400 - 90), [204, 26, 26])).toBe(true);
  });

  test('color spaces, alpha and blend modes', async () => {
    const b = new DocBuilder();
    const tint = b.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.8 0.9 0] /N 1 >>');
    const res =
      ` /ColorSpace << /Sep [/Separation /Spot /DeviceCMYK ${tint} 0 R] /Lab [/Lab << /WhitePoint [0.9505 1 1.089] /Range [-100 100 -100 100] >>]` +
      ` /Idx [/Indexed /DeviceRGB 2 <FF000000FF000000FF>] >> /ExtGState << /Half << /ca 0.5 /CA 0.5 >> /Mul << /BM /Multiply >> >>`;
    const content = [
      '0 1 1 0 k 20 300 80 80 re f',
      '0 0 0 1 k 110 300 80 80 re f',
      '0.2 0.1 0 0.1 k 200 300 80 80 re f',
      '/Sep cs 1 scn 290 300 80 80 re f 0.5 scn 380 300 80 80 re f',
      '/Lab cs 50 60 40 scn 20 200 80 80 re f',
      '/Idx cs 1 scn 110 200 80 80 re f 2 scn 200 200 80 80 re f',
      '0 0 1 rg 290 200 120 80 re f q /Half gs 1 0 0 rg 350 170 120 80 re f Q',
      '1 1 0 rg 20 40 200 100 re f q /Mul gs 0 1 1 rg 120 60 200 100 re f Q',
    ].join('\n');
    b.page({ width: 600, height: 400, content, resources: res });
    const ours = await check('colors', b.finish().build().bytes, { mae: 6, bad: 0.02 });
    // Multiply of yellow and cyan is green.
    expect(near(pixel(ours, 170, 400 - 100), [0, 255, 0], 12)).toBe(true);
    // Half-transparent red over blue.
    expect(near(pixel(ours, 380, 400 - 230), [128, 0, 128], 12)).toBe(true);
  });

  test('images: RGB, gray, 1-bit, JPEG, stencil mask, soft mask, inline', async () => {
    const b = new DocBuilder();
    const rgb = synthesize({ width: 96, height: 64, components: 3, pattern: 'photo', seed: 3 });
    const gray = synthesize({ width: 64, height: 64, components: 1, pattern: 'photo', seed: 4 });
    const jpeg = await sharp(Buffer.from(rgb), { raw: { width: 96, height: 64, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const bits = new Uint8Array(8 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x >> 3) % 2 === (y >> 3) % 2) bits[y * 8 + (x >> 3)] |= 0x80 >> (x & 7);
    const alpha = new Uint8Array(96 * 64).map((_, i) => ((i % 96) * 255) / 95);
    const sm = b.stream('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', flate(alpha));
    const im = {
      A: b.stream('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', flate(rgb)),
      B: b.stream('/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', flate(gray)),
      C: b.stream('/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1', bits),
      D: b.stream('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', new Uint8Array(jpeg)),
      E: b.stream('/Type /XObject /Subtype /Image /Width 64 /Height 64 /ImageMask true', bits),
      F: b.stream(`/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask ${sm} 0 R`, flate(rgb)),
    };
    const content = [
      'q 144 0 0 96 20 280 cm /A Do Q',
      'q 96 0 0 96 180 280 cm /B Do Q',
      'q 96 0 0 96 290 280 cm /C Do Q',
      'q 144 0 0 96 400 280 cm /D Do Q',
      '0.9 0.2 0.2 rg q 96 0 0 96 20 150 cm /E Do Q',
      '0 0 1 rg 130 150 150 100 re f q 144 0 0 96 130 150 cm /F Do Q',
      'q 64 0 0 32 300 150 cm BI /W 4 /H 2 /CS /RGB /BPC 8 ID ' + '\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\x00'.repeat(2) + ' EI Q',
    ].join('\n');
    b.page({ width: 600, height: 400, content, xobjects: Object.fromEntries(Object.entries(im).map(([k, v]) => [k, v])) });
    const ours = await check('images', b.finish().build().bytes, { mae: 6, bad: 0.03 });
    // The stencil mask paints the fill color where its samples are 0.
    expect(near(pixel(ours, 20 + 4, 400 - 150 - 96 + 4), [230, 51, 51], 24) || near(pixel(ours, 20 + 16, 400 - 150 - 96 + 4), [230, 51, 51], 24)).toBe(true);
  });

  test('images: CMYK and YCCK JPEGs, as stored and Adobe-inverted, full size and reduced', async () => {
    const b = new DocBuilder();
    const jpg = (f: string) => new Uint8Array(readFileSync(new URL(`../render/fixtures/jpeg/${f}`, import.meta.url)));
    const dict = '/Type /XObject /Subtype /Image /Width 45 /Height 37 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode';
    const inverted = ' /Decode [1 0 1 0 1 0 1 0]';
    const im = {
      A: b.stream(dict, jpg('cmyk.jpg')),
      B: b.stream(dict + inverted, jpg('cmyk.jpg')),
      C: b.stream(dict + inverted, jpg('ycck.jpg')),
      D: b.stream(dict + inverted, jpg('cmyk-progressive-restart.jpg')),
    };
    const content = ['q 180 0 0 148 10 240 cm /A Do Q', 'q 180 0 0 148 210 240 cm /B Do Q', 'q 180 0 0 148 410 240 cm /C Do Q', 'q 180 0 0 148 10 40 cm /D Do Q', 'q 20 0 0 16 300 100 cm /B Do Q'].join('\n');
    b.page({ width: 600, height: 400, content, xobjects: im });
    await check('cmyk-jpeg', b.finish().build().bytes, { mae: 4, bad: 0.01 });
  });

  test('images: in forms, drawn small then large, and in hidden optional content', async () => {
    const b = new DocBuilder();
    const rgb = synthesize({ width: 240, height: 160, components: 3, pattern: 'photo', seed: 5 });
    const jpeg = new Uint8Array(await sharp(Buffer.from(rgb), { raw: { width: 240, height: 160, channels: 3 } }).jpeg({ quality: 90 }).toBuffer());
    const A = b.stream('/Type /XObject /Subtype /Image /Width 240 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', jpeg);
    const B = b.stream('/Type /XObject /Subtype /Image /Width 240 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', flate(rgb));
    const J = b.stream('/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode', new Uint8Array(16));
    const form = b.stream(`/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [200 0 0 120 10 10] /Resources << /XObject << /B ${B} 0 R >> >>`, bytes('q 1 0 0 1 0 0 cm /B Do Q'));
    const ocg = b.obj('<< /Type /OCG /Name (Hidden) >>');
    b.catalogExtra = ` /OCProperties << /OCGs [${ocg} 0 R] /D << /OFF [${ocg} 0 R] >> >>`;
    const content = [
      'q 60 0 0 40 20 300 cm /A Do Q',
      'q 300 0 0 200 100 180 cm /A Do Q',
      '/F Do',
      `/OC /L BDC q 100 0 0 100 450 250 cm /J Do Q EMC`,
    ].join('\n');
    b.page({ width: 600, height: 400, content, xobjects: { A, F: form, J }, resources: ` /Properties << /L ${ocg} 0 R >>` });
    const pdf = b.finish().build().bytes;
    await check('images-prefetch', pdf, { mae: 4, bad: 0.01 });
    // The hidden JBIG2 image is neither drawn nor reported.
    expect((await session!.ours(pdf)).warnings).toEqual([]);
  });

  test('rotated rectangles with shading patterns; ZapfDingbats and Symbol without embedding', async () => {
    const b = new DocBuilder();
    const fn = b.obj('<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>');
    const pat = b.obj(`<< /Type /Pattern /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Function ${fn} 0 R /Coords [0 0 1 0] /Extend [true true] >> /Matrix [600 0 0 400 0 0] >>`);
    const zapf = b.obj('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
    const suits = b.obj('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats /Encoding << /Differences [1 /a109 /a110] >> >>');
    const content = [
      'q 0.7071 0.7071 -0.7071 0.7071 150 150 cm /Pattern cs /P scn 0 0 100 100 re f Q',
      'BT /Z 60 Tf 350 250 Td (4) Tj /S 60 Tf 80 0 Td <0102> Tj ET',
    ].join('\n');
    b.page({ width: 600, height: 400, content, resources: ` /Pattern << /P ${pat} 0 R >> /Font << /Z ${zapf} 0 R /S ${suits} 0 R >>` });
    const pdf = b.finish().build().bytes;
    const ours = await check('rotated-dingbats', pdf, { mae: 6, bad: 0.03 });
    // The rotated square is filled (its corners reach past the two that were once its box).
    expect(near(pixel(ours, 150, 400 - 220), [255, 255, 255], 30)).toBe(false);
    // The check mark and the suits are drawn, not left out as untranslatable codes.
    const inked = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pixel(ours, x, y)[0] < 128) n++;
      return n;
    };
    expect(inked(350, 400 - 310, 420, 400 - 245)).toBeGreaterThan(100);
    expect(inked(430, 400 - 310, 560, 400 - 245)).toBeGreaterThan(100);
  });

  test('images: CCITT fax (Group 4), decoded on demand', async () => {
    const b = new DocBuilder();
    const px = new Uint8Array(96 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) px[y * 96 + x] = (x - 48) ** 2 + (y - 32) ** 2 < 900 !== ((x >> 3) % 2 === 0) ? 1 : 0;
    const fax = ccittEncode(px, 96, 64, { k: -1, eob: true });
    const im = b.stream('/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 96 /Rows 64 >>', fax);
    b.page({ width: 300, height: 200, content: 'q 288 0 0 192 6 4 cm /F Do Q', xobjects: { F: im } });
    await check('ccitt', b.finish().build().bytes, { mae: 6, bad: 0.02 });
  });

  test('text: fonts that are not embedded', async () => {
    const b = new DocBuilder();
    const fonts = ['Helvetica', 'Times-Roman', 'Courier', 'Helvetica-Bold'].map((f) => b.obj(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    const content = fonts.map((_, i) => `BT /F${i + 2} 28 Tf 20 ${340 - i * 80} Td (Sphinx of black quartz, judge my vow) Tj ET`).join('\n');
    b.page({ width: 600, height: 400, content, resources: ` /Font << ${fonts.map((f, i) => `/F${i + 2} ${f} 0 R`).join(' ')} >>` });
    // System fonts differ from MuPDF's built-in ones: only a loose check.
    await check('text-standard', b.finish().build().bytes, { mae: 12, bad: 0.06 });
  });

  const liberation = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf';
  const t1 = '/usr/share/fonts/type1/urw-base35/NimbusSans-Regular.t1';
  const otf = '/usr/share/fonts/opentype/urw-base35/C059-Roman.otf';

  /** A page of text in fonts embedded by MuPDF. */
  function mupdfText(specs: { name: string; font: mupdf.Font; cid?: boolean }[]): Uint8Array {
    const doc = new mupdf.PDFDocument();
    const res = doc.newDictionary();
    const fd = doc.newDictionary();
    let content = '';
    specs.forEach((s, i) => {
      fd.put(`F${i}`, s.cid ? doc.addFont(s.font) : doc.addSimpleFont(s.font, 'Latin'));
      const text = 'Grumpy wizards make toxic brew';
      const str = s.cid
        ? `<${[...text].map((c) => s.font.encodeCharacter(c.charCodeAt(0)).toString(16).padStart(4, '0')).join('')}>`
        : `(${text})`;
      content += `BT /F${i} 26 Tf 20 ${360 - i * 70} Td ${str} Tj ET\n`;
    });
    res.put('Font', fd);
    doc.insertPage(-1, doc.addPage([0, 0, 600, 400], 0, res, content));
    return doc.saveToBuffer('').asUint8Array().slice();
  }

  test.skipIf(!existsSync(liberation))('text: embedded TrueType, simple and CID-keyed', async () => {
    const buf = readFileSync(liberation);
    const pdf = mupdfText([
      { name: 'tt', font: new mupdf.Font('LiberationSerif', buf) },
      { name: 'cid', font: new mupdf.Font('LiberationSerif', buf), cid: true },
    ]);
    await check('text-truetype', pdf, { mae: 3, bad: 0.01 });
  });

  test.skipIf(!existsSync(liberation))('text: clipping and stroking with an embedded font', async () => {
    const doc = new mupdf.PDFDocument();
    const res = doc.newDictionary();
    const fd = doc.newDictionary();
    fd.put('F0', doc.addSimpleFont(new mupdf.Font('LiberationSerif', readFileSync(liberation)), 'Latin'));
    res.put('Font', fd);
    const content = 'BT /F0 40 Tf 1 Tr 1.5 w 0 0 1 RG 20 320 Td (Outlined) Tj ET\nq BT /F0 90 Tf 7 Tr 20 120 Td (CLIP) Tj ET 1 0 0 rg 0 0 1 RG 20 100 400 120 re f Q';
    doc.insertPage(-1, doc.addPage([0, 0, 600, 400], 0, res, content));
    await check('text-clip', doc.saveToBuffer('').asUint8Array().slice(), { mae: 3, bad: 0.01 });
  });

  test.skipIf(!existsSync(t1))('text: embedded Type 1', async () => {
    await check('text-type1', mupdfText([{ name: 't1', font: new mupdf.Font('NimbusSans', readFileSync(t1)) }]), { mae: 3, bad: 0.01 });
  });

  test.skipIf(!existsSync(otf))('text: embedded OpenType (CFF)', async () => {
    await check('text-cff', mupdfText([{ name: 'otf', font: new mupdf.Font('C059', readFileSync(otf)), cid: true }]), { mae: 3, bad: 0.01 });
  });

  const gs = Bun.which('gs');
  test.skipIf(!gs)('text: bare CFF fonts as Ghostscript embeds them (Type1C subsets)', async () => {
    const ps = [
      '%!PS',
      '<< /PageSize [600 400] >> setpagedevice',
      '/Times-Roman findfont 28 scalefont setfont 20 330 moveto (Grumpy wizards make toxic brew) show',
      '/Helvetica-BoldOblique findfont 28 scalefont setfont 20 260 moveto (for the evil Queen and Jack) show',
      '/Courier findfont 22 scalefont setfont 20 200 moveto (0123456789 !?&@#) show',
      '/Times-Italic findfont 40 scalefont setfont 20 120 moveto (fi fl \\351t\\351 na\\357ve) show',
      'showpage',
    ].join('\n');
    const r = Bun.spawnSync([gs!, '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7', '-dPDFSETTINGS=/prepress', '-sOutputFile=-', '-'], { stdin: Buffer.from(ps), stdout: 'pipe' });
    const pdf = new Uint8Array(r.stdout);
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    await check('text-type1c', pdf, { mae: 3, bad: 0.01 });
  });

  test('text: render modes, character and word spacing, rise, scaling, Type 3', async () => {
    const b = new DocBuilder();
    const proc = b.stream('', bytes('1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f'));
    const t3 = b.obj(`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /sq ${proc} 0 R >> /Encoding << /Differences [65 /sq] >> /FirstChar 65 /LastChar 65 /Widths [1100] /Resources << >> >>`);
    const content = [
      `BT /T3 20 Tf 20 350 Td (AAAAA) Tj ET`,
      `BT /F1 30 Tf 1 Tr 1 w 0 0 1 RG 20 280 Td (Outline) Tj ET`,
      `BT /F1 30 Tf 2 Tr 20 220 Td 0 1 0 rg (Both) Tj ET`,
      `BT /F1 20 Tf 5 Tc 10 Tw 150 Tz 20 160 Td (spaced out words) Tj ET`,
      `BT /F1 20 Tf 20 100 Td (base) Tj 8 Ts (up) Tj -8 Ts (down) Tj ET`,

    ].join('\n');
    // The page's own /Font entry is replaced by this one, so it lists F1 as well.
    b.page({ width: 600, height: 400, content, resources: ` /Font << /F1 ${b.font} 0 R /T3 ${t3} 0 R >>` });
    await check('text-modes', b.finish().build().bytes, { mae: 12, bad: 0.06 });
  });

  test('shadings: axial and radial (sh and pattern fills), extend, function-based, meshes', async () => {
    const b = new DocBuilder();
    const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
    const axial = b.obj(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 300 280 300] /Function ${fn} /Extend [true true] >>`);
    const noext = b.obj(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [340 300 520 300] /Function ${fn} >>`);
    const radial = b.obj(`<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [150 120 10 150 120 90] /Function ${fn} /Extend [true false] >>`);
    // Calculator function: (x, y) -> (x, y, x·y).
    const calc = b.stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]', bytes('{ 2 copy mul }'));
    const fnb = b.obj(`<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [100 0 0 100 400 60] /Function ${calc} 0 R >>`);
    const mesh = b.stream('/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 600 0 400 0 1 0 1 0 1]', meshData());
    const pat = b.obj(`<< /PatternType 2 /Shading ${axial} 0 R /Matrix [1 0 0 1 0 -100] >>`);
    const content = [
      'q 20 250 260 100 re W n /Ax sh Q',
      'q 300 250 260 100 re W n /NoExt sh Q',
      'q 40 20 220 200 re W n /Rad sh Q',
      'q 400 60 100 100 re W n /Fn sh Q',
      '/Pattern cs /P0 scn 20 20 20 20 re f',
      'q /Mesh sh Q',
    ].join('\n');
    b.page({ width: 600, height: 400, content, resources: ` /Shading << /Ax ${axial} 0 R /NoExt ${noext} 0 R /Rad ${radial} 0 R /Fn ${fnb} 0 R /Mesh ${mesh} 0 R >> /Pattern << /P0 ${pat} 0 R >>` });
    const ours = await check('shadings', b.finish().build().bytes, { mae: 6, bad: 0.02 });
    // No extend: left of the axis start stays white.
    expect(near(pixel(ours, 320, 400 - 300), [255, 255, 255], 4)).toBe(true);
  });

  test('tiling patterns, colored and uncolored', async () => {
    const b = new DocBuilder();
    const colored = b.stream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << >>', bytes('1 0 0 rg 0 0 10 10 re f 0 0 1 rg 10 10 10 10 re f'));
    const uncolored = b.stream('/PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 16 16] /XStep 16 /YStep 16 /Resources << >>', bytes('4 4 8 8 re f'));
    const content = ['/Pattern cs /P1 scn 20 200 260 180 re f', '/CP cs 0 0.6 0 /P2 scn 320 200 260 180 re f', '/Pattern cs /P1 scn 30 w 40 60 m 560 120 l S'].join('\n');
    b.page({ width: 600, height: 400, content, resources: ` /Pattern << /P1 ${colored} 0 R /P2 ${uncolored} 0 R >> /ColorSpace << /CP [/Pattern /DeviceRGB] >>` });
    await check('patterns', b.finish().build().bytes, { mae: 8, bad: 0.04 });
  });

  test('transparency groups and soft masks', async () => {
    const b = new DocBuilder();
    const group = b.stream('/Type /XObject /Subtype /Form /BBox [0 0 600 400] /Group << /S /Transparency >>', bytes('1 0 0 rg 50 50 200 200 re f 0 0 1 rg 150 150 200 200 re f'));
    const maskForm = b.stream(
      '/Type /XObject /Subtype /Form /BBox [0 0 600 400] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /S << /ShadingType 2 /ColorSpace /DeviceGray /Coords [380 0 580 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> /Extend [true true] >> >> >>',
      bytes('/S sh'),
    );
    const content = ['q /Half gs /G Do Q', 'q /Mask gs 0 0.5 0 rg 380 50 200 300 re f Q'].join('\n');
    b.page({
      width: 600,
      height: 400,
      content,
      xobjects: { G: group },
      resources: ` /ExtGState << /Half << /ca 0.5 >> /Mask << /SMask << /S /Luminosity /G ${maskForm} 0 R >> >> >>`,
    });
    const ours = await check('transparency', b.finish().build().bytes, { mae: 5, bad: 0.02 });
    // The group is composited as a whole: where red and blue overlap only blue shows, at half strength.
    expect(near(pixel(ours, 200, 400 - 200), [128, 128, 255], 12)).toBe(true);
    // The soft mask fades the green rectangle in from left to right.
    const left = pixel(ours, 385, 200);
    const right = pixel(ours, 575, 200);
    expect(left[1]).toBeGreaterThan(right[1]);
  });

  test('page geometry: rotation, crop box, annotations', async () => {
    const b = new DocBuilder();
    const ap = b.stream('/Type /XObject /Subtype /Form /BBox [0 0 100 50]', bytes('0 0.5 1 rg 0 0 100 50 re f 1 g 10 10 80 30 re f'));
    const annot = b.obj(`<< /Type /Annot /Subtype /Square /Rect [300 100 500 200] /AP << /N ${ap} 0 R >> >>`);
    const hidden = b.obj(`<< /Type /Annot /Subtype /Square /Rect [50 50 150 100] /F 2 /AP << /N ${ap} 0 R >> >>`);
    b.page({ width: 600, height: 400, content: '1 0 0 rg 0 0 300 200 re f 0 0 1 rg 300 200 300 200 re f', extra: ` /Rotate 90 /CropBox [0 0 600 380] /Annots [${annot} 0 R ${hidden} 0 R]` });
    const ours = await check('geometry', b.finish().build().bytes, { mae: 2, bad: 0.004 });
    expect(ours.width).toBe(380);
    expect(ours.height).toBe(600);
  });

  test('JPEG 2000: color spaces from the codestream or the image, alpha (SMaskInData), reduced', async () => {
    const b = new DocBuilder();
    const jpx = (f: string) => new Uint8Array(readFileSync(new URL(`../render/fixtures/jpx/${f}`, import.meta.url)));
    const im = (f: string, w: number, h: number, extra = '') => b.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /Filter /JPXDecode${extra}`, jpx(f));
    const x = {
      A: im('rgb-97.jp2', 88, 64),
      B: im('gray-97.j2k', 88, 64, ' /ColorSpace /DeviceGray /BitsPerComponent 8'),
      C: im('rgba-97.jp2', 88, 64, ' /SMaskInData 1'),
      D: im('cmyk-53.jp2', 67, 45),
      E: im('sycc-420-97.jp2', 88, 64),
    };
    const content = [
      'q 176 0 0 128 10 260 cm /A Do Q',
      'q 176 0 0 128 200 260 cm /B Do Q',
      '0 0 1 rg 390 260 176 128 re f q 176 0 0 128 390 260 cm /C Do Q',
      'q 134 0 0 90 10 120 cm /D Do Q',
      'q 176 0 0 128 200 110 cm /E Do Q',
      'q 22 0 0 16 420 150 cm /A Do Q',
    ].join('\n');
    b.page({ width: 600, height: 400, content, xobjects: x });
    const ours = await check('jpx', b.finish().build().bytes, { mae: 5, bad: 0.02 });
    expect(ours.warnings).toEqual([]);
  });

  test('scale and fit options; broken JPEG 2000 is reported', async () => {
    const b = new DocBuilder();
    const jpx = b.stream('/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode', new Uint8Array(32));
    b.page({ width: 200, height: 100, content: 'q 100 0 0 50 0 0 cm /J Do Q 1 0 0 rg 150 50 50 50 re f', xobjects: { J: jpx } });
    const pdf = b.finish().build().bytes;
    const big = await session!.ours(pdf, 0, { scale: 3 });
    expect([big.width, big.height]).toEqual([600, 300]);
    const fit = await session!.ours(pdf, 0, { width: 100, height: 100 });
    expect([fit.width, fit.height]).toEqual([100, 50]);
    expect(big.warnings.join()).toContain('JPEG 2000 image could not be decoded');
  });
});

if (skip) test.skip(`render tests (${skip})`, () => {});

/** Free-form Gouraud triangles: two triangles with red, green and blue corners. */
function meshData(): Uint8Array {
  const out: number[] = [];
  const v = (flag: number, x: number, y: number, r: number, g: number, bl: number) => {
    const X = Math.round((x / 600) * 65535);
    const Y = Math.round((y / 400) * 65535);
    out.push(flag, X >> 8, X & 255, Y >> 8, Y & 255, r, g, bl);
  };
  v(0, 300, 20, 255, 0, 0);
  v(0, 380, 220, 0, 255, 0);
  v(0, 300, 220, 0, 0, 255);
  v(1, 380, 20, 255, 255, 0);
  return Uint8Array.from(out);
}
