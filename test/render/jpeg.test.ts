import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decodeJpeg } from '../../src/render/jpeg.ts';

const dir = new URL('./fixtures/jpeg/', import.meta.url).pathname;
const read = (f: string) => new Uint8Array(readFileSync(dir + f));

/** Mean and largest sample difference against libjpeg-turbo's decoding (via Pillow, see make.py). */
function diff(name: string, reduce: number) {
  const img = decodeJpeg(read(`${name}.jpg`), reduce);
  const ref = read(`${name}.${reduce}.raw`);
  if (!img) throw new Error(`${name} did not decode`);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(img.data[i] - ref[i]);
    sum += d;
    max = Math.max(max, d);
  }
  return { img, len: img.data.length === ref.length, mean: sum / ref.length, max };
}

describe('decodeJpeg', () => {
  const cases: [string, number][] = [
    ['gray', 1],
    ['rgb420', 3],
    ['rgb444-progressive', 3],
    ['cmyk', 4],
    ['cmyk-progressive-restart', 4],
    ['ycck', 4],
  ];
  for (const [name, components] of cases) {
    test(`${name} at full size and reduced`, () => {
      for (const reduce of [0, 1, 2, 3]) {
        const r = diff(name, reduce);
        expect([r.img.width, r.img.height, r.img.components]).toEqual([Math.ceil(45 / 2 ** reduce), Math.ceil(37 / 2 ** reduce), components]);
        expect(r.len).toBe(true);
        expect(r.mean).toBeLessThan(0.3);
        expect(r.max).toBeLessThanOrEqual(3);
      }
    });
  }

  test('CMYK samples are returned as stored, not inverted', () => {
    const cmyk = decodeJpeg(read('cmyk.jpg'))!;
    const ref = read('cmyk.0.raw');
    expect(Math.abs(cmyk.data[0] - ref[0])).toBeLessThanOrEqual(2);
  });

  test('rejects what is not a supported JPEG', () => {
    expect(decodeJpeg(new Uint8Array([1, 2, 3]))).toBeNull();
    const jpg = read('gray.jpg');
    // Arithmetic coding (SOF9) is not supported.
    const arith = jpg.slice();
    const sof = arith.findIndex((b, i) => b === 0xff && arith[i + 1] === 0xc0);
    arith[sof + 1] = 0xc9;
    expect(decodeJpeg(arith)).toBeNull();
    // Truncated data still decodes, as far as it goes.
    expect(decodeJpeg(jpg.subarray(0, jpg.length >> 1))).not.toBeNull();
  });
});
