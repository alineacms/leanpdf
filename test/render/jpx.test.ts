import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { decodeJpx, jpxInfo, type JpxImage } from '../../src/core/jpx.ts';
import { concatBytes } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';

/**
 * Fixtures come from OpenJPEG through fixtures/jpx/make.py. Lossless ones must decode to exactly
 * the source pixels (SHA-1 of the expected 8-bit output); lossy ones are compared with OpenJPEG's
 * decode stored alongside (.ref.gz) or, for plain 8-bit gray and RGB, with MuPDF's.
 */
interface Decode {
  reduce: number;
  width: number;
  height: number;
  components: number;
  sha1?: string;
  ref?: string;
  /** Max and mean absolute difference allowed against the reference. */
  tol?: [number, number];
}

interface Fixture {
  file: string;
  mupdf: boolean;
  colorSpace?: JpxImage['colorSpace'] | null;
  alpha?: number;
  levels?: number;
  decodes: Decode[];
}

const DIR = new URL('./fixtures/jpx/', import.meta.url).pathname;
const fixtures = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8')) as Fixture[];
const load = (f: string) => new Uint8Array(readFileSync(DIR + f));
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

/** MuPDF's decode of a JPX image, as tightly packed 8-bit samples. */
function mupdfDecode(data: Uint8Array): { width: number; height: number; n: number; data: Uint8Array } {
  const image = new mupdf.Image(data), pix = image.toPixmap();
  try {
    const width = pix.getWidth(), height = pix.getHeight(), n = pix.getNumberOfComponents() + pix.getAlpha(), stride = pix.getStride();
    const px = pix.getPixels(), out = new Uint8Array(width * height * n);
    for (let y = 0; y < height; y++) out.set(px.subarray(y * stride, y * stride + width * n), y * width * n);
    return { width, height, n, data: out };
  } finally {
    pix.destroy();
    image.destroy();
  }
}

/** Max and mean absolute difference, and where the first difference beyond `max` is. */
function diff(a: Uint8Array, b: Uint8Array, max = 0): { max: number; mean: number; at: number } {
  let m = 0, sum = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
    if (d > max && at < 0) at = i;
    sum += d;
  }
  return { max: m, mean: sum / a.length, at };
}

function expectClose(img: JpxImage, ref: Uint8Array, [max, mean]: [number, number], what: string) {
  expect(img.data.length).toBe(ref.length);
  const d = diff(img.data, ref, max);
  if (d.max > max || d.mean > mean) {
    const px = Math.floor(d.at / img.components);
    throw new Error(`${what}: max ${d.max}, mean ${d.mean.toFixed(3)}; first beyond ${max} at x ${px % img.width}, y ${Math.floor(px / img.width)}`);
  }
}

describe('decodeJpx: fixtures', () => {
  for (const fx of fixtures) {
    test(fx.file, () => {
      const data = load(fx.file);
      for (const dec of fx.decodes) {
        const img = decodeJpx(data, { reduce: dec.reduce });
        expect(img).not.toBeNull();
        const what = `${fx.file} reduce ${dec.reduce}`;
        expect([img!.width, img!.height, img!.components]).toEqual([dec.width, dec.height, dec.components]);
        expect(img!.data.length).toBe(dec.width * dec.height * dec.components);
        if (dec.sha1) expect(`${what}: ${sha1(img!.data)}`).toBe(`${what}: ${dec.sha1}`);
        if (dec.ref) expectClose(img!, Bun.gunzipSync(load(dec.ref)), dec.tol!, `${what} vs OpenJPEG`);
        if (fx.mupdf && !dec.reduce) {
          const mu = mupdfDecode(data);
          expect([mu.width, mu.height, mu.n]).toEqual([dec.width, dec.height, dec.components]);
          expectClose(img!, mu.data, dec.tol ?? [0, 0], `${what} vs MuPDF`);
        }
        if ('colorSpace' in fx) expect(img!.colorSpace).toBe(fx.colorSpace ?? undefined);
        expect(img!.alpha).toBe(fx.alpha);
        if (fx.levels) expect(img!.levels).toBe(fx.levels);
      }
      const info = jpxInfo(data)!;
      const full = fx.decodes[0];
      expect([info.width, info.height, info.components]).toEqual([full.width, full.height, full.components]);
      expect(info.colorSpace).toBe(decodeJpx(data)!.colorSpace);
    });
  }
});

describe('decodeJpx: reduce', () => {
  /**
   * Average `f` x `f` blocks of a full-size decode, clipped at the edges. A reduced JPEG 2000 image's
   * sample k sits at k * f on the full grid, so the blocks are centred there.
   */
  function boxDown(img: JpxImage, f: number): Uint8Array {
    const w = Math.ceil(img.width / f), h = Math.ceil(img.height / f), n = img.components, out = new Uint8Array(w * h * n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < n; c++) {
          let s = 0, k = 0;
          for (let yy = Math.max(y * f - f / 2, 0); yy < Math.min(y * f + f / 2, img.height); yy++) {
            for (let xx = Math.max(x * f - f / 2, 0); xx < Math.min(x * f + f / 2, img.width); xx++, k++) s += img.data[(yy * img.width + xx) * n + c];
          }
          out[(y * w + x) * n + c] = Math.round(s / k);
        }
      }
    }
    return out;
  }

  for (const file of ['gray-53.j2k', 'rgb-97.jp2', 'rgb-53-rpcl.j2k', 'rgb-97-pcrl.j2k', 'tiles-parts.j2k']) {
    test(`${file}: each level halves the size and looks like the downscaled image`, () => {
      const data = load(file), full = decodeJpx(data)!;
      for (let r = 1; r < Math.min(full.levels, 4); r++) {
        const img = decodeJpx(data, { reduce: r })!, f = 2 ** r;
        expect([img.width, img.height]).toEqual([Math.ceil(full.width / f), Math.ceil(full.height / f)]);
        // The wavelet low-pass is close to a box filter on these fairly smooth images.
        const d = diff(img.data, boxDown(full, f));
        expect(d.mean).toBeLessThan(4 + 2 * r);
      }
    });
  }

  test('reduce beyond the available levels is clamped; levels matches jpxInfo', () => {
    const data = load('gray-53.j2k');
    const info = jpxInfo(data)!;
    expect(info.levels).toBe(6);
    const img = decodeJpx(data, { reduce: 99 })!;
    expect([img.width, img.height]).toEqual([Math.ceil(67 / 32), Math.ceil(45 / 32)]);
    expect(decodeJpx(data, { reduce: -3 })!.width).toBe(67);
  });
});

describe('decodeJpx and jpxInfo: headers', () => {
  test('jpxInfo reads size, components, levels, precision and colour space without decoding', () => {
    expect(jpxInfo(load('rgb-97.jp2'))).toEqual({ width: 88, height: 64, components: 3, levels: 6, bitsPerComponent: 8, colorSpace: 'rgb' });
    expect(jpxInfo(load('gray-16bit-53.j2k'))).toEqual({ width: 67, height: 45, components: 1, levels: 4, bitsPerComponent: 16, colorSpace: undefined });
    expect(jpxInfo(load('palette.jp2'))).toMatchObject({ components: 3, bitsPerComponent: 12, colorSpace: 'rgb' });
    expect(jpxInfo(load('cmyk-53.jp2'))).toMatchObject({ components: 4, colorSpace: 'cmyk' });
    expect(jpxInfo(load('rgba-53.jp2'))).toMatchObject({ components: 4, colorSpace: 'rgb' });
    expect(jpxInfo(load('tiles-offset-53.j2k'))).toMatchObject({ width: 67, height: 45 });
  });

  test('maxPixels refuses large outputs, counted after reduce', () => {
    const data = load('rgb-97.jp2');
    expect(decodeJpx(data, { maxPixels: 88 * 64 - 1 })).toBeNull();
    expect(decodeJpx(data, { maxPixels: 88 * 64 })).not.toBeNull();
    expect(decodeJpx(data, { maxPixels: 44 * 32, reduce: 1 })).not.toBeNull();
  });

  test('not JPEG 2000: null', () => {
    for (const d of [new Uint8Array(0), new Uint8Array([0xff, 0x4f]), new Uint8Array(100), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])]) {
      expect(decodeJpx(d)).toBeNull();
      expect(jpxInfo(d)).toBeNull();
    }
  });

  /** Marker segments of a codestream's main header: marker, start and end. */
  function mainHeader(cs: Uint8Array): { m: number; at: number; end: number }[] {
    const out = [];
    for (let at = 2; ((cs[at] << 8) | cs[at + 1]) !== 0xff90; ) {
      const end = at + 2 + ((cs[at + 2] << 8) | cs[at + 3]);
      out.push({ m: (cs[at] << 8) | cs[at + 1], at, end });
      at = end;
    }
    return out;
  }
  const splice = (cs: Uint8Array, at: number, ...parts: Uint8Array[]) => concatBytes([cs.subarray(0, at), ...parts, cs.subarray(at)]);
  const marker = (m: number, body: Uint8Array) => concatBytes([new Uint8Array([m >> 8, m & 255, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);

  test('COC and QCC markers restating the defaults change nothing', () => {
    const cs = load('rgb-53-lrcp.j2k'), hdr = mainHeader(cs);
    const cod = hdr.find((x) => x.m === 0xff52)!, qcd = hdr.find((x) => x.m === 0xff5c)!;
    // COC: component, Scoc (the precinct flag), SPcod. QCC: component, then as QCD.
    const coc = marker(0xff53, concatBytes([new Uint8Array([2, cs[cod.at + 4] & 1]), cs.subarray(cod.at + 9, cod.end)]));
    const qcc = marker(0xff5d, concatBytes([new Uint8Array([1]), cs.subarray(qcd.at + 4, qcd.end)]));
    expect(sha1(decodeJpx(splice(cs, qcd.end, coc, qcc))!.data)).toBe(sha1(decodeJpx(cs)!.data));
  });

  test('COD and QCD repeated in a tile-part header change nothing', () => {
    const cs = load('tiles-parts.j2k'), hdr = mainHeader(cs), sot = hdr[hdr.length - 1].end;
    const extra = concatBytes(hdr.filter((x) => x.m === 0xff52 || x.m === 0xff5c).map((x) => cs.subarray(x.at, x.end)));
    const out = splice(cs, sot + 12, extra);
    // Psot of that tile-part grows by what was inserted.
    new DataView(out.buffer).setUint32(sot + 6, new DataView(cs.buffer, cs.byteOffset).getUint32(sot + 6) + extra.length);
    expect(sha1(decodeJpx(out)!.data)).toBe(sha1(decodeJpx(cs)!.data));
  });

  test('a JP2 wrapped in junk still finds its codestream', () => {
    const cs = load('gray-53.j2k'), junk = new Uint8Array(cs.length + 37);
    junk.set(cs, 37);
    expect(sha1(decodeJpx(junk)!.data)).toBe(sha1(decodeJpx(cs)!.data));
  });
});

describe('decodeJpx: damaged data', () => {
  const files = ['rgb-97.jp2', 'rgb-53-cprl.j2k', 'tiles-offset-97.jp2', 'mode63-97.j2k', 'ppm-sop-eph.j2k', 'palette.jp2', 'sycc-420-53.jp2', 'poc.j2k'];

  test('truncated: partial images or null, never a throw', () => {
    for (const file of files) {
      const data = load(file), full = decodeJpx(data)!;
      let partial = 0;
      for (let n = 0; n < data.length; n += Math.max(1, Math.floor(data.length / 97))) {
        const img = decodeJpx(data.subarray(0, n));
        if (!img) continue;
        partial++;
        expect([img.width, img.height, img.components]).toEqual([full.width, full.height, full.components]);
      }
      // Cut anywhere after the first packets, what arrived is still shown.
      expect(partial).toBeGreaterThan(50);
    }
  });

  test('truncated in the last resolution: the lower resolutions still decode exactly', () => {
    // Resolution-major, so the last bytes are all highest-resolution packets.
    const data = load('rgb-53-rlcp.j2k'), cut = data.subarray(0, data.length - 200);
    expect(diff(decodeJpx(cut)!.data, decodeJpx(data)!.data).max).toBeGreaterThan(0);
    expect(sha1(decodeJpx(cut, { reduce: 1 })!.data)).toBe(sha1(decodeJpx(data, { reduce: 1 })!.data));
  });

  test('corrupted bytes: no throws, no hangs (time-bounded fuzz)', () => {
    const rng = new Rng(20260930);
    const start = performance.now();
    let decoded = 0, runs = 0;
    for (; performance.now() - start < 2500 && runs < 1500; runs++) {
      const src = load(rng.pick(files)), data = src.slice();
      // Flip a few bytes, mostly in the headers where damage is most interesting.
      for (let k = rng.int(1, 6); k--; ) {
        const at = rng.next() < 0.5 ? rng.int(0, Math.min(300, data.length - 1)) : rng.int(0, data.length - 1);
        data[at] = rng.next() < 0.3 ? rng.pick([0, 0xff, 0x90, 0x93, 0x4f, 0x51, 0x52, 0x5c]) : rng.int(0, 255);
      }
      const t0 = performance.now();
      const img = decodeJpx(data, { maxPixels: 1 << 22 });
      if (img) decoded++, expect(img.data.length).toBe(img.width * img.height * img.components);
      jpxInfo(data);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
    expect(runs).toBeGreaterThan(100);
    expect(decoded).toBeGreaterThan(0);
  }, 30000);

  test('random data and hostile headers: null or an image, never a throw', () => {
    const rng = new Rng(7);
    const cs = load('gray-53.j2k');
    for (let i = 0; i < 300; i++) {
      const d = i < 150 ? rng.bytes(rng.int(0, 400)) : cs.slice(0, 200);
      if (i < 150 && rng.next() < 0.5) d.set([0xff, 0x4f, 0xff, 0x51].slice(0, d.length));
      // Huge or zero sizes, tile counts, component counts and precisions in SIZ.
      if (i >= 150) for (let k = 0; k < 3; k++) d[rng.int(6, 48)] = rng.int(0, 255);
      expect(() => decodeJpx(d, { maxPixels: 1 << 20 })).not.toThrow();
      expect(() => jpxInfo(d)).not.toThrow();
    }
  });
});
