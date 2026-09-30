import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { openPdf } from '../../src/core/open.ts';
import { codeLength, lookup, parseCMap } from '../../src/features/cmap.ts';
import { glyphText } from '../../src/features/text-glyphs.ts';
import { extractAllText, extractText, type TextOptions } from '../../src/features/text.ts';
import { availableFixtures, fixture, fixtureBytes } from '../corpus/index.ts';
import { bytes, DocBuilder, flate } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import { BytesSource } from '../unit/util.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

async function ours(data: Uint8Array, opts?: TextOptions): Promise<string[]> {
  const doc = await openPdf(new BytesSource(data));
  const out: string[] = [];
  for await (const p of extractText(doc, opts)) out.push(p.text);
  return out;
}

/** mupdf's text for each page (the reference implementation). */
function reference(data: Uint8Array): string[] {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    const out: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText('');
      out.push(st.asText());
      st.destroy();
      page.destroy();
    }
    return out;
  } finally {
    doc.destroy();
    mupdf.setLog(null);
  }
}

/** Glyph-name mappings where mupdf follows the AGL and we prefer the Greek letter. */
const FOLD: Record<string, string> = { '∆': 'Δ', 'Ω': 'Ω', 'µ': 'μ' };
const words = (s: string): string[] =>
  s
    .normalize('NFKC')
    .replace(/[∆Ωµ]/g, (c) => FOLD[c])
    .split(/\s+/)
    .filter(Boolean);

/** Share of words (as a multiset) the two texts have in common. */
function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  const count = new Map<string, number>();
  for (const w of wa) count.set(w, (count.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const k = count.get(w) ?? 0;
    if (k > 0) {
      common++;
      count.set(w, k - 1);
    }
  }
  return common / Math.max(wa.length, wb.length, 1);
}

/** Every page must share at least `min` of its words with mupdf's text. */
async function expectLikeMupdf(data: Uint8Array, min = 0.98): Promise<string[]> {
  const ref = reference(data);
  const got = await ours(data);
  expect(got.length).toBe(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const s = similarity(ref[i], got[i]);
    if (s < min) console.log(`page ${i}: ${s.toFixed(3)}\n  mupdf: ${JSON.stringify(ref[i])}\n  ours:  ${JSON.stringify(got[i])}`);
    expect(s).toBeGreaterThanOrEqual(min);
  }
  return got;
}

/** Encoder for a single-byte code page (via TextDecoder), as a hex string. */
function codepage(label: string): (s: string) => string {
  const dec = new TextDecoder(label);
  const map = new Map<string, number>();
  for (let c = 255; c >= 32; c--) map.set(dec.decode(Uint8Array.of(c)), c);
  return (s) => `<${[...s].map((ch) => (map.get(ch) ?? 0x3f).toString(16).padStart(2, '0')).join('')}>`;
}

const hex16 = (s: string): string => {
  let h = '';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${h}>`;
};

type Pages = { content: string; resources: Record<string, unknown>; rotate?: 0 | 90 | 180 | 270 }[];

/** A PDF made by mupdf: `build` adds fonts and objects and returns the pages. */
function mupdfPdf(build: (doc: mupdf.PDFDocument) => Pages): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    for (const p of build(doc)) {
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], p.rotate ?? 0, doc.addObject(p.resources), p.content));
    }
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
  }
}

interface HandPage {
  /** Content stream(s); several make a /Contents array. */
  content: string | Uint8Array | (string | Uint8Array)[];
  /** Resource dictionary in PDF syntax. */
  resources: string;
  extra?: string;
}

/**
 * A hand-written PDF. `build` may add objects with the builder and returns the pages; content is
 * Flate-compressed unless `raw`.
 */
function handPdf(build: (b: DocBuilder) => HandPage[], raw = false): Uint8Array {
  const b = new DocBuilder();
  for (const p of build(b)) {
    const refs = (Array.isArray(p.content) ? p.content : [p.content]).map((c) => {
      const data = typeof c === 'string' ? bytes(c) : c;
      return raw ? b.stream('', data) : b.stream('/Filter /FlateDecode', flate(data));
    });
    const contents = Array.isArray(p.content) ? `[${refs.map((r) => `${r} 0 R`).join(' ')}]` : `${refs[0]} 0 R`;
    b.pages.push(b.obj(`<< /Type /Page /Parent ${b.pagesNum} 0 R /MediaBox [0 0 595 842] /Resources ${p.resources} /Contents ${contents}${p.extra ?? ''} >>`));
  }
  return b.finish().build().bytes;
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const LATIN = [
  'The quick brown fox jumps over the lazy dog.',
  'Àéîõü ÇÑß «quoted» “smart quotes” — dash, 3½ € 100‰ naïve café',
  'Numbers 1,234.56 and (parentheses) [brackets] {braces} 50% & more',
];
const GREEK = ['Η γρήγορη καφέ αλεπού πηδάει πάνω από τον τεμπέλη σκύλο', 'Ελληνικά κείμενα ΑΒΓΔ αβγδ'];
const CYRILLIC = ['Съешь же ещё этих мягких французских булок да выпей чаю', 'Широкая электрификация южных губерний'];

/** Base-14 fonts through mupdf's addSimpleFont with its Latin, Greek and Cyrillic encodings. */
function simpleFontsPdf(): Uint8Array {
  const win = codepage('windows-1252');
  const greek = codepage('iso-8859-7');
  const cyr = codepage('koi8-u');
  return mupdfPdf((doc) => {
    const fonts: Record<string, mupdf.PDFObject> = {};
    const faces = ['Times-Roman', 'Helvetica', 'Courier', 'Helvetica-Bold', 'Times-Italic'];
    faces.forEach((f, i) => {
      const font = new mupdf.Font(f);
      fonts[`L${i}`] = doc.addSimpleFont(font, 'Latin');
      fonts[`G${i}`] = doc.addSimpleFont(font, 'Greek');
      fonts[`C${i}`] = doc.addSimpleFont(font, 'Cyrillic');
    });
    let c = '';
    let y = 800;
    faces.forEach((_, i) => {
      for (const s of LATIN) c += `BT /L${i} ${10 + i} Tf 50 ${(y -= 18)} Td ${win(s)} Tj ET\n`;
      for (const s of GREEK) c += `BT /G${i} 11 Tf 50 ${(y -= 16)} Td ${greek(s)} Tj ET\n`;
      for (const s of CYRILLIC) c += `BT /C${i} 11 Tf 50 ${(y -= 16)} Td ${cyr(s)} Tj ET\n`;
    });
    // Font switches in the middle of a line, T* and ' operators.
    c += `BT /L0 12 Tf 14 TL 50 100 Td ${win('Mixed ')} Tj /L3 12 Tf ${win('bold words ')} Tj /L0 12 Tf ${win('and regular.')} Tj T* ${win('Next line via T*.')} Tj ${win('Quote operator line.')} ' ET\n`;
    return [{ content: c, resources: { Font: fonts } }];
  });
}

/** Type0 / Identity-H fonts (CFF from mupdf's builtin fonts, TrueType when a system font exists). */
function type0Pdf(): Uint8Array {
  const ttf = ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((p) =>
    existsSync(p),
  );
  return mupdfPdf((doc) => {
    const faces: mupdf.Font[] = [new mupdf.Font('Times-Roman'), new mupdf.Font('Helvetica-Bold')];
    if (ttf) faces.push(new mupdf.Font('TTF', readFileSync(ttf)));
    const fonts: Record<string, mupdf.PDFObject> = {};
    faces.forEach((f, i) => (fonts[`T${i}`] = doc.addFont(f)));
    const gids = (f: mupdf.Font, s: string) => `<${[...s].map((ch) => f.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, '0')).join('')}>`;
    let c = '';
    let y = 800;
    faces.forEach((f, i) => {
      for (const s of [...LATIN, 'Ελληνικά and Кириллица in one font']) c += `BT /T${i} 11 Tf 40 ${(y -= 16)} Td ${gids(f, s)} Tj ET\n`;
      // Each word positioned on its own, from the font's advance widths.
      let x = 40;
      y -= 16;
      for (const w of 'Words placed one by one with Td'.split(' ')) {
        c += `BT /T${i} 11 Tf ${x.toFixed(2)} ${y} Td ${gids(f, w)} Tj ET\n`;
        for (const ch of w + ' ') x += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!)) * 11;
      }
      // Kerning in TJ: small adjustments inside words, large ones between words.
      const k = (s: string) => gids(f, s);
      c += `BT /T${i} 11 Tf 40 ${(y -= 16)} Td [${k('Ke')} 40 ${k('rn')} -40 ${k('ing')} -300 ${k('AV')} 80 ${k('A')} -600 ${k('words')}] TJ ET\n`;
    });
    return [{ content: c, resources: { Font: fonts } }];
  });
}

const CJK: [mupdf.FontCJKLanguage, string][] = [
  ['ja', '日本語のテキスト抽出。カタカナとひらがな'],
  ['zh-Hans', '中文文本提取测试'],
  ['zh-Hant', '繁體中文測試'],
  ['ko', '한국어 텍스트 추출 시험'],
];

/** CJK fonts (UniXX-UTF16-H/V CMaps, no ToUnicode): all horizontal on page 1, then one vertical line per page. */
function cjkPdf(): Uint8Array {
  return mupdfPdf((doc) => {
    const fonts: Record<string, mupdf.PDFObject> = {};
    let c = '';
    const pages: Pages = [];
    CJK.forEach(([lang, s], i) => {
      fonts[`H${i}`] = doc.addCJKFont(new mupdf.Font('Times-Roman'), lang, 0);
      // mupdf caches CJK fonts per base font whatever the writing mode: use another one.
      const v = doc.addCJKFont(new mupdf.Font('Helvetica'), lang, 1);
      c += `BT /H${i} 14 Tf 40 ${780 - i * 30} Td ${hex16(s)} Tj ET\n`;
      pages.push({ content: `BT /V 14 Tf 400 700 Td ${hex16(s)} Tj ET`, resources: { Font: { V: v } } });
    });
    return [{ content: c, resources: { Font: fonts } }, ...pages];
  });
}

/** Spacing cases: per-glyph placement, Tw, Tz, Ts, Tc, TJ, rotation, hand-written in Helvetica with /Widths. */
function spacingPdf(): Uint8Array {
  const f = new mupdf.Font('Helvetica');
  const adv = (s: string, size: number) => [...s].reduce((x, ch) => x + f.advanceGlyph(f.encodeCharacter(ch.charCodeAt(0))) * size, 0);
  return mupdfPdf((doc) => {
    const font = doc.addSimpleFont(f, 'Latin');
    let c = 'BT /F 12 Tf 14 TL\n';
    // Letter by letter with absolute positions; spaces as gaps only.
    let x = 40;
    for (const ch of 'Glyph by glyph placement') {
      if (ch !== ' ') c += `1 0 0 1 ${x.toFixed(3)} 800 Tm (${ch}) Tj\n`;
      x += adv(ch, 12);
    }
    c += 'ET\n';
    c += 'BT /F 12 Tf 40 770 Td 6 Tw (Justified with word spacing) Tj 0 Tw ET\n';
    c += 'BT /F 12 Tf 40 750 Td 50 Tz (Condensed horizontal scaling text) Tj 100 Tz ET\n';
    c += 'BT /F 12 Tf 40 730 Td (E = mc) Tj 5 Ts 8 Tf (2) Tj 0 Ts 12 Tf ( is famous) Tj ET\n';
    c += 'BT /F 12 Tf 40 710 Td [(W) 80 (ave) 50 (s) -1000 (and) -250 (tables)] TJ ET\n';
    c += 'BT /F 12 Tf 40 690 Td (Cell one) Tj 150 0 Td (Cell two) Tj 150 0 Td (Cell three) Tj ET\n';
    c += 'BT /F 12 Tf 40 670 Td (Double  spaced   words) Tj ET\n';
    c += 'BT /F 12 Tf 0 1 -1 0 560 300 Tm (Rotated ninety degrees) Tj ET\n';
    c += 'BT /F 12 Tf 0.7071 0.7071 -0.7071 0.7071 200 300 Tm (Diagonal text line) Tj ET\n';
    c += 'BT /F 12 Tf -1 0 0 -1 400 200 Tm (Upside down) Tj ET\n';
    c += 'q 1 0 0 1 0 -300 cm 2 0 0 2 0 0 cm BT /F 6 Tf 20 250 Td (Scaled by the CTM) Tj ET Q\n';
    c += 'BT /F 12 Tf 40 100 Td (Before) Tj T* (after T* without leading) Tj ET\n';
    const pages: Pages = [{ content: c, resources: { Font: { F: font } } }];
    pages.push({ content: 'BT /F 14 Tf 72 700 Td (Rotated page text stays in order) Tj 0 -20 Td (Second line) Tj ET', resources: { Font: { F: font } }, rotate: 90 });
    return pages;
  });
}


/** Hand-written /Differences arrays over a base-14 font. */
function differencesPdf(): Uint8Array {
  const diffs =
    '[128 /Aacute /Ccaron /germandbls /fi /ffl /uni20AC /afii10017 /afii10018 /alpha /beta /Omegagreek /Scommaaccent /Lslash /oe ' +
    '/quotedblleft /quotedblright /endash /Eogonek /zcaron /dotlessi /uni00E9 /u1F600 /ydieresis /Idotaccent /Ohungarumlaut]';
  const oct = (codes: number[]) => codes.map((c) => `\\${c.toString(8)}`).join('');
  const content =
    `BT /F1 14 Tf 40 780 Td (\\200rbol ${oct([0x81])}esko Stra${oct([0x82])}e ${oct([0x83])}nd ba${oct([0x84])}e ${oct([0x85])}5) Tj ET\n` +
    `BT /F1 14 Tf 40 760 Td (${oct([0x86, 0x87])} ${oct([0x88, 0x89])} ${oct([0x8a])} ${oct([0x8b])}tiin ${oct([0x8c])}\\363dz c${oct([0x8d])}ur) Tj ET\n` +
    `BT /F1 14 Tf 40 740 Td (${oct([0x8e])}quoted${oct([0x8f])} ${oct([0x90])} ${oct([0x91])}l ${oct([0x92])}ero ${oct([0x93])}stanbul caf${oct([0x94])} ${oct([0x96])} ${oct([0x97])}zmir ${oct([0x98])}) Tj ET\n` +
    'BT /F2 14 Tf 40 700 Td (Standard encoding: it\\047s \\140quoted\\047 \\256nal) Tj ET\n' +
    'BT /F3 14 Tf 40 680 Td (MacRoman: \\212 \\216 \\247) Tj ET\n';
  return handPdf(() => [
    {
      content,
      resources:
        `<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences ${diffs} >> >> ` +
        '/F2 << /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >> /F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /MacRomanEncoding >> >> >>',
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Comparisons with mupdf

describe('extractText matches mupdf', () => {
  test('base-14 simple fonts with Latin, Greek and Cyrillic encodings', async () => {
    const got = await expectLikeMupdf(simpleFontsPdf());
    for (const s of [...LATIN, ...GREEK, ...CYRILLIC]) expect(got[0]).toContain(s);
    expect(got[0]).toContain('Mixed bold words and regular.\nNext line via T*.\nQuote operator line.');
  });

  test('Type0 Identity-H fonts with ToUnicode, TJ kerning and per-word placement', async () => {
    const got = await expectLikeMupdf(type0Pdf());
    expect(got[0]).toContain('Words placed one by one with Td');
    expect(got[0]).toContain('Kerning AVA words');
    for (const s of LATIN) expect(got[0]).toContain(s);
  });

  test('CJK fonts with UTF-16 CMaps, horizontal and vertical', async () => {
    const data = cjkPdf();
    const ref = reference(data);
    const got = await ours(data);
    expect(similarity(ref[0], got[0])).toBe(1);
    // mupdf puts each glyph of vertical text on a line of its own; we keep the column together.
    const squash = (s: string) => s.replace(/\s+/g, '');
    expect(got.map(squash)).toEqual(ref.map(squash));
    expect(got[0].split('\n')).toEqual(CJK.map(([, s]) => s));
    expect(got.slice(1)).toEqual(CJK.map(([, s]) => s));
  });

  test('spacing: glyph placement, Tw, Tz, Ts, TJ, tables, rotation', async () => {
    const got = await expectLikeMupdf(spacingPdf(), 0.9);
    const lines = got[0].split('\n');
    for (const s of [
      'Glyph by glyph placement',
      'Justified with word spacing',
      'Condensed horizontal scaling text',
      'Waves and tables',
      'Cell one Cell two Cell three',
      'Double spaced words',
      'Rotated ninety degrees',
      'Diagonal text line',
      'Upside down',
      'Scaled by the CTM',
    ]) {
      expect(lines).toContain(s);
    }
    expect(got[0]).toContain('E = mc2 is famous');
    expect(got[1]).toBe('Rotated page text stays in order\nSecond line');
  });

  test('hand-written /Differences and base encodings', async () => {
    const got = await expectLikeMupdf(differencesPdf());
    expect(got[0].split('\n')).toEqual([
      'Árbol Česko Straße find baffle €5',
      'АБ αβ Ω Știin Łódz cœur',
      '“quoted” – Ęl žero ıstanbul café ÿ İzmir Ő',
      'Standard encoding: it’s ‘quoted’ final',
      'MacRoman: ä é ß',
    ]);
  });

  test('the corpus', async () => {
    let checked = 0;
    for (const f of availableFixtures()) {
      const data = await fixtureBytes(f);
      if (f.expect.encrypted) {
        await expect(ours(data)).rejects.toBeInstanceOf(PdfEncryptedError);
        continue;
      }
      let ref: string[];
      try {
        ref = reference(data);
      } catch {
        continue; // mupdf cannot open some of the damaged files
      }
      if (!ref.length) continue;
      const got = await ours(data);
      expect(got.length).toBe(ref.length);
      expect(similarity(ref.join('\n'), got.join('\n'))).toBeGreaterThanOrEqual(0.98);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    const text = await ours(await fixtureBytes(fixture('text-only')));
    expect(text[0].split('\n')[0]).toBe('Plain text 1');
  });

  test.skipIf(!hasQpdf)('object streams (qpdf)', async () => {
    const data = qpdfTransform(simpleFontsPdf(), ['--object-streams=generate', '--compress-streams=y']);
    expect(await ours(data)).toEqual(await ours(simpleFontsPdf()));
    await expectLikeMupdf(data);
  });
});

// ---------------------------------------------------------------------------------------------
// Content stream features

const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const TIMES = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>';
const COURIER = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
const line = (s: string, x: number, y: number, font = 'F1', size = 12) => `BT /${font} ${size} Tf ${x} ${y} Td (${s}) Tj ET\n`;

/** Nested Form XObjects with their own resources, a cycle, inherited resources and an image. */
function formsPdf(): Uint8Array {
  return handPdf((b) => {
    const outer = b.alloc();
    const inner = b.alloc();
    const plain = b.alloc();
    const img = b.stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Uint8Array.of(0));
    b.setStream(
      outer,
      `/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /FX ${TIMES} >> /XObject << /Inner ${inner} 0 R /Img ${img} 0 R >> >> /Filter /FlateDecode`,
      flate(bytes(line('Text in the outer form', 40, 600, 'FX') + '/Inner Do /Img Do')),
    );
    b.setStream(
      inner,
      `/Type /XObject /Subtype /Form /BBox [0 0 1000 1000] /Matrix [0.5 0 0 0.5 20 300] /Resources << /Font << /FY ${COURIER} >> /XObject << /Self ${inner} 0 R /Loop ${outer} 0 R >> >>`,
      bytes(line('Nested form text', 40, 500, 'FY', 20) + '/Self Do /Loop Do'),
    );
    b.setStream(plain, '/Type /XObject /Subtype /Form /BBox [0 0 595 842]', bytes(line('Form using page resources', 40, 150)));
    return [
      {
        content: line('Page text before', 40, 800) + 'q 1 0 0 1 0 100 cm /Outer Do Q q 1 0 0 1 0 -200 cm /Outer Do Q /Plain Do /Missing Do /Img Do ' + line('Page text after', 40, 100),
        resources: `<< /Font << /F1 ${HELV} >> /XObject << /Outer ${outer} 0 R /Plain ${plain} 0 R /Img ${img} 0 R >> >>`,
      },
    ];
  });
}

/** Inline images whose data looks like operators, strings and even `EI`. */
function inlineImagesPdf(): Uint8Array {
  const fake = '(Fake) Tj EI Q ' + '\xff'; // exactly 16 bytes
  const rl = '\x13' + '\x01\x02(Evil) Tj ET BT\xfe\xff' + '\x80'; // RunLength: 20 literal bytes, then EOD
  const named = ' EI \xff\xfe(Evil) Tj EI ET '; // 20 bytes; the colour space is a resource, so the length is unknown
  const content =
    line('Before images', 40, 800) +
    `q 100 0 0 10 40 700 cm BI /W 16 /H 1 /CS /G /BPC 8 ID ${fake} EI Q\n` +
    line('After a raw image', 40, 680) +
    'q 100 0 0 10 40 600 cm BI /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode ID 00ff00ff0000 0000ff00ff00> EI Q\n' +
    line('After a hex image', 40, 580) +
    `q 100 0 0 10 40 500 cm BI /W 20 /H 1 /CS /G /BPC 8 /F /RL ID ${rl} EI Q\n` +
    line('After a run length image', 40, 480) +
    `q 100 0 0 10 40 450 cm BI /W 20 /H 1 /CS /CS0 /BPC 8 ID ${named} EI Q\n` +
    line('After a named colour space image', 40, 430) +
    'q 10 0 0 10 40 400 cm BI /IM true /W 8 /H 2 /D [1 0] ID \x28\x29 EI Q\n' +
    line('After an image mask', 40, 380);
  return handPdf(() => [{ content, resources: `<< /Font << /F1 ${HELV} >> /ColorSpace << /CS0 /DeviceGray >> >>` }]);
}

/** A Type0 font with an embedded encoding CMap (1- and 2-byte codes) and a hand-written ToUnicode. */
function customCMapPdf(): Uint8Array {
  const enc =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Custom def /CMapType 1 def\n' +
    '2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange\n' +
    '2 begincidrange <20> <7E> 1 <8000> <80FF> 200 endcidrange\nendcmap CMapName currentdict /CMap defineresource pop end end';
  const tu =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Custom-UCS def /CMapType 2 def\n' +
    '2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange\n' +
    '1 beginbfrange <20> <7E> <0020> endbfrange\n' +
    '3 beginbfchar <8001> <D835DC00> <8002> <00660069> <8003> /eacute endbfchar\n' +
    '2 beginbfrange <8010> <8012> [<0041> <0042> <0043>] <8020> <8022> <00E0> endbfrange\nendcmap end end';
  return handPdf((b) => {
    const e = b.stream('/Type /CMap /CMapName /Custom', bytes(enc));
    const t = b.stream('', bytes(tu));
    const cid = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /W [1 [278] 200 210 600] >>';
    return [
      {
        content: 'BT /C 12 Tf 40 800 Td <48656c6c6f20 8001 8002 8003 20 8010 8011 8012 20 8020 8021 8022> Tj ET',
        resources: `<< /Font << /C << /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding ${e} 0 R /ToUnicode ${t} 0 R /DescendantFonts [${cid}] >> >> >>`,
      },
    ];
  });
}

/** Marked content with /ActualText, inline and through /Properties. */
function actualTextPdf(): Uint8Array {
  const content =
    '/Span << /ActualText (Actual text) >> BDC ' + line('Glyphs replaced', 40, 800) + 'EMC\n' +
    line('Normal line', 40, 780) +
    '/Span /P1 BDC ' + line('xyz', 40, 760) + 'EMC\n' +
    '/Figure << /ActualText (Formula x2) >> BDC 0 0 10 10 re f EMC\n' +
    '/Artifact << /ActualText () >> BDC ' + line('Hidden decoration', 40, 740) + 'EMC\n' +
    '/P << /MCID 0 >> BDC ' + line('Tagged content', 40, 720) + 'EMC\n' +
    '/Span << /ActualText (Outer) >> BDC /Span << /ActualText (Inner) >> BDC ' + line('x', 40, 700) + 'EMC ' + line('y', 60, 700) + 'EMC\n' +
    'EMC EMC ' + line('After stray EMC', 40, 680);
  return handPdf(() => [{ content, resources: `<< /Font << /F1 ${HELV} >> /Properties << /P1 << /ActualText <FEFF00C9007400E9> >> >> >>` }]);
}

/** Type3 fonts (glyph names in /Differences, FontMatrix scaling) and base-14 built-in encodings. */
function builtinEncodingsPdf(): Uint8Array {
  const clear =
    '%!PS-AdobeFont-1.0: Fake 001\n/FontName /Fake def\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n' +
    'dup 65 /Aring put\ndup 66 /eacute put\ndup 67 /fi put\ndup 32 /space put\nreadonly def\ncurrentfile eexec\n';
  return handPdf((b) => {
    const proc = (w: number) => b.stream('', bytes(`${w} 0 d0 0 0 m ${w - 100} 0 l ${w - 100} 700 l f`));
    const pa = proc(600);
    const ps = proc(300);
    const widths = Array.from({ length: 67 }, (_, i) => (i === 0 ? 300 : i >= 33 ? 600 : 0)).join(' ');
    const t3 = (fm: string, scale: number) =>
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [${fm}] /CharProcs << /A ${pa} 0 R /B ${pa} 0 R /C ${pa} 0 R /space ${ps} 0 R >> ` +
      `/Encoding << /Type /Encoding /Differences [32 /space 65 /A /B /C 97 /a1 /g98] >> /FirstChar 32 /LastChar 98 /Widths [${widths
        .split(' ')
        .map((w) => +w / scale)
        .join(' ')}] >>`;
    const ff = b.stream('/Length1 ' + clear.length + ' /Length2 16 /Length3 0', bytes(clear + '\x80\x81\x82binary junk!!'));
    const fake = `<< /Type /Font /Subtype /Type1 /BaseFont /Fake /FirstChar 32 /LastChar 67 /Widths [${Array(36).fill(500).join(' ')}] /FontDescriptor << /Type /FontDescriptor /FontName /Fake /Flags 4 /FontFile ${ff} 0 R >> >>`;
    const content =
      line('ABC CAB ab', 40, 800, 'T1', 20) +
      line('ABC CAB ab', 40, 770, 'T2', 20) +
      line('abg DW', 40, 740, 'S') +
      line('3456', 40, 720, 'Z') +
      line('ABC BA', 40, 700, 'X') +
      line('ABCD', 40, 680, 'N');
    return [
      {
        content,
        resources:
          `<< /Font << /T1 ${t3('0.001 0 0 0.001 0 0', 1)} /T2 ${t3('0.01 0 0 0.01 0 0', 10)} /S << /Type /Font /Subtype /Type1 /BaseFont /Symbol >> ` +
          `/Z << /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >> /X ${fake} ` +
          '/N << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /g65 /g99 /cid67 /u00E9] >> >> >> >>',
      },
    ];
  });
}

/** Legacy CJK CMaps without ToUnicode: codes are decoded as Shift-JIS, GBK, Big5 and EUC-KR. */
function legacyCjkPdf(): Uint8Array {
  const font = (enc: string, ordering: string) =>
    `<< /Type /Font /Subtype /Type0 /BaseFont /CJK /Encoding /${enc} /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /CJK ` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 2 >> /DW 1000 >>] >>`;
  const content =
    'BT /J 14 Tf 40 800 Td <93FA967B8CEA20836583588367> Tj ET\n' + // 日本語 テスト
    'BT /G 14 Tf 40 770 Td <D6D0CEC4B2E2CAD4> Tj ET\n' + // 中文测试
    'BT /B 14 Tf 40 740 Td <A4A4A4E5> Tj ET\n' + // 中文
    'BT /K 14 Tf 40 710 Td <C7D1B1B9BEEE> Tj ET\n'; // 한국어
  return handPdf(() => [
    {
      content,
      resources: `<< /Font << /J ${font('90ms-RKSJ-H', 'Japan1')} /G ${font('GBK-EUC-H', 'GB1')} /B ${font('ETen-B5-H', 'CNS1')} /K ${font('KSCms-UHC-H', 'Korea1')} >> >>`,
    },
  ]);
}

describe('content stream features', () => {
  test('Form XObjects: own resources, matrices, cycles, inherited resources', async () => {
    const data = formsPdf();
    const got = await ours(data);
    expect(got[0].split('\n')).toEqual([
      'Page text before',
      'Text in the outer form',
      'Nested form text',
      'Text in the outer form',
      'Nested form text',
      'Form using page resources',
      'Page text after',
    ]);
    expect(similarity(reference(data)[0], got[0])).toBe(1);
  });

  test('inline images are skipped, whatever their data looks like', async () => {
    const data = inlineImagesPdf();
    const got = await ours(data);
    expect(got[0].split('\n')).toEqual(['Before images', 'After a raw image', 'After a hex image', 'After a run length image', 'After a named colour space image', 'After an image mask']);
    expect(similarity(reference(data)[0], got[0])).toBe(1);
  });

  test('embedded encoding CMap and ToUnicode with ranges, arrays, surrogates, names', async () => {
    expect(await ours(customCMapPdf())).toEqual([`Hello ${String.fromCodePoint(0x1d400)}fié ABC àáâ`]);
  });

  test('ActualText replaces the glyphs it covers', async () => {
    const [text] = await ours(actualTextPdf());
    expect(text.split('\n')).toEqual(['Actual text', 'Normal line', 'Été Formula x2', 'Tagged content', 'Outer', 'After stray EMC']);
  });

  test('Type3 fonts, Symbol, ZapfDingbats, embedded Type1 encodings, numeric glyph names', async () => {
    const [text] = await ours(builtinEncodingsPdf());
    // g98 at code 98 falls back to the base encoding; a1 at code 97 is unknown and dropped. Dingbats are not text.
    expect(text.split('\n')).toEqual(['ABC CAB b', 'ABC CAB b', 'αβγ ΔΩ', 'Åéfi éÅ', 'ACé']);
  });

  test('spacing beyond mupdf: letter spacing, fake bold, headings, superscripts', async () => {
    const f = new mupdf.Font('Helvetica');
    const w = (ch: string) => f.advanceGlyph(f.encodeCharacter(ch.charCodeAt(0))) * 12;
    let bold = 'BT /F1 12 Tf\n';
    let x = 40;
    for (const ch of 'Fake bold') {
      if (ch !== ' ') for (const dx of [0, 0.3, 0.6]) bold += `1 0 0 1 ${(x + dx).toFixed(2)} 760 Tm (${ch}) Tj\n`;
      x += w(ch);
    }
    bold += 'ET\n';
    const content =
      'BT /F1 12 Tf 40 800 Td 3 Tc (Letter spaced heading) Tj 0 Tc ET\n' +
      'BT /F1 12 Tf 40 780 Td -0.5 Tc (Tight tracking works) Tj 0 Tc ET\n' +
      bold +
      'BT /F1 24 Tf 40 700 Td (Big heading) Tj /F1 10 Tf 0 -14 Td (Body right below) Tj ET\n' +
      'BT /F1 10 Tf 40 660 Td (Footnote) Tj 4 Ts 6 Tf (12) Tj 0 Ts 10 Tf ( and H) Tj -2 Ts 7 Tf (2) Tj 0 Ts 10 Tf (O) Tj ET\n';
    const [text] = await ours(handPdf(() => [{ content, resources: `<< /Font << /F1 ${HELV} >> >>` }]));
    expect(text.split('\n')).toEqual(['Letter spaced heading', 'Tight tracking works', 'Fake bold', 'Big heading', 'Body right below', 'Footnote12 and H2O']);
  });

  test('legacy CJK CMaps without ToUnicode', async () => {
    const got = await ours(legacyCjkPdf());
    // mupdf's WASM build has no CJK CMap resources, so it cannot serve as the reference here.
    expect(got[0].split('\n')).toEqual(['日本語 テスト', '中文测试', '中文', '한국어']);
  });
});

// ---------------------------------------------------------------------------------------------
// Robustness and API

describe('robustness', () => {
  test('malformed content keeps the text around the damage', async () => {
    const rng = new Rng(7);
    const junk = Array.from(rng.bytes(3000), (c) => String.fromCharCode(c === 0x28 || c === 0x3c || c === 0x5b || c === 0x25 ? 0x20 : c)).join('');
    const content =
      line('Good text', 40, 800) +
      'BT /F1 12 Tf [(unterminated array) Tj ET\n' +
      ') ) ] >> << /Foo [ 1 2 >> } { BT 1 2 3 4 5 6 7 Tm Tm Td TJ Tj \' " 1e999 0 0 1 0 0 cm\n' +
      line('Still here', 40, 700) +
      'BT /NoSuchFont 12 Tf 40 680 Td (No such font) Tj ET\n' +
      'BT 12 Tf 40 660 Td (No font at all) Tj ET\n' +
      'q '.repeat(3000) + 'Q '.repeat(3100) + '\n' +
      junk + '\n' +
      line('After garbage', 40, 600) +
      '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[ ]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]] pop\n' +
      '/Span <</ActualText (unterminated dict BDC\n' +
      line('After the bad dictionary', 40, 560) +
      'BT /F1 12 Tf (unterminated string';
    const [text] = await ours(handPdf(() => [{ content, resources: `<< /Font << /F1 ${HELV} >> >>` }]));
    for (const s of ['Good text', 'Still here', 'No such font', 'No font at all', 'After garbage']) expect(text).toContain(s);
  });

  test('broken fonts fall back instead of failing', async () => {
    const fonts = [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Widths 999 0 R /FirstChar (x) /ToUnicode 998 0 R /Encoding /Bogus >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>',
      '<< /Type /Font /Subtype /Type0 /Encoding 997 0 R /DescendantFonts 5 /ToUnicode /Identity-H >>',
      '<< /Type /Font /Subtype /TrueType /FontDescriptor 12 /Widths [1 2 (x) /y] /Encoding << /Differences [(a) 65 [1] /A 66 /B] >> >>',
      '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [<< /W [1 [2 3] 4 5 /x 6 [ ] 7] /DW (x) >>] /ToUnicode 3 0 R >>',
      '(not a font)',
      '999 0 R',
    ];
    const res = `<< /Font << ${fonts.map((f, i) => `/F${i} ${f}`).join(' ')} >> >>`;
    const content = fonts.map((_, i) => line('Hello', 40, 800 - i * 20, `F${i}`)).join('');
    const [text] = await ours(handPdf(() => [{ content, resources: res }]));
    // Type0 fonts without any Unicode mapping (F1, F4) contribute nothing; /ToUnicode /Identity-H
    // maps two-byte codes to UTF-16 units; zero widths (F3) must not drop repeated letters.
    expect(text.split('\n')).toEqual(['Hello', '\u4865\u6c6co', 'Hello', 'Hello', 'Hello']);
  });

  test('pages without usable content, content arrays, missing streams', async () => {
    const data = handPdf((b) => {
      const bad = b.stream('/Filter /DCTDecode', bytes('not jpeg'));
      return [
        { content: ['BT /F1 12 Tf 40 800 Td (Split ', 'across) Tj ( streams) Tj ET'], resources: `<< /Font << /F1 ${HELV} >> >>` },
        { content: '', resources: '<< >>', extra: ` /Contents [${bad} 0 R 999 0 R null]` },
        { content: line('Third page', 40, 800), resources: `<< /Font << /F1 ${HELV} >> >>` },
      ];
    });
    expect(await ours(data)).toEqual(['Split across streams', '', 'Third page']);
  });

  test('page selection, extractAllText and abort', async () => {
    const data = handPdf(() => ['one', 'two', 'three', 'four'].map((w) => ({ content: line(`Page ${w}`, 40, 800), resources: `<< /Font << /F1 ${HELV} >> >>` })));
    const doc = await openPdf(new BytesSource(data));
    const picked: [number, string][] = [];
    for await (const p of extractText(doc, { pages: [3, 1, 99] })) picked.push([p.pageIndex, p.text]);
    expect(picked).toEqual([
      [1, 'Page two'],
      [3, 'Page four'],
    ]);
    expect(await extractAllText(doc)).toBe('Page one\fPage two\fPage three\fPage four');
    expect(await extractAllText(doc, { pages: [] })).toBe('');
    const ac = new AbortController();
    ac.abort();
    await expect(extractAllText(doc, { signal: ac.signal })).rejects.toThrow();
  });

  test('encrypted documents are refused', async () => {
    const f = availableFixtures().find((x) => x.expect.encrypted)!;
    const doc = await openPdf(new BytesSource(await fixtureBytes(f)));
    await expect(extractAllText(doc)).rejects.toBeInstanceOf(PdfEncryptedError);
  });

  test('huge pages and form bombs are bounded', async () => {
    // 150 000 glyphs in 30 000 show operations.
    let content = 'BT /F1 8 Tf 10 TL 20 830 Td\n';
    for (let i = 0; i < 30000; i++) content += i % 10 === 9 ? '(word) Tj T*\n' : '[(wo) 20 (rd) -300] TJ\n';
    content += 'ET';
    let t0 = performance.now();
    const [text] = await ours(handPdf(() => [{ content, resources: `<< /Font << /F1 ${HELV} >> >>` }]));
    expect(words(text).length).toBe(30000);
    expect(performance.now() - t0).toBeLessThan(10_000);
    // Each form draws the next one 10 times: 10^9 leaf invocations without the token budget.
    const bomb = handPdf((b) => {
      const nums = Array.from({ length: 10 }, () => b.alloc());
      nums.forEach((n, i) => {
        const body = i === nums.length - 1 ? line('leaf', 10, 10) : '/X Do '.repeat(10);
        const res = i === nums.length - 1 ? `<< /Font << /F1 ${HELV} >> >>` : `<< /XObject << /X ${nums[i + 1]} 0 R >> >>`;
        b.setStream(n, `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources ${res}`, bytes(body));
      });
      return [{ content: '/X Do', resources: `<< /XObject << /X ${nums[0]} 0 R >> >>` }];
    });
    t0 = performance.now();
    const [leaves] = await ours(bomb);
    expect(leaves.startsWith('leaf')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  test('fuzzed documents never throw from extraction', async () => {
    const base = handPdf(
      (b) => {
        const form = b.stream(`/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F2 ${COURIER} >> >>`, bytes(line('form text', 1, 1, 'F2')));
        return [
          {
            content:
              line('Fuzz target text', 40, 800) +
              `/Span << /ActualText (act) >> BDC ${line('x', 1, 1)} EMC q 1 0 0 1 5 300 cm /Fm Do Q BI /W 4 /H 1 /CS /G /BPC 8 ID abcd EI\n` +
              'BT /T0 10 Tf 40 700 Td <0041004200430044> Tj [<0045> -300 <0046>] TJ ET',
            resources:
              `<< /Font << /F1 ${HELV} /T0 << /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [<< /W [65 [500 600]] >>] ` +
              `/ToUnicode ${b.stream('', bytes('begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0041> <0046> <0061> endbfrange'))} 0 R >> >> /XObject << /Fm ${form} 0 R >> >>`,
          },
        ];
      },
      true,
    );
    expect(await ours(base)).toEqual(['Fuzz target text\nact\nform text\nabcde f']);
    const rng = new Rng(42);
    for (let iter = 0; iter < 150; iter++) {
      const data = base.slice(0, iter % 10 === 0 ? rng.int(100, base.length) : base.length);
      for (let k = rng.int(1, 12); k > 0; k--) data[rng.int(0, data.length - 1)] = rng.int(0, 255);
      let doc;
      try {
        doc = await openPdf(new BytesSource(data));
      } catch {
        continue;
      }
      const text = await extractAllText(doc);
      expect(typeof text).toBe('string');
    }
  });
});

describe('glyph names and CMaps', () => {
  test('glyph names', () => {
    const cases: Record<string, string | undefined> = {
      A: 'A', Aacute: 'Á', Scommaaccent: 'Ș', Gcommaaccent: 'Ģ', Idotaccent: 'İ', Ohungarumlaut: 'Ő', aringacute: 'ǻ', Ecircumflexacute: 'Ế',
      AE: 'Æ', germandbls: 'ß', fi: 'fi', ffl: 'ffl', f_f_i: 'ffi', 'a.sc': 'a', Asmall: 'a', zerooldstyle: '0', 'uni0041.alt': 'A',
      uni00410042: 'AB', u1F600: String.fromCodePoint(0x1f600), alpha: 'α', Omega: 'Ω', sigma1: 'ς', Alphatonos: 'Ά', iotadieresistonos: 'ΐ',
      Deltagreek: 'Δ', afii10017: 'А', afii10023: 'Ё', afii10071: 'ё', afii10097: 'я', afii10145: 'Џ', Iocyrillic: 'Ё', iacyrillic: 'я',
      quotedblleft: '“', Euro: '€', space: ' ', zero: '0', nine: '9', '.notdef': undefined, g65: undefined, foo: undefined, cyrillic: undefined,
    };
    for (const [name, want] of Object.entries(cases)) expect([name, glyphText(name)]).toEqual([name, want]);
  });

  test('ToUnicode CMaps: codespaces, bfchar, bfrange (incl. arrays), surrogates, multiple characters', () => {
    const cm = parseCMap(
      bytes(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /Base usecmap /WMode 1 def\n' +
          '3 begincodespacerange <00> <80> <8140> <9FFC> <A0A0A0A0> <A0FFFFFF> endcodespacerange\n' +
          '2 beginbfchar <41> <0042> <8141> <D83DDE00> endbfchar\n' +
          '3 beginbfrange <8150> <8152> [<0061> <00620063> <>] <A0A00000> <A0FFFFFF> <4E00> <60> <62> <0078> endbfrange\n' +
          '1 begincidrange <8140> <817E> 633 endcidrange\n' +
          '2 beginbfrange <70> <71> 5 <72> <72> <0021> endbfrange\n' +
          'endcmap',
      ),
    );
    expect(cm.use).toBe('Base');
    expect(cm.vertical).toBe(true);
    expect(lookup(cm, 0x41)).toBe('B');
    expect(lookup(cm, 0x8141)).toBe(String.fromCodePoint(0x1f600));
    expect([0x8150, 0x8151, 0x8152].map((c) => lookup(cm, c))).toEqual(['a', 'bc', '']);
    expect(lookup(cm, 0xa0a00005)).toBe('丅');
    expect(lookup(cm, 0x61)).toBe('y');
    expect(lookup(cm, 0x8145)).toBe(638);
    expect(lookup(cm, 0x99)).toBeUndefined();
    expect(lookup(cm, 0x72)).toBe('!'); // entries stay aligned after a malformed one
    const b = Uint8Array.of(0x41, 0x81, 0x41, 0xa0, 0xa1, 0xb0, 0xc5, 0xff);
    expect([codeLength(cm, b, 0), codeLength(cm, b, 1), codeLength(cm, b, 3), codeLength(cm, b, 7)]).toEqual([1, 2, 4, 0]);
  });
});
