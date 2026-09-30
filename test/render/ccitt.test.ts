import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ccittDecode, type CcittParams } from '../../src/core/ccitt.ts';
import { DocBuilder } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { ccittEncode, type EncodeOptions } from './ccitt-encoder.ts';

/** Seeded integers in [0, n). */
class Prng extends Rng {
  below(n: number): number {
    return this.int(0, Math.max(0, Math.ceil(n) - 1));
  }
}

/** A test bitmap (1 = black): shapes, stripes, isolated dots, long runs and noise. */
function bitmap(w: number, h: number, seed = 1): Uint8Array {
  const rnd = new Prng(seed);
  const px = new Uint8Array(w * h);
  const rects = Array.from({ length: 12 }, () => [rnd.below(w), rnd.below(h), rnd.below(w / 2) + 1, rnd.below(h / 2) + 1]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (const [rx, ry, rw, rh] of rects) if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) v ^= 1;
      if (y % 17 === 3) v = x % 5 < 2 ? 1 : 0; // short alternating runs
      if (y % 23 === 7) v = 1; // a full black row
      if ((x * 31 + y * 17) % 97 === 0) v ^= 1; // isolated dots
      if (y % 29 === 11 && rnd.below(4) === 0) v = rnd.below(2); // noise
      px[y * w + x] = v;
    }
  }
  return px;
}

/** Decoder output for `px`: packed rows, 0 = black unless BlackIs1. Padding bits are ignored. */
function unpack(out: Uint8Array, w: number, rows: number, blackIs1 = false): Uint8Array {
  const rb = (w + 7) >> 3;
  const px = new Uint8Array(w * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const bit = (out[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
      px[y * w + x] = blackIs1 ? bit : bit ^ 1;
    }
  }
  return px;
}

function firstDiff(a: Uint8Array, b: Uint8Array, w: number): string {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return `row ${Math.floor(i / w)} col ${i % w}`;
  return a.length === b.length ? 'none' : `length ${a.length} vs ${b.length}`;
}

function expectRows(out: Uint8Array | null, px: Uint8Array, w: number, rows: number, blackIs1 = false) {
  expect(out).not.toBeNull();
  expect(out!.length).toBe(((w + 7) >> 3) * rows);
  expect(firstDiff(unpack(out!, w, rows, blackIs1), px.subarray(0, w * rows), w)).toBe('none');
}

const params = (o: EncodeOptions, w: number, h: number, extra: Partial<CcittParams> = {}): Partial<CcittParams> => ({
  K: o.k,
  Columns: w,
  Rows: h,
  EndOfLine: !!o.eol,
  EncodedByteAlign: !!o.byteAlign,
  EndOfBlock: !!o.eob,
  ...extra,
});

describe('ccittDecode: round trips through a reference encoder', () => {
  const modes: [string, EncodeOptions][] = [
    ['Group 4', { k: -1 }],
    ['Group 4, EOFB', { k: -1, eob: true }],
    ['Group 4, byte-aligned', { k: -1, byteAlign: true }],
    ['Group 3 1-D', { k: 0 }],
    ['Group 3 1-D, EOL', { k: 0, eol: true }],
    ['Group 3 1-D, EOL, RTC', { k: 0, eol: true, eob: true }],
    ['Group 3 1-D, EOL, byte-aligned', { k: 0, eol: true, byteAlign: true }],
    ['Group 3 1-D, byte-aligned', { k: 0, byteAlign: true }],
    ['Group 3 2-D K=2', { k: 2 }],
    ['Group 3 2-D K=4, EOL, RTC', { k: 4, eol: true, eob: true }],
    ['Group 3 2-D K=3, EOL, byte-aligned', { k: 3, eol: true, byteAlign: true }],
    ['Group 3 2-D K=1000 (one 1-D row)', { k: 1000, eol: true }],
  ];
  for (const [name, o] of modes) {
    for (const [w, h] of [
      [173, 61],
      [1728, 40],
      [3000, 6], // runs beyond 2560: extended make-up codes
      [1, 5],
      [8, 3],
    ]) {
      test(`${name}, ${w} x ${h}`, () => {
        const px = bitmap(w, h, w + h);
        const data = ccittEncode(px, w, h, o);
        expectRows(ccittDecode(data, params(o, w, h)), px, w, h);
      });
    }
  }

  test('BlackIs1 inverts the output', () => {
    const px = bitmap(100, 20);
    const o = { k: -1 };
    expectRows(ccittDecode(ccittEncode(px, 100, 20, o), params(o, 100, 20, { BlackIs1: true })), px, 100, 20, true);
  });

  test('Rows 0 decodes until the data (or the end of block) ends', () => {
    const px = bitmap(64, 30, 5);
    for (const o of [{ k: -1, eob: true }, { k: -1 }, { k: 0, eol: true, eob: true }, { k: 2, eol: true, eob: true }, { k: 0, eol: true }]) {
      expectRows(ccittDecode(ccittEncode(px, 64, 30, o), params(o, 64, 0)), px, 64, 30);
    }
  });

  test('stops at the end of block even when Rows asks for more', () => {
    const px = bitmap(50, 10, 9);
    const o = { k: -1, eob: true };
    const data = ccittEncode(px, 50, 10, o);
    const more = new Uint8Array(data.length + 20).fill(0xaa);
    more.set(data);
    expectRows(ccittDecode(more, params(o, 50, 100)), px, 50, 10);
  });

  test('defaults: K 0, 1728 columns, EndOfLine not required', () => {
    const px = bitmap(1728, 4, 3);
    const data = ccittEncode(px, 1728, 4, { k: 0 });
    expectRows(ccittDecode(data, {}), px, 1728, 4);
  });
});

describe('ccittDecode: damage', () => {
  const w = 120;
  const h = 30;
  const px = bitmap(w, h, 11);

  test('truncated data yields the complete rows before the cut', () => {
    for (const o of [{ k: -1 }, { k: 0, eol: true }, { k: 2 }]) {
      const data = ccittEncode(px, w, h, o);
      for (const cut of [1, 5, data.length >> 2, data.length >> 1, data.length - 3]) {
        const out = ccittDecode(data.subarray(0, cut), params(o, w, h));
        if (!out) continue;
        const rows = out.length / ((w + 7) >> 3);
        expect(rows).toBeLessThan(h);
        expect(firstDiff(unpack(out, w, rows), px.subarray(0, rows * w), w)).toBe('none');
      }
      expect(ccittDecode(new Uint8Array(0), params(o, w, h))).toBeNull();
    }
  });

  test('DamagedRowsBeforeError skips damaged rows between EOLs', () => {
    const o = { k: 0, eol: true, byteAlign: true };
    const data = ccittEncode(px, w, h, o).slice();
    // Corrupt the middle of the data (inside some row, not its EOL).
    const at = data.length >> 1;
    data.fill(0xff, at, at + 3);
    const strict = ccittDecode(data, params(o, w, h))!;
    const lenient = ccittDecode(data, params(o, w, h, { DamagedRowsBeforeError: 5 }))!;
    const rb = (w + 7) >> 3;
    expect(strict.length / rb).toBeLessThan(h);
    expect(lenient.length / rb).toBeGreaterThan(strict.length / rb);
    // Rows before the damage are intact either way; with tolerance the last rows are too.
    const good = strict.length / rb;
    expect(firstDiff(unpack(strict, w, good), px.subarray(0, good * w), w)).toBe('none');
    const lr = lenient.length / rb;
    expect(lr).toBe(h);
    expect(firstDiff(unpack(lenient, w, h).subarray((h - 3) * w), px.subarray((h - 3) * w), w)).toBe('none');
  });

  test('garbage never throws, hangs or overruns', () => {
    const rnd = new Prng(42);
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      const data = new Uint8Array(rnd.below(400));
      for (let j = 0; j < data.length; j++) data[j] = rnd.below(4) ? rnd.below(256) : 0;
      const k = [-1, 0, 1, 4][i & 3];
      const cols = 1 + rnd.below(3000);
      const out = ccittDecode(data, { K: k, Columns: cols, Rows: rnd.below(3) ? rnd.below(200) : 0, EndOfLine: !!(i & 4), EncodedByteAlign: !!(i & 8), DamagedRowsBeforeError: i & 16 ? 1000 : 0 });
      if (out) expect(out.length % ((cols + 7) >> 3)).toBe(0);
    }
    for (const fill of [0, 0xff, 0x80, 0x01]) {
      for (const k of [-1, 0, 2]) ccittDecode(new Uint8Array(5000).fill(fill), { K: k, Columns: 1728, EndOfLine: true, DamagedRowsBeforeError: 1 << 20 });
    }
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test('bad columns', () => {
    const data = ccittEncode(px, w, h, { k: -1 });
    expect(ccittDecode(data, { K: -1, Columns: 0 })).toBeNull();
    expect(ccittDecode(data, { K: -1, Columns: -5 })).toBeNull();
    expect(ccittDecode(data, { K: -1, Columns: 1e12 })).toBeNull();
    expect(ccittDecode(data, { K: -1, Columns: 10.5 })).toBeNull();
  });
});

/** The first IFD's strips of a TIFF: [data, rows] each, plus photometric interpretation. */
function tiffStrips(tif: Uint8Array): { strips: [Uint8Array, number][]; photometric: number; width: number; height: number } {
  const dv = new DataView(tif.buffer, tif.byteOffset, tif.byteLength);
  const le = tif[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const ifd = u32(4);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < u16(ifd); i++) {
    const e = ifd + 2 + 12 * i;
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? e + 8 : u32(e + 8);
    tags.set(u16(e), Array.from({ length: count }, (_, k) => (type === 3 ? u16(at + 2 * k) : u32(at + 4 * k))));
  }
  const width = tags.get(256)![0];
  const height = tags.get(257)![0];
  const per = tags.get(278)?.[0] ?? height;
  const offs = tags.get(273)!;
  const counts = tags.get(279)!;
  expect(tags.get(259)![0]).toBe(4);
  expect(tags.get(266)?.[0] ?? 1).toBe(1);
  return {
    strips: offs.map((o, i) => [tif.subarray(o, o + counts[i]), Math.min(per, height - i * per)]),
    photometric: tags.get(262)![0],
    width,
    height,
  };
}

describe('ccittDecode: third-party encoders', () => {
  test('Group 4 from libtiff (sharp), several strips', async () => {
    for (const [w, h] of [
      [300, 40],
      [2700, 300],
      [9, 700],
    ]) {
      const px = bitmap(w, h, 7);
      const gray = px.map((v) => (v ? 0 : 255));
      const tif = new Uint8Array(await sharp(gray, { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').tiff({ compression: 'ccittfax4', bitdepth: 1 }).toBuffer());
      const t = tiffStrips(tif);
      expect([t.width, t.height]).toEqual([w, h]);
      let y = 0;
      for (const [data, rows] of t.strips) {
        // libtiff codes 0 bits as white runs whatever the photometric interpretation, so with
        // BlackIs1 the output is the TIFF's bits (where MinIsBlack, 1, has 0 for black).
        const out = ccittDecode(data, { K: -1, Columns: w, Rows: rows, BlackIs1: true });
        const bits = px.subarray(y * w, (y + rows) * w).map((v) => (t.photometric === 1 ? v ^ 1 : v));
        expectRows(out, bits, w, rows, true);
        y += rows;
      }
      expect(y).toBe(h);
    }
  });

  const gs = spawnSync('gs', ['--version']).status === 0;
  test.skipIf(!gs)('Group 3 and 4 from Ghostscript fax devices', () => {
    const d = new DocBuilder();
    let content = '';
    for (let i = 0; i < 12; i++) content += `BT /F1 ${8 + i * 3} Tf ${20 + i * 7} ${40 + i * 45} Td (Fax test ${i} WMW iii ,.;) Tj ET\n`;
    content += '0 0 m 400 580 l 12 w S 30 300 200 20 re f 250 50 60 400 re f\n';
    d.page({ width: 420, height: 600, content });
    const dir = mkdtempSync(join(tmpdir(), 'leanpdf-fax-'));
    try {
      const pdf = join(dir, 'in.pdf');
      writeFileSync(pdf, d.finish().build().bytes);
      const run = (dev: string, out: string) => execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-r100', '-dAdjustWidth=0', `-sDEVICE=${dev}`, `-sOutputFile=${out}`, pdf]);
      run('pbmraw', join(dir, 'ref.pbm'));
      const pbm = readFileSync(join(dir, 'ref.pbm'));
      const head = pbm.toString('latin1', 0, 64).match(/^P4\s+(?:#.*\s+)*(\d+)\s+(\d+)\s/)!;
      const [w, h] = [+head[1], +head[2]];
      const rb = (w + 7) >> 3;
      const ref = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ref[y * w + x] = (pbm[head[0].length + y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
      expect(ref.some((v) => v)).toBe(true);
      for (const [dev, K] of [
        ['faxg3', 0],
        ['faxg32d', 1],
        ['faxg4', -1],
      ] as const) {
        run(dev, join(dir, dev));
        const data = new Uint8Array(readFileSync(join(dir, dev)));
        // K > 0: any positive value decodes; tags say which rows are 1-D.
        const out = ccittDecode(data, { K, Columns: w, Rows: 0, EndOfLine: K >= 0 });
        expectRows(out, ref, w, h);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
