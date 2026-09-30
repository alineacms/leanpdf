import { describe, expect, test } from 'bun:test';
import { fitInside, GrayDownscaler } from '../../src/core/resize.ts';

function shrink(src: number[][], ow: number, oh: number): number[][] {
  const rows: number[][] = [];
  const s = new GrayDownscaler(src[0].length, src.length, ow, oh, (r) => void rows.push([...r]));
  for (const r of src) s.push(Uint8Array.from(r));
  return rows;
}

/** Reference: exact area-weighted mean, computed the slow way. */
function reference(src: number[][], ow: number, oh: number): number[][] {
  const h = src.length;
  const w = src[0].length;
  const out: number[][] = [];
  for (let i = 0; i < oh; i++) {
    const row: number[] = [];
    for (let j = 0; j < ow; j++) {
      let sum = 0;
      let wt = 0;
      for (let y = 0; y < h; y++) {
        const wy = Math.max(0, Math.min((y + 1) * oh, (i + 1) * h) - Math.max(y * oh, i * h));
        if (!wy) continue;
        for (let x = 0; x < w; x++) {
          const wx = Math.max(0, Math.min((x + 1) * ow, (j + 1) * w) - Math.max(x * ow, j * w));
          sum += src[y][x] * wx * wy;
          wt += wx * wy;
        }
      }
      row.push(Math.round(sum / wt));
    }
    out.push(row);
  }
  return out;
}

describe('GrayDownscaler', () => {
  test('integer factors average blocks', () => {
    const src = [
      [0, 100, 10, 10],
      [200, 100, 30, 30],
      [255, 255, 0, 0],
      [255, 255, 0, 4],
    ];
    expect(shrink(src, 2, 2)).toEqual([
      [100, 20],
      [255, 1],
    ]);
  });

  test('fractional factors match the exact area-weighted mean', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24) & 255;
    for (const [w, h, ow, oh] of [
      [5, 3, 2, 2],
      [37, 23, 10, 7],
      [100, 9, 33, 4],
      [9, 100, 4, 33],
      [64, 64, 63, 63],
      [30, 30, 1, 1],
    ]) {
      const src = Array.from({ length: h }, () => Array.from({ length: w }, rnd));
      expect(shrink(src, ow, oh)).toEqual(reference(src, ow, oh));
    }
  });

  test('flat images stay flat and every output row is emitted exactly once', () => {
    const src = Array.from({ length: 1000 }, () => new Array(777).fill(173));
    const out = shrink(src, 333, 429);
    expect(out.length).toBe(429);
    expect(out.every((r) => r.length === 333 && r.every((v) => v === 173))).toBe(true);
  });
});

test('fitInside keeps the aspect ratio and never enlarges', () => {
  expect(fitInside(4000, 3000, 1600, 1600)).toEqual([1600, 1200]);
  expect(fitInside(800, 600, 1600, 1600)).toEqual([800, 600]);
  expect(fitInside(3000, 40, 1600, 1600)).toEqual([1600, 21]);
  expect(fitInside(5000, 10, 100, 100)).toEqual([100, 1]);
});
