import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { sniffJpeg } from '../../src/core/jpeg.ts';

const img = (channels: 3 | 4) => sharp({ create: { width: 64, height: 40, channels, background: { r: 200, g: 30, b: 90, alpha: 1 } } });

/** Insert an Adobe APP14 segment right after SOI. */
function withAdobe(jpeg: Uint8Array, transform: number): Uint8Array {
  const seg = Uint8Array.of(0xff, 0xee, 0, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2));
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

describe('sniffJpeg', () => {
  test('baseline RGB', async () => {
    const info = sniffJpeg(new Uint8Array(await img(3).jpeg().toBuffer()));
    expect(info).toMatchObject({ width: 64, height: 40, components: 3, precision: 8, sof: 0xc0, adobeTransform: -1, rgbIds: false });
  });

  test('progressive and grayscale', async () => {
    expect(sniffJpeg(new Uint8Array(await img(3).jpeg({ progressive: true }).toBuffer()))?.sof).toBe(0xc2);
    expect(sniffJpeg(new Uint8Array(await img(3).toColourspace('b-w').jpeg().toBuffer()))?.components).toBe(1);
  });

  test('CMYK JPEGs report 4 components and the Adobe marker', async () => {
    const info = sniffJpeg(new Uint8Array(await img(3).toColourspace('cmyk').jpeg().toBuffer()));
    expect(info?.components).toBe(4);
    expect(info?.adobeTransform).toBeGreaterThanOrEqual(0);
  });

  test('Adobe transform flag is read from APP14', async () => {
    const base = new Uint8Array(await img(3).jpeg().toBuffer());
    expect(sniffJpeg(withAdobe(base, 0))?.adobeTransform).toBe(0);
    expect(sniffJpeg(withAdobe(base, 1))?.adobeTransform).toBe(1);
  });

  test('garbage and truncation', async () => {
    expect(sniffJpeg(new Uint8Array(0))).toBe(null);
    expect(sniffJpeg(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(null);
    const base = new Uint8Array(await img(3).jpeg().toBuffer());
    for (let n = 0; n < 200; n += 7) expect(() => sniffJpeg(base.subarray(0, n))).not.toThrow();
  });
});
