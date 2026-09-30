import { describe, expect, test } from 'bun:test';
import { PdfSyntaxError } from '../../src/core/errors.ts';
import { RowDecoder, unfilterPng } from '../../src/core/predictor.ts';

/** Reference PNG filter (encoder side), straight from the PNG spec. */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = (row[i] - pred) & 255;
  }
  return out;
}

function randomImage(rows: number, rowBytes: number, seed: number): Uint8Array[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  return Array.from({ length: rows }, (_, y) => Uint8Array.from({ length: rowBytes }, (_, x) => (x * 3 + y * 7 + (rnd() & 15)) & 255));
}

function encodePng(rows: Uint8Array[], bpp: number, types: number[]): Uint8Array {
  const rowBytes = rows[0].length;
  const out = new Uint8Array(rows.length * (rowBytes + 1));
  let prev: Uint8Array = new Uint8Array(rowBytes);
  rows.forEach((row, y) => {
    const t = types[y % types.length];
    out[y * (rowBytes + 1)] = t;
    out.set(filterRow(t, row, prev, bpp), y * (rowBytes + 1) + 1);
    prev = row;
  });
  return out;
}

function decodeAll(data: Uint8Array, predictor: number, colors: number, columns: number, chunk: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  const dec = new RowDecoder(predictor, colors, 8, columns, (r) => void rows.push(r.slice()));
  for (let i = 0; i < data.length; i += chunk) dec.push(data.subarray(i, i + chunk));
  return rows;
}

describe('PNG predictors', () => {
  for (const colors of [1, 3]) {
    test(`all filter types round-trip (${colors} colors), across arbitrary chunk boundaries`, () => {
      const columns = 37;
      const rows = randomImage(23, columns * colors, colors);
      const encoded = encodePng(rows, colors, [0, 1, 2, 3, 4, 4, 3, 1]);
      for (const chunk of [1, 7, 38, 4096]) {
        expect(decodeAll(encoded, 15, colors, columns, chunk)).toEqual(rows);
      }
    });
  }

  test('each predictor value 10-15 decodes per-row types', () => {
    const rows = randomImage(5, 12, 9);
    const encoded = encodePng(rows, 3, [2]);
    for (let p = 10; p <= 15; p++) expect(decodeAll(encoded, p, 3, 4, 5)).toEqual(rows);
  });

  test('an invalid filter byte is an error', () => {
    const row = new Uint8Array(4);
    expect(() => unfilterPng(5, row, row, 1)).toThrow(PdfSyntaxError);
    const dec = new RowDecoder(12, 1, 8, 3, () => {});
    expect(() => dec.push(Uint8Array.of(9, 1, 2, 3))).toThrow(PdfSyntaxError);
  });

  test('onRow can stop decoding early', () => {
    const rows = randomImage(10, 4, 3);
    let seen = 0;
    const dec = new RowDecoder(1, 1, 8, 4, () => ++seen === 3);
    expect(dec.push(Uint8Array.from(rows.flatMap((r) => [...r])))).toBe(true);
    expect(seen).toBe(3);
  });
});

describe('TIFF predictor 2', () => {
  test('undoes horizontal differencing per component', () => {
    const rows = randomImage(4, 5 * 3, 11);
    const diff = rows.map((r) => {
      const d = r.slice();
      for (let i = r.length - 1; i >= 3; i--) d[i] = (r[i] - r[i - 3]) & 255;
      return d;
    });
    const encoded = Uint8Array.from(diff.flatMap((r) => [...r]));
    expect(decodeAll(encoded, 2, 3, 5, 6)).toEqual(rows);
  });

  test('only 8 bits per component is supported', () => {
    expect(() => new RowDecoder(2, 1, 16, 4, () => {})).toThrow(PdfSyntaxError);
  });
});

test('no predictor passes rows through', () => {
  expect(decodeAll(Uint8Array.of(1, 2, 3, 4, 5, 6), 1, 1, 3, 4)).toEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)]);
});

test('unsupported predictor values are rejected', () => {
  expect(() => new RowDecoder(3, 1, 8, 4, () => {})).toThrow(PdfSyntaxError);
  expect(() => new RowDecoder(16, 1, 8, 4, () => {})).toThrow(PdfSyntaxError);
});
