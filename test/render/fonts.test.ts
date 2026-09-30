/**
 * Embedded font parsers (src/render/fonts): real fonts from the system when installed (skipped
 * otherwise), synthetic fonts for rare features, MuPDF renderings for a visual cross-check, and
 * damaged data.
 */
import { describe, expect, test } from 'bun:test';
import { parseCFF } from '../../src/render/fonts/cff.ts';
import { CLOSE, CUBIC, LINE, MOVE, QUAD, transformOutline, type FontProgram, type Matrix, type Outline } from '../../src/render/fonts/program.ts';
import { cffStrings, expertEncoding, predefinedCharset, standardEncoding } from '../../src/render/fonts/standard.ts';
import { parseTrueType } from '../../src/render/fonts/truetype.ts';
import { parseType1 } from '../../src/render/fonts/type1.ts';
import { bytes, concatBytes, find } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import {
  be,
  charstring,
  compareWithMupdf,
  controlBox,
  decrypt,
  hex,
  pfb,
  read,
  readAfm,
  readCff,
  sfnt,
  sfntTable,
  simpleFont,
  simpleGlyph,
  type0Font,
  wellFormed,
  writeCff,
  writeType1,
  type CffSpec,
  type Point,
} from './font-helpers.ts';

const TT = '/usr/share/fonts/truetype';
const OT = '/usr/share/fonts/opentype';
const T1 = '/usr/share/fonts/type1/urw-base35';
const liberation = read(`${TT}/liberation/LiberationSans-Regular.ttf`);
const freeSerif = read(`${TT}/freefont/FreeSerif.ttf`);
const ipag = read(`${OT}/ipafont-gothic/ipag.ttf`);
const nimbusOtf = read(`${OT}/urw-base35/NimbusSans-Regular.otf`);
const nimbusT1 = read(`${T1}/NimbusSans-Regular.t1`);
const romanT1 = read(`${T1}/NimbusRoman-Regular.t1`);
const romanOtf = read(`${OT}/urw-base35/NimbusRoman-Regular.otf`);
const loma = read(`${OT}/tlwg/Loma.otf`);
const unifont = read(`${OT}/unifont/unifont_csur.otf`) ?? read(`${OT}/unifont/unifont.otf`);
const nimbusCff = nimbusOtf && sfntTable(nimbusOtf, 'CFF ')!.slice();

const cmap31 = (f: FontProgram) => f.cmaps!.find((c) => c.platform === 3 && c.encoding === 1)!;
const scaled = (o: Outline, s: number): Outline => transformOutline(o, [s, 0, 0, s, 0, 0]);
const close = (a: number[], b: number[], eps = 1e-6): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

describe('standard tables', () => {
  test('CFF standard strings', () => {
    const s = cffStrings();
    expect(s.length).toBe(391);
    expect(new Set(s).size).toBe(391);
    const at = [0, 1, 8, 17, 26, 34, 59, 65, 66, 91, 104, 149, 150, 170, 171, 228, 229, 239, 248, 274, 299, 333, 342, 378, 379, 390];
    expect(at.map((i) => s[i])).toEqual([
      '.notdef', 'space', 'quoteright', 'zero', 'nine', 'A', 'Z', 'quoteleft', 'a', 'z', 'quotesingle', 'germandbls', 'onesuperior',
      'copyright', 'Aacute', 'zcaron', 'exclamsmall', 'zerooldstyle', 'nineoldstyle', 'Asmall', 'Zsmall', 'zeroinferior',
      'nineinferior', 'Ydieresissmall', '001.000', 'Semibold',
    ]);
  });

  test('StandardEncoding and the expert encoding', () => {
    const e: (string | undefined)[] = standardEncoding();
    expect([e[32], e[39], e[65], e[96], e[126], e[161], e[164], e[174], e[193], e[208], e[225], e[251]]).toEqual([
      'space', 'quoteright', 'A', 'quoteleft', 'asciitilde', 'exclamdown', 'fraction', 'fi', 'grave', 'emdash', 'AE', 'germandbls',
    ]);
    expect([e[0], e[31], e[127], e[160], e[176], e[252]]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(e.filter(Boolean).length).toBe(149);
    const x: (string | undefined)[] = expertEncoding();
    expect([x[32], x[33], x[35], x[48], x[65], x[97], x[122], x[188], x[200], x[255]]).toEqual([
      'space', 'exclamsmall', undefined, 'zerooldstyle', 'asuperior', 'Asmall', 'Zsmall', 'onequarter', 'zerosuperior', 'Ydieresissmall',
    ]);
    expect(x.filter(Boolean).length).toBe(165);
  });

  test('predefined charsets', () => {
    const s = cffStrings();
    expect(predefinedCharset(0).length).toBe(229);
    const expert = predefinedCharset(1).map((i) => s[i]);
    expect(expert.length).toBe(166);
    expect(expert.slice(0, 4)).toEqual(['.notdef', 'space', 'exclamsmall', 'Hungarumlautsmall']);
    expect(expert.at(-1)).toBe('Ydieresissmall');
    const subset = predefinedCharset(2).map((i) => s[i]);
    expect(subset.length).toBe(87);
    expect(subset.slice(0, 4)).toEqual(['.notdef', 'space', 'dollaroldstyle', 'dollarsuperior']);
    expect(subset.at(-1)).toBe('commainferior');
  });
});

// ---------------------------------------------------------------------------------------------
// TrueType

const head = (upem = 1000, long = false): Uint8Array => {
  const b = new Uint8Array(54);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x10000);
  dv.setUint32(12, 0x5f0f3cf5);
  dv.setUint16(18, upem);
  dv.setInt16(50, long ? 1 : 0);
  return b;
};

interface TtfSpec {
  glyphs: Uint8Array[];
  long?: boolean;
  upem?: number;
  cmap?: Uint8Array;
  post?: Uint8Array;
  advances?: number[];
  /** Tables to leave out. */
  omit?: string[];
  /** Override loca offsets. */
  loca?: number[];
}

function ttf(s: TtfSpec): Uint8Array {
  const offs = [0];
  for (const g of s.glyphs) offs.push(offs.at(-1)! + ((g.length + 1) & ~1));
  const loca = s.loca ?? offs;
  const glyf = concatBytes(s.glyphs.map((g) => concatBytes([g, new Uint8Array(g.length & 1)])));
  const adv = s.advances ?? [];
  const tables: Record<string, Uint8Array> = {
    head: head(s.upem, s.long),
    maxp: be([0x5000, 4], [s.glyphs.length, 2]),
    loca: be(...loca.map((o): [number, number] => (s.long ? [o, 4] : [o / 2, 2]))),
    glyf,
    hhea: concatBytes([new Uint8Array(34), be([adv.length, 2])]),
    hmtx: be(...adv.flatMap((a): [number, number][] => [[a, 2], [0, 2]])),
  };
  if (s.cmap) tables.cmap = s.cmap;
  if (s.post) tables.post = s.post;
  for (const t of s.omit ?? []) delete tables[t];
  return sfnt(tables);
}

const square: Point[] = [[0, 0, true], [100, 0, true], [100, 100, true], [0, 100, true]];
const F2 = (v: number): [number, number] => [Math.round(v * 16384) & 0xffff, 2];

/** A composite component: flags, glyph, arguments and transform. */
function component(flags: number, glyph: number, args: [number, number], transform: number[] = []): Uint8Array {
  const words = flags & 1;
  return be([flags, 2], [glyph, 2], [args[0] & (words ? 0xffff : 0xff), words ? 2 : 1], [args[1] & (words ? 0xffff : 0xff), words ? 2 : 1], ...transform.map(F2));
}
const composite = (...parts: Uint8Array[]): Uint8Array => concatBytes([be([-1 & 0xffff, 2], [0, 8]), ...parts]);

describe('TrueType', () => {
  test('simple glyphs: on and off-curve points, repeated flags, long and short coordinates', () => {
    const f = parseTrueType(
      ttf({
        glyphs: [
          new Uint8Array(0),
          simpleGlyph([square, [[300, 0, true], [1300, 0, true], [1300, -2000, true]]]),
          // Starts off-curve, ends on-curve.
          simpleGlyph([[[50, 0, false], [100, 50, true], [50, 100, false], [0, 50, true]]]),
          // All off-curve: starts between the first and last points.
          simpleGlyph([[[0, 0, false], [100, 0, false], [100, 100, false], [0, 100, false]]]),
        ],
        upem: 2048,
        advances: [500, 600],
      }),
    );
    expect(f.kind).toBe('truetype');
    expect(f.glyphCount).toBe(4);
    expect(f.matrix).toEqual([1 / 2048, 0, 0, 1 / 2048, 0, 0]);
    expect(f.outline(0)).toEqual([]);
    expect(f.outline(1)).toEqual([
      MOVE, 0, 0, LINE, 100, 0, LINE, 100, 100, LINE, 0, 100, CLOSE,
      MOVE, 300, 0, LINE, 1300, 0, LINE, 1300, -2000, CLOSE,
    ]);
    expect(f.outline(2)).toEqual([MOVE, 0, 50, QUAD, 50, 0, 100, 50, QUAD, 50, 100, 0, 50, CLOSE]);
    expect(f.outline(3)).toEqual([MOVE, 0, 50, QUAD, 0, 0, 50, 0, QUAD, 100, 0, 100, 50, QUAD, 100, 100, 50, 100, QUAD, 0, 100, 0, 50, CLOSE]);
    expect([f.advance!(0), f.advance!(1), f.advance!(3), f.advance!(4)]).toEqual([500, 600, 600, undefined]);
    expect([f.outline(-1), f.outline(4), f.outline(1.5)]).toEqual([[], [], []]);
  });

  test('composite glyphs: offsets, scales, 2x2 transforms, nesting, point matching, cycles', () => {
    const sq = [MOVE, 0, 0, LINE, 100, 0, LINE, 100, 100, LINE, 0, 100, CLOSE];
    const glyphs = [
      new Uint8Array(0),
      simpleGlyph([square]),
      // Word offsets (MORE_COMPONENTS), then a uniform scale with byte offsets.
      composite(component(0x1 | 0x2 | 0x20, 1, [1000, -300]), component(0x2 | 0x8, 1, [-5, 7], [0.5])),
      // x/y scale, then 2x2 rotation with SCALED_COMPONENT_OFFSET.
      composite(component(0x2 | 0x40 | 0x20, 1, [0, 0], [1.5, 0.25]), component(0x2 | 0x80 | 0x800, 1, [10, 0], [0, 1, -1, 0])),
      // Nested composite, point matching (approximated without offset).
      composite(component(0x1 | 0x2 | 0x20, 2, [0, 500]), component(0x0, 1, [3, 4])),
      // Cycles and self-references end at the nesting limit.
      composite(component(0x2 | 0x20, 1, [0, 0]), component(0x2, 5, [1, 1])),
    ];
    const f = parseTrueType(ttf({ glyphs }));
    const t = (m: Matrix): Outline => transformOutline(sq, m);
    expect(f.outline(2)).toEqual([...t([1, 0, 0, 1, 1000, -300]), ...t([0.5, 0, 0, 0.5, -5, 7])]);
    expect(f.outline(3)).toEqual([...t([1.5, 0, 0, 0.25, 0, 0]), ...t([0, 1, -1, 0, 0, 10])]);
    expect(f.outline(4)).toEqual([...transformOutline(f.outline(2), [1, 0, 0, 1, 0, 500]), ...sq]);
    const cyc = f.outline(5);
    expect(wellFormed(cyc)).toBe(true);
    expect(cyc.slice(0, sq.length)).toEqual(sq);
  });

  test('cmap formats 0, 2, 4, 6, 10, 12 and 13', () => {
    const sub = (platform: number, encoding: number, body: Uint8Array) => ({ platform, encoding, body });
    const f0 = new Uint8Array(262);
    f0.set(be([0, 2], [262, 2], [0, 2]));
    f0[6 + 0x41] = 1;
    const keys = new Uint8Array(512);
    keys.set(be([8, 2]), 2 * 0x81);
    const f2 = concatBytes([
      be([2, 2], [6 + 512 + 16 + 6, 2], [0, 2]),
      keys,
      be([0x20, 2], [1, 2], [0, 2], [10, 2]), // subHeader 0: single bytes, code 0x20
      be([0x40, 2], [2, 2], [3, 2], [4, 2]), // subHeader 1: 0x8140, 0x8141, delta 3
      be([1, 2], [2, 2], [3, 2]),
    ]);
    const f4 = be(
      [4, 2], [16 + 4 * 6 + 4, 2], [0, 2], [6, 2], [0, 2], [0, 2], [0, 2],
      [0x43, 2], [0x62, 2], [0xffff, 2], [0, 2],
      [0x41, 2], [0x61, 2], [0xffff, 2],
      [(1 - 0x41) & 0xffff, 2], [0, 2], [1, 2],
      [0, 2], [4, 2], [0, 2],
      [4, 2], [0, 2],
    );
    const f6 = be([6, 2], [14, 2], [0, 2], [0x30, 2], [2, 2], [6, 2], [7, 2]);
    const f10 = be([10, 2], [0, 2], [24, 4], [0, 4], [0x10000, 4], [2, 4], [8, 2], [9, 2]);
    const f12 = be([12, 2], [0, 2], [28, 4], [0, 4], [1, 4], [0x1f600, 4], [0x1f602, 4], [10, 4]);
    const f13 = be([13, 2], [0, 2], [28, 4], [0, 4], [1, 4], [0x20000, 4], [0x2ffff, 4], [11, 4]);
    const subs = [sub(1, 0, f0), sub(3, 3, f2), sub(3, 1, f4), sub(1, 1, f6), sub(3, 10, f10), sub(0, 4, f12), sub(0, 5, f13), sub(9, 9, be([99, 2]))];
    let off = 4 + 8 * subs.length;
    const recs = subs.map((s) => {
      const r = be([s.platform, 2], [s.encoding, 2], [off, 4]);
      off += s.body.length;
      return r;
    });
    const cmap = concatBytes([be([0, 2], [subs.length, 2]), ...recs, ...subs.map((s) => s.body)]);
    const f = parseTrueType(ttf({ glyphs: Array.from({ length: 12 }, () => simpleGlyph([square])), cmap }));
    const c = f.cmaps!;
    expect(c.map((t) => [t.platform, t.encoding])).toEqual(subs.slice(0, 7).map((s) => [s.platform, s.encoding]));
    const look = (i: number, codes: number[]) => codes.map((k) => c[i].lookup(k));
    expect(look(0, [0x41, 0x42, 300, -1])).toEqual([1, -1, -1, -1]);
    expect(look(1, [0x20, 0x21, 0x8140, 0x8141, 0x8142, 0x81, 0x8240])).toEqual([1, -1, 5, 6, -1, -1, -1]);
    expect(look(2, [0x40, 0x41, 0x43, 0x61, 0x62, 0x63, 0xffff, 0x10000])).toEqual([-1, 1, 3, 4, -1, -1, -1, -1]);
    expect(look(3, [0x2f, 0x30, 0x31, 0x32])).toEqual([-1, 6, 7, -1]);
    expect(look(4, [0xffff, 0x10000, 0x10001, 0x10002])).toEqual([-1, 8, 9, -1]);
    expect(look(5, [0x1f5ff, 0x1f600, 0x1f602, 0x1f603])).toEqual([-1, 10, 12, -1]);
    expect(look(6, [0x20000, 0x2abcd, 0x30000])).toEqual([11, 11, -1]);
  });

  test('post table names (formats 1 and 2)', () => {
    const glyphs = Array.from({ length: 258 }, () => new Uint8Array(0));
    const f1 = parseTrueType(ttf({ glyphs, post: concatBytes([be([0x10000, 4]), new Uint8Array(28)]) }));
    const names = ['.notdef', '.null', 'nonmarkingreturn', 'space', 'quotesingle', 'A', 'grave', 'Adieresis', 'apple', 'Ydieresis', 'dcroat'];
    expect(names.map((n) => f1.gidForName(n))).toEqual([0, 1, 2, 3, 10, 36, 67, 98, 210, 187, 257]);
    expect(f1.gidForName('nonexistent')).toBe(-1);
    const post2 = concatBytes([be([0x20000, 4]), new Uint8Array(28), be([5, 2], [0, 2], [36, 2], [258, 2], [259, 2], [36, 2]), new Uint8Array([4]), bytes('uni1'), new Uint8Array([3]), bytes('f_i')]);
    const f2 = parseTrueType(ttf({ glyphs: glyphs.slice(0, 5), post: post2 }));
    expect(['.notdef', 'A', 'uni1', 'f_i', 'B'].map((n) => f2.gidForName(n))).toEqual([0, 1, 2, 3, -1]);
  });

  test('damaged fonts: missing tables, bad loca, truncated glyphs', () => {
    const glyphs = [new Uint8Array(0), simpleGlyph([square]), simpleGlyph([square])];
    // No head (default upem, loca format guessed), maxp, hhea, hmtx, cmap or post.
    const bare = parseTrueType(ttf({ glyphs, omit: ['head', 'maxp', 'hhea', 'hmtx'] }));
    expect(bare.matrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    expect(bare.glyphCount).toBe(3);
    expect(bare.outline(2).length).toBe(13);
    expect(bare.advance).toBeUndefined();
    expect(bare.cmaps).toEqual([]);
    expect(bare.gidForName('A')).toBe(-1);
    const long = parseTrueType(ttf({ glyphs, long: true, omit: ['head'] }));
    expect(long.outline(2).length).toBe(13);
    // loca past glyf (the glyph ends with the table), decreasing, and a glyph cut short.
    const g = simpleGlyph([square]);
    const bad = parseTrueType(ttf({ glyphs: [g, g, g], loca: [0, 100000, 22, 37] }));
    expect(bad.outline(0)).toEqual(parseTrueType(ttf({ glyphs: [g] })).outline(0));
    expect(bad.outline(1)).toEqual([]);
    expect(bad.outline(2)).toEqual([]);
    // The last glyph runs past the declared end of glyf.
    const short = ttf({ glyphs: [g, g] });
    const dir = new DataView(short.buffer);
    for (let i = 0; i < dir.getUint16(4); i++) if (String.fromCharCode(...short.subarray(12 + 16 * i, 16 + 16 * i)) === 'glyf') dir.setUint32(12 + 16 * i + 12, 30);
    expect(parseTrueType(short).outline(1)).toEqual(bare.outline(2));
    expect(() => parseTrueType(ttf({ glyphs, omit: ['glyf'] }))).toThrow(Error);
    expect(() => parseTrueType(new Uint8Array(8))).toThrow(Error);
  });

  test('OpenType with CFF outlines and TrueType collections', () => {
    const cff = writeCff({ charstrings: [charstring(2, 'endchar'), charstring(2, 0, 0, 'rmoveto', 10, 0, 'rlineto', 'endchar')], charset: { format: 0, ids: [34] } });
    const cmap = concatBytes([be([0, 2], [1, 2], [3, 2], [1, 2], [12, 4]), be([6, 2], [12, 2], [0, 2], [0x41, 2], [1, 2], [1, 2])]);
    const otf = sfnt({ 'CFF ': cff, cmap, head: head(1000), hhea: concatBytes([new Uint8Array(34), be([2, 2])]), hmtx: be([250, 2], [0, 2], [700, 2], [0, 2]) }, 0x4f54544f);
    const f = parseTrueType(otf);
    expect(f.kind).toBe('cff');
    expect(f.glyphCount).toBe(2);
    expect(f.cmaps![0].lookup(0x41)).toBe(1);
    expect(f.outline(1)).toEqual([MOVE, 0, 0, LINE, 10, 0, CLOSE]);
    expect(f.gidForName('A')).toBe(1);
    expect(f.advance!(1)).toBe(700);

    const ttc = (font: Uint8Array): Uint8Array => {
      const d = font.slice();
      const dv = new DataView(d.buffer);
      for (let i = 0; i < dv.getUint16(4); i++) dv.setUint32(12 + 16 * i + 8, dv.getUint32(12 + 16 * i + 8) + 16);
      return concatBytes([bytes('ttcf'), be([0x10000, 4], [1, 4], [16, 4]), d]);
    };
    const c = parseTrueType(ttc(otf));
    expect(c.outline(1)).toEqual(f.outline(1));
    // Mislabeled data: bare CFF as OpenType, OpenType as bare CFF.
    expect(parseTrueType(cff).outline(1)).toEqual(f.outline(1));
    expect(parseCFF(otf).outline(1)).toEqual(f.outline(1));
  });

  test.skipIf(!liberation)('Liberation Sans: cmap, post names, advances, composites', () => {
    const f = parseTrueType(liberation!);
    expect(f.kind).toBe('truetype');
    expect(f.matrix[0]).toBe(1 / 2048);
    expect(f.glyphCount).toBeGreaterThan(2000);
    const c = cmap31(f);
    // ASCII: glyph names from post agree with the cmap.
    for (let ch = 0x21; ch < 0x7f; ch++) {
      const g = c.lookup(ch);
      expect(g).toBeGreaterThan(0);
      expect(wellFormed(f.outline(g))).toBe(true);
      expect(f.outline(g).length).toBeGreaterThan(0);
    }
    expect(f.gidForName('A')).toBe(c.lookup(0x41));
    expect(f.gidForName('Eacute')).toBe(c.lookup(0xc9));
    expect(f.gidForName('space')).toBe(c.lookup(0x20));
    expect(f.outline(c.lookup(0x20))).toEqual([]);
    // Liberation Sans is metric-compatible with Helvetica.
    const afm = readAfm(`${T1}/NimbusSans-Regular.afm`);
    if (afm) {
      for (const [name, m] of afm) {
        const g = f.gidForName(name);
        if (m.code >= 32 && m.code < 127 && g > 0) expect(Math.abs((f.advance!(g)! * 1000) / 2048 - m.wx)).toBeLessThanOrEqual(1);
      }
    }
    // Composite glyphs: their control box is the glyf header's bounding box.
    const glyf = sfntTable(liberation!, 'glyf')!;
    const loca = sfntTable(liberation!, 'loca')!;
    const dv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
    const ldv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    let composites = 0;
    for (let g = 0; g < f.glyphCount; g++) {
      const at = ldv.getUint32(4 * g);
      if (ldv.getUint32(4 * g + 4) === at || dv.getInt16(at) >= 0) continue;
      composites++;
      const box = controlBox(f.outline(g)) ?? [0, 0, 0, 0];
      const expected = [2, 4, 6, 8].map((k) => dv.getInt16(at + k));
      expect(box.every((v, i) => Math.abs(v - expected[i]) <= 1)).toBe(true);
    }
    expect(composites).toBeGreaterThan(100);
  });

  test.skipIf(!ipag)('IPAGothic: CJK glyphs through a large cmap', () => {
    const f = parseTrueType(ipag!);
    expect(f.glyphCount).toBeGreaterThan(10000);
    const c = cmap31(f);
    for (const ch of '日本語の漢字とカタカナ、ひらがな。') {
      const g = c.lookup(ch.codePointAt(0)!);
      expect(g).toBeGreaterThan(0);
      expect(f.outline(g).length).toBeGreaterThan(10);
      expect(f.advance!(g)).toBe(2048);
    }
  });

  test.skipIf(!liberation)('Liberation Sans matches MuPDF', () => {
    const f = parseTrueType(liberation!);
    const c = cmap31(f);
    const gids = [...'Ag@&%Q8ÁéÇñŠßǺøœ€ﬁ'].map((ch) => c.lookup(ch.codePointAt(0)!)).filter((g) => g > 0);
    const r = compareWithMupdf((b) => type0Font(b, liberation!, 'FontFile2'), gids.map((g) => ({ code: hex(g, 2), outline: f.outline(g) })), f.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });

  test.skipIf(!liberation)('the MuPDF comparison notices wrong outlines', () => {
    const f = parseTrueType(liberation!);
    const c = cmap31(f);
    const [A, B, O] = [...'ABO'].map((ch) => c.lookup(ch.charCodeAt(0)));
    const o = f.outline(O);
    const wrong = [
      { code: hex(A, 2), outline: f.outline(B) },
      { code: hex(A, 2), outline: transformOutline(f.outline(A), [1, 0, 0, 1, 120, 0]) },
      // O without its counter
      { code: hex(O, 2), outline: o.slice(0, o.indexOf(CLOSE) + 1) },
    ];
    const r = compareWithMupdf((b) => type0Font(b, liberation!, 'FontFile2'), wrong, f.matrix);
    expect(Math.min(...r.mismatch)).toBeGreaterThan(0.1);
  });

  test.skipIf(!freeSerif)('FreeSerif matches MuPDF', () => {
    const f = parseTrueType(freeSerif!);
    const c = cmap31(f);
    const gids = [...'Rgå&ŵǻḈ∮ψЖ'].map((ch) => c.lookup(ch.codePointAt(0)!)).filter((g) => g > 0);
    const r = compareWithMupdf((b) => type0Font(b, freeSerif!, 'FontFile2'), gids.map((g) => ({ code: hex(g, 2), outline: f.outline(g) })), f.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });

  test.skipIf(!ipag)('IPAGothic matches MuPDF', () => {
    const f = parseTrueType(ipag!);
    const c = cmap31(f);
    const gids = [...'日本語漢字テスト'].map((ch) => c.lookup(ch.codePointAt(0)!));
    const r = compareWithMupdf((b) => type0Font(b, ipag!, 'FontFile2'), gids.map((g) => ({ code: hex(g, 2), outline: f.outline(g) })), f.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------------------------
// CFF

const cs2 = (...t: (number | string)[]): Uint8Array => charstring(2, ...t);

/** Glyph names (SIDs from 391) and charstrings of a font that uses every Type 2 operator. */
const OPS_GLYPHS: [string | number, Uint8Array][] = [
  ['.notdef', cs2('endchar')],
  [34, cs2(50, 10, 20, 'rmoveto', 30, 0, 'rlineto', 0, 30, 'rlineto', 'endchar')], // A
  [125, cs2(5, 10, 'hmoveto', 10, 20, 30, 'hlineto', 10, 5, 'vlineto', 'endchar')], // acute
  ['curves', cs2(0, 0, 'rmoveto', 10, 0, 10, 10, 0, 10, 'rrcurveto', 5, 10, 10, 10, 10, 'hhcurveto', 10, 10, 10, 10, 'vvcurveto', 10, 10, 10, 10, 'hvcurveto', 10, 10, 10, 10, 10, 10, 10, 10, 5, 'vhcurveto', 'endchar')],
  ['linecurve', cs2(0, 0, 'rmoveto', 10, 0, 10, 10, 0, 10, 5, 5, 'rcurveline', 5, 0, 0, 5, 10, 0, 10, 10, 0, 10, 'rlinecurve', 'endchar')],
  ['flexes', cs2(0, 0, 'rmoveto', 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 50, 'flex', 10, 10, 5, 10, 10, 10, 10, 'hflex', 10, 1, 10, 2, 10, 10, 10, 3, 10, 'hflex1', 10, 1, 10, 1, 10, 1, 10, 1, 10, 1, 7, 'flex1', 1, 10, 1, 10, 1, 10, 1, 10, 1, 10, 7, 'flex1', 'endchar')],
  // Mask bytes that would read as endchar if they weren't skipped.
  ['hints', cs2(10, 20, 30, 40, 'hstemhm', 5, 5, 'hintmask', 'mask:0e', 0, 0, 'rmoveto', 10, 0, 'rlineto', 'cntrmask', 'mask:0e', 0, 10, 'rlineto', 'endchar')],
  ['hints2', cs2(77, 1, 2, 3, 4, 5, 6, 'hstem', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 'vstem', 'hintmask', 'mask:0e0e', 0, 0, 'rmoveto', 10, 10, 'rlineto', 'endchar')],
  ['subrs', cs2(0, 0, 'rmoveto', -107, 'callsubr', -107, 'callgsubr', 'endchar')],
  ['recursion', cs2(0, 0, 'rmoveto', 5, 5, 'rlineto', -106, 'callsubr', 7, 7, 'rlineto', 'endchar')],
  ['fanout', cs2(0, 0, 'rmoveto', -106, 'callgsubr', 5, 5, 'rlineto', 'endchar')],
  ['arith', cs2(
    3, 4, 'add', 2, 'mul', 10, 3, 'sub', 'rmoveto', 1, 2, 'exch', 'sub', 0, 'rlineto', 5, 'dup', 'mul', 0, 'exch', 'rlineto',
    42, 0, 'put', 0, 'get', 0, 'rlineto', 1, 2, 3, 4, 'ifelse', 0, 'rlineto', 1, 2, 4, 3, 'ifelse', 0, 'rlineto',
    1, 2, 3, 1, 'index', 'rlineto', 1, 2, 3, 3, 1, 'roll', 'rlineto', 9, 'sqrt', 2, 'neg', 'rlineto', -4, 'abs', 4, 'eq', 0, 'rlineto',
    1, 1, 'and', 0, 1, 'or', 'rlineto', 10, 4, 'div', 0, 'rlineto', 1, 0, 'not', 7, 'drop', 'rlineto', 'random', 0, 'mul', 0, 'rlineto',
    2, 0, 'div', 3, 'rlineto', 'endchar',
  )],
  [171, cs2(600, 200, 100, 65, 194, 'endchar')], // Aacute = seac(A, acute)
  ['widthonly', cs2(55, 'endchar')],
  ['fixed', cs2(0, 0, 'rmoveto', 1.5, 2.25, 'rlineto', 2000, -3000, 'rlineto', 'endchar')],
  ['moves', cs2(0, 0, 'rmoveto', 10, 0, 'rlineto', 20, 'vmoveto', 5, 0, 'rlineto', 'endchar')],
  ['badsubr', cs2(0, 0, 'rmoveto', 1000, 'callsubr', 5, 5, 'rlineto', 'endchar')],
  ['nan', cs2(0, 0, 'rmoveto', -1, 'sqrt', 0, 'rlineto', 'endchar')],
  ['nomove', cs2(10, 0, 'rlineto', 0, 10, 'rlineto', 'endchar')],
];

function opsFont(extra: Partial<CffSpec> = {}): FontProgram {
  const strings = OPS_GLYPHS.map((g) => g[0]).filter((n): n is string => typeof n === 'string' && n !== '.notdef');
  return parseCFF(
    writeCff({
      charstrings: OPS_GLYPHS.map((g) => g[1]),
      strings,
      charset: { format: 0, ids: OPS_GLYPHS.slice(1).map((g) => (typeof g[0] === 'number' ? g[0] : 391 + strings.indexOf(g[0]))) },
      gsubrs: [cs2(0, 10, 'rlineto', 'return'), cs2(...Array.from({ length: 8 }, () => [-106, 'callgsubr']).flat(), 'return')],
      private: { subrs: [cs2(10, 0, 'rlineto', 'return'), cs2(-106, 'callsubr', 'return')], defaultWidthX: 500, nominalWidthX: 100 },
      encoding: new Uint8Array([0x80, 2, 65, 194, 1, 200, 0, 171]),
      ...extra,
    }),
  );
}

describe('CFF', () => {
  test('Type 2 charstring operators', () => {
    const f = opsFont();
    expect(f.kind).toBe('cff');
    expect(f.matrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    expect(f.glyphCount).toBe(OPS_GLYPHS.length);
    const o = (name: string): Outline => f.outline(f.gidForName(name));
    const w = (name: string): number | undefined => f.advance!(f.gidForName(name));
    const A = [MOVE, 10, 20, LINE, 40, 20, LINE, 40, 50, CLOSE];
    const acute = [MOVE, 10, 0, LINE, 20, 0, LINE, 20, 20, LINE, 50, 20, LINE, 50, 30, LINE, 55, 30, CLOSE];
    expect(f.outline(0)).toEqual([]);
    expect([o('A'), w('A')]).toEqual([A, 150]);
    expect([o('acute'), w('acute')]).toEqual([acute, 105]);
    expect([o('curves'), w('curves')]).toEqual([
      [MOVE, 0, 0, CUBIC, 10, 0, 20, 10, 20, 20, CUBIC, 30, 25, 40, 35, 50, 35, CUBIC, 50, 45, 60, 55, 60, 65, CUBIC, 70, 65, 80, 75, 80, 85,
        CUBIC, 80, 95, 90, 105, 100, 105, CUBIC, 110, 105, 120, 115, 125, 125, CLOSE],
      500,
    ]);
    expect(o('linecurve')).toEqual([MOVE, 0, 0, CUBIC, 10, 0, 20, 10, 20, 20, LINE, 25, 25, LINE, 30, 25, LINE, 30, 30, CUBIC, 40, 30, 50, 40, 50, 50, CLOSE]);
    expect(o('flexes')).toEqual([
      MOVE, 0, 0, CUBIC, 10, 0, 20, 0, 30, 0, CUBIC, 40, 0, 50, 0, 60, 0, CUBIC, 70, 0, 80, 5, 90, 5, CUBIC, 100, 5, 110, 0, 120, 0,
      CUBIC, 130, 1, 140, 3, 150, 3, CUBIC, 160, 3, 170, 6, 180, 0, CUBIC, 190, 1, 200, 2, 210, 3, CUBIC, 220, 4, 230, 5, 237, 0,
      CUBIC, 238, 10, 239, 20, 240, 30, CUBIC, 241, 40, 242, 50, 237, 57, CLOSE,
    ]);
    expect([o('hints'), w('hints')]).toEqual([[MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, CLOSE], 500]);
    expect([o('hints2'), w('hints2')]).toEqual([[MOVE, 0, 0, LINE, 10, 10, CLOSE], 177]);
    expect(o('subrs')).toEqual([MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, CLOSE]);
    expect(o('recursion')).toEqual([MOVE, 0, 0, LINE, 5, 5, CLOSE]);
    const t = performance.now();
    expect(wellFormed(o('fanout'))).toBe(true);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(o('arith')).toEqual([
      MOVE, 14, 7, LINE, 15, 7, LINE, 15, 32, LINE, 57, 32, LINE, 58, 32, LINE, 60, 32, LINE, 61, 34, LINE, 64, 36, LINE, 67, 37,
      LINE, 70, 35, LINE, 71, 35, LINE, 72, 36, LINE, 74.5, 36, LINE, 75.5, 37, LINE, 75.5, 37, LINE, 75.5, 40, CLOSE,
    ]);
    expect([o('Aacute'), w('Aacute')]).toEqual([[...A, ...transformOutline(acute, [1, 0, 0, 1, 200, 100])], 700]);
    expect([o('widthonly'), w('widthonly')]).toEqual([[], 155]);
    expect(o('fixed')).toEqual([MOVE, 0, 0, LINE, 1.5, 2.25, LINE, 2001.5, -2997.75, CLOSE]);
    expect(o('moves')).toEqual([MOVE, 0, 0, LINE, 10, 0, CLOSE, MOVE, 10, 20, LINE, 15, 20, CLOSE]);
    expect(o('badsubr')).toEqual([MOVE, 0, 0, CLOSE]);
    expect(o('nan')).toEqual([]);
    expect(o('nomove')).toEqual([MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, CLOSE]);
    expect([f.outline(-1), f.outline(OPS_GLYPHS.length), f.advance!(-1)]).toEqual([[], [], undefined]);
  });

  test('encodings and charsets', () => {
    const f = opsFont();
    expect([f.encoding![65], f.encoding![194], f.encoding![200], f.encoding![66]]).toEqual(['A', 'acute', 'Aacute', undefined]);
    expect(f.gidForCid).toBeUndefined();
    expect(f.gidForName('.notdef')).toBe(0);
    expect(f.gidForName('nothing')).toBe(-1);
    const glyphs = Array.from({ length: 6 }, () => cs2('endchar'));
    const names = (spec: Partial<CffSpec>): (string | undefined)[] => {
      const g = parseCFF(writeCff({ charstrings: glyphs, ...spec }));
      const all = [...cffStrings(), ...(spec.strings ?? [])];
      return all.map((n) => (g.gidForName(n) > 0 ? `${g.gidForName(n)}:${n}` : undefined)).filter(Boolean);
    };
    expect(names({ charset: 0 })).toEqual(['1:space', '2:exclam', '3:quotedbl', '4:numbersign', '5:dollar']);
    expect(names({ charset: 1 })).toEqual(['1:space', '2:exclamsmall', '3:Hungarumlautsmall', '4:dollaroldstyle', '5:dollarsuperior']);
    expect(names({ charset: 2 })).toEqual(['1:space', '2:dollaroldstyle', '3:dollarsuperior', '4:parenleftsuperior', '5:parenrightsuperior']);
    for (const format of [0, 1, 2] as const) {
      expect(names({ charset: { format, ids: [34, 35, 36, 391, 392] }, strings: ['extra1', 'extra2'] })).toEqual(['1:A', '2:B', '3:C', '4:extra1', '5:extra2']);
    }
    // Encoding format 1 (ranges), predefined Standard and Expert.
    const enc1 = parseCFF(writeCff({ charstrings: glyphs, charset: { format: 1, ids: [34, 35, 36, 37, 38] }, encoding: new Uint8Array([1, 2, 97, 1, 120, 2]) }));
    expect(enc1.encoding!.map((n, c) => `${c}:${n}`).filter((s) => !s.endsWith('undefined'))).toEqual(['97:A', '98:B', '120:C', '121:D', '122:E']);
    const std = parseCFF(writeCff({ charstrings: glyphs, encoding: 0 }));
    expect(std.encoding).toEqual(standardEncoding());
    expect(std.encoding).not.toBe(standardEncoding());
    expect(parseCFF(writeCff({ charstrings: glyphs, encoding: 1 })).encoding![33]).toBe('exclamsmall');
  });

  test('subroutine bias for large subroutine counts', () => {
    for (const [count, bias] of [[1239, 107], [1240, 1131], [33900, 32768]]) {
      const subrs = Array.from({ length: count }, (_, i) => cs2(i % 100, 1, 'rlineto', 'return'));
      const f = parseCFF(writeCff({ charstrings: [cs2(0, 0, 'rmoveto', 57 - bias, 'callsubr', 'endchar')], private: { subrs } }));
      expect(f.outline(0)).toEqual([MOVE, 0, 0, LINE, 57, 1, CLOSE]);
    }
  });

  test('CID-keyed: FDSelect, per-FD private data and FontMatrix', () => {
    // Two FDs: the second with its own subroutines, widths and a FontMatrix twice as small.
    const sq = (w: number) => cs2(w, 0, 0, 'rmoveto', -107, 'callsubr', 'endchar');
    const fd0 = { subrs: [cs2(100, 0, 'rlineto', 0, 100, 'rlineto', 'return')], defaultWidthX: 1000, nominalWidthX: 0 };
    const fd1 = { subrs: [cs2(0, 50, 'rlineto', 'return')], defaultWidthX: 300, nominalWidthX: 10 };
    const glyphs = [cs2('endchar'), sq(600), sq(700), cs2(0, 0, 'rmoveto', -107, 'callsubr', 'endchar'), sq(200)];
    const fdSelect = [0, 0, 0, 1, 1];
    for (const format of [0, 3] as const) {
      for (const fontMatrix of [undefined, [1, 0, 0, 1, 0, 0]]) {
        const f = parseCFF(
          writeCff({
            charstrings: glyphs,
            charset: { format: 0, ids: [100, 103, 106, 109] },
            fontMatrix,
            cid: { fds: [{ private: fd0 }, { private: fd1, fontMatrix: [0.0005, 0, 0, 0.0005, 0, 0] }], fdSelect, format },
          }),
        );
        expect(f.matrix).toEqual(fontMatrix ? [1, 0, 0, 1, 0, 0] : [0.001, 0, 0, 0.001, 0, 0]);
        expect([0, 100, 103, 106, 109, 101, 5].map((c) => f.gidForCid!(c))).toEqual([0, 1, 2, 3, 4, -1, -1]);
        expect(f.encoding).toBeUndefined();
        expect(f.gidForName('.notdef')).toBe(0);
        // FD 0 has the top-level matrix. FD 1's glyph space is 0.0005 of text space: half the
        // units of the default matrix, or 0.0005 units of an explicit identity top matrix.
        const s0 = 1;
        const s1 = fontMatrix ? 0.0005 : 0.5;
        expect(f.outline(1)).toEqual(scaled([MOVE, 0, 0, LINE, 100, 0, LINE, 100, 100, CLOSE], s0));
        expect(close(f.outline(3), scaled([MOVE, 0, 0, LINE, 0, 50, CLOSE], s1))).toBe(true);
        expect([1, 2, 3, 4].map((g) => f.advance!(g)! / (g < 3 ? s0 : s1))).toEqual([600, 700, 300, 210]);
      }
    }
  });

  test('refuses unusable data', () => {
    expect(() => parseCFF(new Uint8Array(0))).toThrow(Error);
    expect(() => parseCFF(bytes('\x02\x00\x05\x00'))).toThrow(Error);
    expect(() => parseCFF(writeCff({ charstrings: [cs2('endchar')], charstringType: 1 }))).toThrow(Error);
    expect(() => parseCFF(writeCff({ charstrings: [] }))).toThrow(Error);
  });

  test.skipIf(!nimbusCff)('Nimbus Sans: names, advances and bounding boxes as in the AFM', () => {
    const f = parseCFF(nimbusCff!);
    expect(f.glyphCount).toBe(855);
    expect(f.encoding).toEqual(standardEncoding());
    const afm = readAfm(`${T1}/NimbusSans-Regular.afm`);
    if (!afm) return;
    for (const [name, m] of afm) {
      const g = f.gidForName(name);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(f.advance!(g)).toBe(m.wx);
      const o = f.outline(g);
      expect(wellFormed(o)).toBe(true);
      if (o.length) expect(controlBox(o)!.every((v, i) => Math.abs(v - m.bbox[i]) <= 1)).toBe(true);
    }
  });

  test.skipIf(!nimbusOtf || !nimbusCff)('OpenType wrapper: same outlines, cmaps, hmtx advances', () => {
    const o = parseTrueType(nimbusOtf!);
    const c = parseCFF(nimbusCff!);
    expect(o.kind).toBe('cff');
    expect(o.matrix).toEqual(c.matrix);
    const cmap = cmap31(o);
    for (const ch of 'AZaz09&@') {
      const g = cmap.lookup(ch.charCodeAt(0));
      expect(g).toBe(c.gidForName(standardEncoding()[ch.charCodeAt(0)]!));
      expect(o.outline(g)).toEqual(c.outline(g));
      expect(o.advance!(g)).toBe(c.advance!(g)!);
    }
  });

  test.skipIf(!loma)('Loma (Thai): cmap lookups and outlines', () => {
    const f = parseTrueType(loma!);
    const cmap = cmap31(f);
    for (const ch of 'กขคภาษาไทย') {
      const g = cmap.lookup(ch.codePointAt(0)!);
      expect(g).toBeGreaterThan(0);
      expect(f.outline(g).length).toBeGreaterThan(0);
      expect(f.advance!(g)).toBeGreaterThan(0);
    }
  });

  test.skipIf(!unifont)('Unifont: CID-keyed with an FD FontMatrix', () => {
    const f = parseTrueType(unifont!);
    const bare = parseCFF(sfntTable(unifont!, 'CFF ')!);
    expect(f.gidForCid).toBeDefined();
    expect(bare.matrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    let n = 0;
    for (let g = 1; g < f.glyphCount && n < 200; g += 37, n++) {
      const box = controlBox(bare.outline(g));
      // 16 x 16 pixel glyphs of 64 units (FontMatrix 1/64) scaled to 1000 units.
      if (box) expect(box.every((v) => v >= -1000 && v <= 2000 && Math.abs(v / 62.5 - Math.round(v / 62.5)) < 1e-6)).toBe(true);
      expect(Math.abs(f.advance!(g)! - bare.advance!(g)!)).toBeLessThan(1e-6);
      expect([500, 1000, 0]).toContain(Math.round(bare.advance!(g)!));
    }
  });

  test.skipIf(!nimbusCff)('Nimbus Sans CFF matches MuPDF', () => {
    const f = parseCFF(nimbusCff!);
    const names = ['A', 'g', 'at', 'ampersand', 'Aacute', 'Scaron', 'florin', 'fi', 'Q', 'percent', 'oe', 'section', 'eight', 'Oslash'];
    const r = compareWithMupdf((b) => simpleFont(b, nimbusCff!, 'Type1C', names), names.map((n, i) => ({ code: hex(i + 1), outline: f.outline(f.gidForName(n)) })), f.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });

  test.skipIf(!unifont)('Unifont CID-keyed CFF matches MuPDF', () => {
    const data = sfntTable(unifont!, 'CFF ')!;
    const f = parseCFF(data);
    const cids: number[] = [];
    for (let cid = 0x20; cid < 0x30000 && cids.length < 16; cid += 97) if (f.gidForCid!(cid) > 0 && f.outline(f.gidForCid!(cid)).length) cids.push(cid);
    expect(cids.length).toBe(16);
    const r = compareWithMupdf((b) => type0Font(b, data, 'CIDFontType0C'), cids.map((c) => ({ code: hex(c, 2), outline: f.outline(f.gidForCid!(c)) })), f.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });

  test.skipIf(!nimbusCff)('CID-keyed fonts with FD matrices match MuPDF', () => {
    // Nimbus Sans glyphs split over two FDs whose glyph spaces are 0.001 and 0.00075 of text
    // space: FD matrices alone, or concatenated with the top one.
    const src = readCff(nimbusCff!);
    const named = parseCFF(nimbusCff!);
    const names = ['A', 'B', 'g', 'at', 'ampersand', 'Q', 'R', 'S', 'five', 'Oslash'];
    const gids = [0, ...names.map((n) => named.gidForName(n))];
    const m = (s: number): number[] => [s, 0, 0, s, 0, 0];
    for (const [top, fd0, fd1] of [[undefined, undefined, m(0.00075)], [m(0.001), undefined, m(0.75)], [m(0.002), m(0.5), m(0.375)]]) {
      const data = writeCff({
        charstrings: gids.map((g) => src.charstrings[g]),
        gsubrs: src.gsubrs,
        charset: { format: 0, ids: gids.slice(1).map((_, i) => 10 + 2 * i) },
        fontMatrix: top,
        cid: { fds: [{ private: src.private, fontMatrix: fd0 }, { private: src.private, fontMatrix: fd1 }], fdSelect: gids.map((_, i) => i & 1), format: 3 },
      });
      const f = parseCFF(data);
      const placed = names.map((_, i) => ({ code: hex(10 + 2 * i, 2), outline: f.outline(f.gidForCid!(10 + 2 * i)) }));
      names.forEach((n, i) => {
        const s = ((i + 1) & 1 ? 0.00075 : 0.001) / f.matrix[0];
        expect(close(placed[i].outline, scaled(named.outline(named.gidForName(n)), s), 1e-9)).toBe(true);
      });
      const r = compareWithMupdf((b) => type0Font(b, data, 'CIDFontType0C'), placed, f.matrix);
      expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
    }
  });

  test('seac composition matches MuPDF', () => {
    const f = writeCff({
      charstrings: [
        cs2('endchar'),
        cs2(50, 0, 'rmoveto', 400, 0, 'rlineto', 0, 400, 'rlineto', -400, 0, 'rlineto', 'endchar'),
        cs2(30, 0, 'rmoveto', 200, 0, 'rlineto', -100, 150, 'rlineto', 'endchar'),
        cs2(100, 450, 65, 194, 'endchar'),
      ],
      charset: { format: 0, ids: [34, 125, 171] },
    });
    const p = parseCFF(f);
    const names = ['A', 'acute', 'Aacute'];
    const r = compareWithMupdf((b) => simpleFont(b, f, 'Type1C', names), names.map((n, i) => ({ code: hex(i + 1), outline: p.outline(p.gidForName(n)) })), p.matrix);
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------------------------
// Type 1

const cs1 = (...t: (number | string)[]): Uint8Array => charstring(1, ...t);

/** Subrs 0-3 are the standard flex and hint replacement ones. */
const T1_SUBRS = [
  cs1(3, 0, 'callothersubr', 'pop', 'pop', 'setcurrentpoint', 'return'),
  cs1(0, 1, 'callothersubr', 'return'),
  cs1(0, 2, 'callothersubr', 'return'),
  cs1('return'),
  cs1(10, 20, 'hstem', 'return'),
  cs1(100, 0, 'rlineto', -50, 100, 'rlineto', 'return'),
  cs1(6, 'callsubr', 'return'),
];
const flexMoves = [150, 25, -100, -25, 50, 25, 50, 0, 50, 0, 50, -25, 50, 0];
const T1_GLYPHS: Record<string, Uint8Array> = {
  '.notdef': cs1(0, 250, 'hsbw', 'endchar'),
  A: cs1(50, 600, 'hsbw', 0, 0, 'rmoveto', 400, 0, 'rlineto', 0, 400, 'rlineto', -400, 0, 'rlineto', 'closepath', 'endchar'),
  acute: cs1(30, 300, 'hsbw', 0, 0, 'rmoveto', 200, 0, 'rlineto', -100, 150, 'rlineto', 'closepath', 'endchar'),
  Aacute: cs1(80, 600, 'hsbw', 30, 100, 450, 65, 194, 'seac'),
  flexer: cs1(
    0, 500, 'hsbw', 0, 0, 'rmoveto', 1, 'callsubr',
    ...Array.from({ length: 7 }, (_, i) => [flexMoves[2 * i], flexMoves[2 * i + 1], 'rmoveto', 2, 'callsubr']).flat(),
    50, 300, 0, 0, 'callsubr', 0, 250, 'rlineto', -300, 0, 'rlineto', 'closepath', 'endchar',
  ),
  hinted: cs1(0, 400, 'hsbw', 4, 1, 3, 'callothersubr', 'pop', 'callsubr', 0, 0, 'rmoveto', 5, 'callsubr', 'closepath', 'endchar'),
  sbwdiv: cs1(10, 20, 300, 0, 'sbw', 0, 0, 'rmoveto', 700, 2, 'div', 0, 'rlineto', 0, 0, 0, 0, 0, 0, 'hstem3', 1, 1, 'vstem', 'dotsection', 0, 200, 'rlineto', 'closepath', 'endchar'),
  setpoint: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 300, 0, 'rlineto', 300, 300, 'setcurrentpoint', 0, 100, 'rlineto', 'closepath', 'endchar'),
  curves: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 0, 100, 50, 50, 100, 0, 'rrcurveto', -50, 50, -50, 50, 'vhcurveto', -50, -100, 0, -50, 'hvcurveto', 'closepath', 'endchar'),
  hv: cs1(0, 500, 'hsbw', 100, 'hmoveto', 200, 'hlineto', 200, 'vlineto', -200, 'hlineto', 'closepath', 50, 'vmoveto', 100, 0, 'rlineto', 0, 50, 'rlineto', 'closepath', 'endchar'),
  reopen: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 100, 0, 'rlineto', 0, 100, 'rlineto', 'closepath', 0, 100, 'rlineto', 100, 0, 'rlineto', 'closepath', 'endchar'),
  big: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 100000, 0, 'rlineto', 0, -70000, 'rlineto', 'closepath', 'endchar'),
  broken: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 99, 'callsubr', 5, 5, 'rlineto', 'endchar'),
  recursive: cs1(0, 500, 'hsbw', 0, 0, 'rmoveto', 10, 0, 'rlineto', 6, 'callsubr', 'endchar'),
};
const T1_EXPECTED: Record<string, Outline> = {
  '.notdef': [],
  A: [MOVE, 50, 0, LINE, 450, 0, LINE, 450, 400, LINE, 50, 400, CLOSE],
  acute: [MOVE, 30, 0, LINE, 230, 0, LINE, 130, 150, CLOSE],
  // The accent's origin goes to adx - asb from the composite's side bearing point.
  Aacute: [MOVE, 50, 0, LINE, 450, 0, LINE, 450, 400, LINE, 50, 400, CLOSE, MOVE, 180, 450, LINE, 380, 450, LINE, 280, 600, CLOSE],
  flexer: [MOVE, 0, 0, CUBIC, 50, 0, 100, 25, 150, 25, CUBIC, 200, 25, 250, 0, 300, 0, LINE, 300, 250, LINE, 0, 250, CLOSE],
  hinted: [MOVE, 0, 0, LINE, 100, 0, LINE, 50, 100, CLOSE],
  sbwdiv: [MOVE, 10, 20, LINE, 360, 20, LINE, 360, 220, CLOSE],
  setpoint: [MOVE, 0, 0, LINE, 300, 0, LINE, 300, 400, CLOSE],
  curves: [MOVE, 0, 0, CUBIC, 0, 100, 50, 150, 150, 150, CUBIC, 150, 100, 200, 50, 250, 50, CUBIC, 200, 50, 100, 50, 100, 0, CLOSE],
  hv: [MOVE, 100, 0, LINE, 300, 0, LINE, 300, 200, LINE, 100, 200, CLOSE, MOVE, 100, 250, LINE, 200, 250, LINE, 200, 300, CLOSE],
  // Drawing after closepath: relative to the current point, from the start of the closed subpath.
  reopen: [MOVE, 0, 0, LINE, 100, 0, LINE, 100, 100, CLOSE, MOVE, 0, 0, LINE, 100, 200, LINE, 200, 200, CLOSE],
  big: [MOVE, 0, 0, LINE, 100000, 0, LINE, 100000, -70000, CLOSE],
  broken: [MOVE, 0, 0, CLOSE],
  recursive: [MOVE, 0, 0, LINE, 10, 0, CLOSE],
};
const T1_ENCODING = { 65: 'A', 66: 'Aacute', 97: 'flexer', 194: 'acute' };
const t1Font = (extra: Partial<Parameters<typeof writeType1>[0]> = {}) => writeType1({ glyphs: T1_GLYPHS, subrs: T1_SUBRS, encoding: T1_ENCODING, ...extra });

/** Split a PFA-style font (cleartext, binary eexec part) after `eexec` and its line end. */
function splitType1(d: Uint8Array): [Uint8Array, Uint8Array] {
  let at = find(d, 'eexec') + 5;
  while (d[at] === 13 || d[at] === 10) at++;
  return [d.subarray(0, at), d.subarray(at)];
}

describe('Type 1', () => {
  test('charstring operators, flex, hint replacement, seac', () => {
    const f = parseType1(concatBytes(t1Font()));
    expect(f.kind).toBe('type1');
    expect(f.matrix).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    expect(f.glyphCount).toBe(Object.keys(T1_GLYPHS).length);
    for (const [name, o] of Object.entries(T1_EXPECTED)) expect([name, f.outline(f.gidForName(name))]).toEqual([name, o]);
    expect(['A', 'Aacute', 'sbwdiv', '.notdef'].map((n) => f.advance!(f.gidForName(n)))).toEqual([600, 600, 300, 250]);
    expect([f.encoding![65], f.encoding![66], f.encoding![97], f.encoding![98]]).toEqual(['A', 'Aacute', 'flexer', undefined]);
    expect([f.gidForName('nothing'), f.outline(-1), f.outline(1000), f.advance!(1000)]).toEqual([-1, [], [], undefined]);
  });

  test('containers: binary, hex, PFB, CR LF, lenIV, RD spellings, wrong /Length1', () => {
    const ref = parseType1(concatBytes(t1Font()));
    const same = (f: FontProgram): void => {
      expect(f.glyphCount).toBe(ref.glyphCount);
      for (let g = 0; g < f.glyphCount; g++) expect(f.outline(g)).toEqual(ref.outline(g));
      expect(f.encoding).toEqual(ref.encoding);
    };
    const [clear, secret, trailer] = t1Font();
    same(parseType1(concatBytes([clear, secret, trailer]), clear.length, secret.length));
    same(parseType1(concatBytes([clear, secret, trailer]), 17, 3));
    same(parseType1(concatBytes([clear, secret, trailer]), 1e9));
    same(parseType1(concatBytes(t1Font({ hex: true }))));
    same(parseType1(pfb(clear, secret, trailer)));
    same(parseType1(concatBytes([clear.subarray(0, -1), bytes('\r\n'), secret, trailer])));
    same(parseType1(concatBytes([clear.subarray(0, -1), bytes('\r'), secret, trailer])));
    same(parseType1(concatBytes(t1Font({ lenIV: 0 }))));
    same(parseType1(concatBytes(t1Font({ lenIV: -1 }))));
    same(parseType1(concatBytes(t1Font({ tokens: ['-|', '|-', '|'] }))));
    // Unencrypted private part.
    const plain = decrypt(secret, 55665);
    same(parseType1(concatBytes([clear.subarray(0, clear.length - 'currentfile eexec\n'.length), plain])));
    expect(() => parseType1(clear)).toThrow(Error);
    expect(() => parseType1(new Uint8Array(0))).toThrow(Error);
  });

  test('StandardEncoding and FontMatrix from the cleartext', () => {
    const f = parseType1(concatBytes(writeType1({ glyphs: T1_GLYPHS, subrs: T1_SUBRS, fontMatrix: '{0.002 0 0.0003 0.002 0 0}' })));
    expect(f.encoding).toEqual(standardEncoding());
    expect(f.matrix).toEqual([0.002, 0, 0.0003, 0.002, 0, 0]);
  });

  test.skipIf(!nimbusT1)('Nimbus Sans: names, advances and bounding boxes as in the AFM', () => {
    const f = parseType1(nimbusT1!);
    expect(f.glyphCount).toBe(855);
    expect(f.encoding).toEqual(standardEncoding());
    const afm = readAfm(`${T1}/NimbusSans-Regular.afm`);
    if (!afm) return;
    for (const [name, m] of afm) {
      const g = f.gidForName(name);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(f.advance!(g)).toBe(m.wx);
      const o = f.outline(g);
      expect(wellFormed(o)).toBe(true);
      if (o.length) expect(controlBox(o)!.every((v, i) => Math.abs(v - m.bbox[i]) <= 1)).toBe(true);
    }
  });

  test.skipIf(!nimbusT1)('Nimbus Sans as hex and PFB', () => {
    const f = parseType1(nimbusT1!);
    const [clear, rest] = splitType1(nimbusT1!);
    const hexed = concatBytes([clear, bytes(Array.from(rest, (b, i) => hex(b) + (i % 40 === 39 ? '\r\n' : '')).join(''))]);
    for (const v of [parseType1(hexed), parseType1(pfb(clear, rest, new Uint8Array(0))), parseType1(nimbusT1!, clear.length - 3)]) {
      for (let g = 0; g < f.glyphCount; g += 7) expect(v.outline(g)).toEqual(f.outline(g));
    }
  });

  test.skipIf(!romanT1 || !romanOtf)('the same design as Type 1 and CFF: identical outlines and advances', () => {
    const t = parseType1(romanT1!);
    const c = parseTrueType(romanOtf!);
    const afm = readAfm(`${T1}/NimbusRoman-Regular.afm`)!;
    for (const name of afm.keys()) {
      const a = t.gidForName(name);
      const b = c.gidForName(name);
      expect(t.outline(a)).toEqual(c.outline(b));
      expect(t.advance!(a)).toBe(Math.round(c.advance!(b)!));
    }
  });

  test.skipIf(!romanT1)('Nimbus Roman matches MuPDF', () => {
    const f = parseType1(romanT1!);
    const [clear, rest] = splitType1(romanT1!);
    const names = ['A', 'g', 'at', 'ampersand', 'Aacute', 'Scaron', 'florin', 'fi', 'Q', 'percent', 'oe', 'section', 'eight', 'Oslash', 'W', 'dagger'];
    const r = compareWithMupdf(
      (b) => simpleFont(b, romanT1!, 'FontFile', names, [clear.length, rest.length, 0]),
      names.map((n, i) => ({ code: hex(i + 1), outline: f.outline(f.gidForName(n)) })),
      f.matrix,
    );
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });

  test('flex, seac and hint replacement match MuPDF', () => {
    const [clear, secret, trailer] = t1Font();
    const f = parseType1(concatBytes([clear, secret, trailer]));
    const names = ['A', 'acute', 'Aacute', 'flexer', 'hinted', 'sbwdiv', 'setpoint', 'curves', 'hv', 'reopen'];
    const r = compareWithMupdf(
      (b) => simpleFont(b, concatBytes([clear, secret, trailer]), 'FontFile', names, [clear.length, secret.length, trailer.length]),
      names.map((n, i) => ({ code: hex(i + 1), outline: f.outline(f.gidForName(n)) })),
      f.matrix,
    );
    expect(Math.max(...r.mismatch)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------------------------
// Damaged data

describe('damaged fonts', () => {
  const composites = ttf({
    glyphs: [
      new Uint8Array(0),
      simpleGlyph([square, [[50, 0, false], [100, 50, true], [50, 100, false], [0, 50, true]]]),
      composite(component(0x1 | 0x2 | 0x20, 1, [1000, -300]), component(0x2 | 0x8, 1, [-5, 7], [0.5])),
      composite(component(0x2 | 0x80 | 0x20, 2, [10, 0], [0, 1, -1, 0]), component(0x2, 3, [1, 1])),
    ],
    advances: [500, 600],
    post: concatBytes([be([0x10000, 4]), new Uint8Array(28)]),
  });
  const cases: [string, Uint8Array | undefined, (d: Uint8Array) => FontProgram][] = [
    ['TrueType', liberation, parseTrueType],
    ['TrueType composites', composites, parseTrueType],
    ['OpenType CFF', nimbusOtf, parseTrueType],
    ['CFF', nimbusCff, parseCFF],
    ['CFF operators', writeCff({ charstrings: OPS_GLYPHS.map((g) => g[1]), private: { subrs: [cs2(10, 0, 'rlineto', 'return')] }, encoding: new Uint8Array([0x80, 1, 65, 1, 66, 0, 34]) }), parseCFF],
    ['CID-keyed CFF', unifont && sfntTable(unifont, 'CFF ')!.slice(), parseCFF],
    ['Type 1', nimbusT1, (d) => parseType1(d)],
    ['Type 1 synthetic', concatBytes(t1Font()), (d) => parseType1(d)],
  ];
  for (const [name, data, parse] of cases) {
    test.skipIf(!data)(
      `${name}: truncated and corrupted data never make outline() throw`,
      () => {
        const rng = new Rng(name.length * 7919);
        const start = performance.now();
        let parsed = 0;
        for (let iter = 0; iter < 40; iter++) {
          let d = data!.slice();
          const mode = iter % 4;
          if (mode === 0) d = d.slice(0, rng.int(0, d.length));
          if (mode === 1 || mode === 3) for (let k = rng.int(1, 64); k--; ) d[rng.int(0, d.length - 1)] = rng.int(0, 255);
          if (mode === 2) d.fill(rng.pick([0, 255]), rng.int(0, d.length - 1), rng.int(0, d.length));
          if (mode === 3) d = d.slice(0, rng.int(d.length >> 1, d.length));
          let f: FontProgram;
          try {
            f = parse(d);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
            continue;
          }
          parsed++;
          const step = Math.max(1, Math.floor(f.glyphCount / 150));
          for (let g = -1; g <= f.glyphCount + 1; g += step) {
            expect(wellFormed(f.outline(g))).toBe(true);
            f.advance?.(g);
          }
          f.gidForName('A');
          f.gidForCid?.(1);
          for (const c of f.cmaps ?? []) for (const code of [0, 0x41, 0x3042, 0x1f600]) c.lookup(code);
        }
        expect(parsed).toBeGreaterThan(0);
        expect(performance.now() - start).toBeLessThan(30_000);
      },
      60_000,
    );
  }
});
