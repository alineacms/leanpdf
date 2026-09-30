/** Deterministic synthetic images and the encoders the corpus needs (PNG rows, TIFF, JPEG, ICC). */
import sharp from 'sharp';
import { bytes, concatBytes } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';

export interface Pixels {
  width: number;
  height: number;
  comps: 1 | 3 | 4;
  data: Uint8Array;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** A smooth "photo": gradients, soft blobs, some texture and mild noise. */
export function photo(width: number, height: number, seed: number, comps: 1 | 3 = 3): Pixels {
  const r = new Rng(seed);
  const blobs = Array.from({ length: 7 }, () => ({
    x: r.next() * width,
    y: r.next() * height,
    rad: (0.1 + r.next() * 0.3) * Math.min(width, height),
    c: [r.int(0, 255), r.int(0, 255), r.int(0, 255)],
  }));
  const fx = 2 + r.next() * 6;
  const fy = 2 + r.next() * 6;
  const data = new Uint8Array(width * height * comps);
  const col = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      col[0] = 60 + 120 * u + 30 * Math.sin(fx * v * 6.28);
      col[1] = 80 + 100 * v + 25 * Math.cos(fy * u * 6.28);
      col[2] = 140 - 60 * u + 40 * Math.sin((u + v) * 9);
      for (const b of blobs) {
        const dx = x - b.x;
        const dy = y - b.y;
        const w = Math.exp(-(dx * dx + dy * dy) / (b.rad * b.rad));
        for (let k = 0; k < 3; k++) col[k] = col[k] * (1 - w) + b.c[k] * w;
      }
      const tex = 10 * Math.sin(x * 0.35) * Math.sin(y * 0.29);
      const o = (y * width + x) * comps;
      if (comps === 1) {
        data[o] = clamp(0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2] + tex + (r.next() - 0.5) * 14);
      } else {
        for (let k = 0; k < 3; k++) data[o + k] = clamp(col[k] + tex + (r.next() - 0.5) * 14);
      }
    }
  }
  return { width, height, comps, data };
}

/** A grayscale "scan": off-white paper with noise, lines of dark word blocks and a margin shadow. */
export function scan(width: number, height: number, seed: number): Pixels {
  const r = new Rng(seed);
  const data = new Uint8Array(width * height);
  const marginX = Math.round(width * 0.1);
  const lineH = Math.max(8, Math.round(height / 60));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shade = x < width * 0.03 ? 40 * (1 - x / (width * 0.03)) : 0;
      data[y * width + x] = clamp(236 - shade + (r.next() - 0.5) * 22);
    }
  }
  for (let ly = Math.round(height * 0.08); ly + lineH < height * 0.92; ly += Math.round(lineH * 1.8)) {
    let x = marginX;
    while (x < width - marginX) {
      const w = r.int(lineH, lineH * 6);
      if (x + w > width - marginX) break;
      const ink = r.int(20, 70);
      for (let y = ly; y < ly + lineH * 0.7; y++) {
        for (let xx = x; xx < x + w; xx++) data[y * width + xx] = clamp(ink + (r.next() - 0.5) * 30);
      }
      x += w + r.int(lineH >> 1, lineH);
    }
  }
  return { width, height, comps: 1, data };
}

/** Flat colour bands: compresses extremely well with Flate (a "no gain" candidate). */
export function flat(width: number, height: number, comps: 1 | 3 | 4 = 3): Pixels {
  const data = new Uint8Array(width * height * comps);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.floor((x / width) * 6) + 6 * Math.floor((y / height) * 4);
      for (let k = 0; k < comps; k++) data[(y * width + x) * comps + k] = (band * (37 + 50 * k)) % 256;
    }
  }
  return { width, height, comps, data };
}

/** Deterministic noise (a soft mask / alpha channel candidate), 1 component. */
export function alphaRamp(width: number, height: number, seed: number): Pixels {
  const r = new Rng(seed);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x / width - 0.5;
      const dy = y / height - 0.5;
      data[y * width + x] = clamp(255 - 600 * (dx * dx + dy * dy) + (r.next() - 0.5) * 30);
    }
  }
  return { width, height, comps: 1, data };
}

// ---------------------------------------------------------------------------------------------
// Predictors

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Apply PNG filter `type` (0-4) to one row. */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): void {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const x = row[i];
    let v: number;
    switch (type) {
      case 0: v = x; break;
      case 1: v = x - a; break;
      case 2: v = x - b; break;
      case 3: v = x - ((a + b) >> 1); break;
      default: v = x - paeth(a, b, c); break;
    }
    out[i] = v & 255;
  }
}

/**
 * PNG-style row filtering as used with /Predictor >= 10. `mode` is a fixed filter type, 'cycle'
 * (row i uses type i mod 5) or 'best' (libpng's minimum-sum-of-absolute-differences heuristic).
 */
export function pngPredict(p: Pixels, mode: 0 | 1 | 2 | 3 | 4 | 'cycle' | 'best'): { data: Uint8Array; used: Set<number> } {
  const rowLen = p.width * p.comps;
  const out = new Uint8Array((rowLen + 1) * p.height);
  let prev = new Uint8Array(rowLen);
  const tmp = new Uint8Array(rowLen);
  const used = new Set<number>();
  for (let y = 0; y < p.height; y++) {
    const row = p.data.subarray(y * rowLen, (y + 1) * rowLen);
    let type: number;
    if (mode === 'cycle') type = y % 5;
    else if (mode === 'best') {
      let best = Infinity;
      type = 0;
      for (let t = 0; t < 5; t++) {
        filterRow(t, row, prev, p.comps, tmp);
        let sum = 0;
        for (let i = 0; i < rowLen; i++) sum += tmp[i] < 128 ? tmp[i] : 256 - tmp[i];
        if (sum < best) {
          best = sum;
          type = t;
        }
      }
    } else type = mode;
    used.add(type);
    const o = y * (rowLen + 1);
    out[o] = type;
    filterRow(type, row, prev, p.comps, out.subarray(o + 1, o + 1 + rowLen));
    prev = row as Uint8Array<ArrayBuffer>;
  }
  return { data: out, used };
}

/** TIFF predictor 2 (horizontal differencing), 8 bits per component. */
export function tiffPredict(p: Pixels): Uint8Array {
  const rowLen = p.width * p.comps;
  const out = new Uint8Array(p.data.length);
  for (let y = 0; y < p.height; y++) {
    const o = y * rowLen;
    for (let i = 0; i < rowLen; i++) out[o + i] = (p.data[o + i] - (i >= p.comps ? p.data[o + i - p.comps] : 0)) & 255;
  }
  return out;
}

/** Samples at 16 bits per component (big-endian), from 8-bit data. */
export function to16Bit(p: Pixels): Uint8Array {
  const out = new Uint8Array(p.data.length * 2);
  for (let i = 0; i < p.data.length; i++) {
    out[2 * i] = p.data[i];
    out[2 * i + 1] = p.data[i];
  }
  return out;
}

/** Quantize RGB to a 6x6x6 palette: returns [indices, palette bytes]. */
export function toIndexed(p: Pixels): { data: Uint8Array; palette: Uint8Array } {
  const data = new Uint8Array(p.width * p.height);
  for (let i = 0; i < data.length; i++) {
    const q = (v: number): number => Math.min(5, Math.round(v / 51));
    data[i] = q(p.data[3 * i]) * 36 + q(p.data[3 * i + 1]) * 6 + q(p.data[3 * i + 2]);
  }
  const palette = new Uint8Array(216 * 3);
  for (let i = 0; i < 216; i++) {
    palette[3 * i] = Math.floor(i / 36) * 51;
    palette[3 * i + 1] = (Math.floor(i / 6) % 6) * 51;
    palette[3 * i + 2] = (i % 6) * 51;
  }
  return { data, palette };
}

/** 1 bit per pixel mask (1 = paint for /ImageMask with default /Decode). */
export function bitmap(width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (((x >> 4) + (y >> 4)) % 2 === 0 || Math.hypot(x - width / 2, y - height / 2) < width / 4) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// JPEG

export interface JpegOptions {
  quality?: number;
  /** Encode as 4-component CMYK (Adobe) JPEG. */
  cmyk?: boolean;
  /** Embed sharp's sRGB ICC profile (APP2). */
  icc?: boolean;
  progressive?: boolean;
}

export async function jpeg(p: Pixels, o: JpegOptions = {}): Promise<Uint8Array> {
  let img = sharp(p.data, { raw: { width: p.width, height: p.height, channels: p.comps } });
  if (o.cmyk) img = img.toColourspace('cmyk');
  else if (p.comps === 1) img = img.toColourspace('b-w');
  if (o.icc) img = img.withIccProfile('srgb');
  const buf = await img.jpeg({ quality: o.quality ?? 92, progressive: o.progressive ?? false, chromaSubsampling: '4:4:4' }).toBuffer();
  return new Uint8Array(buf);
}

/** Insert an Adobe APP14 marker with the given transform flag right after SOI. */
export function withAdobeMarker(j: Uint8Array, transform: number): Uint8Array {
  const app14 = new Uint8Array([0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform]);
  return concatBytes([j.subarray(0, 2), app14, j.subarray(2)]);
}

/** Re-label a baseline JPEG's SOF0 as SOF3 (lossless): a header only codecs must refuse. */
export function withSofMarker(j: Uint8Array, marker: number): Uint8Array {
  const out = j.slice();
  for (let i = 2; i + 3 < out.length; ) {
    const m = out[i + 1];
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      out[i + 1] = marker;
      return out;
    }
    i += 2 + ((out[i + 2] << 8) | out[i + 3]);
  }
  throw new Error('no SOF');
}

/** sharp's built-in sRGB ICC profile (a real, small v2 profile). */
export async function srgbProfile(): Promise<Uint8Array> {
  const meta = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } })
    .withIccProfile('srgb')
    .jpeg()
    .toBuffer()
    .then((b) => sharp(b).metadata());
  if (!meta.icc) throw new Error('sharp did not embed an ICC profile');
  return new Uint8Array(meta.icc);
}

/** A minimal but valid ICC v2 monochrome display profile (gray TRC gamma 2.2, D50). */
export function grayProfile(): Uint8Array {
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const s15 = (v: number): number[] => u32(Math.round(v * 65536) >>> 0);
  const sig = (s: string): number[] => Array.from(bytes(s));
  const pad4 = (a: number[]): number[] => (a.length % 4 ? [...a, ...new Array(4 - (a.length % 4)).fill(0)] : a);
  const desc = (s: string): number[] =>
    pad4([...sig('desc'), 0, 0, 0, 0, ...u32(s.length + 1), ...sig(s), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Array(67).fill(0)]);
  const tags: [string, number[]][] = [
    ['desc', desc('pdfgen gray')],
    ['wtpt', [...sig('XYZ '), 0, 0, 0, 0, ...s15(0.9642), ...s15(1), ...s15(0.8249)]],
    ['kTRC', pad4([...sig('curv'), 0, 0, 0, 0, ...u32(1), 0x02, 0x33])],
    ['cprt', pad4([...sig('text'), 0, 0, 0, 0, ...sig('No copyright'), 0])],
  ];
  const tableLen = 4 + 12 * tags.length;
  let off = 128 + tableLen;
  const table: number[] = [...u32(tags.length)];
  const data: number[] = [];
  for (const [name, body] of tags) {
    table.push(...sig(name), ...u32(off), ...u32(body.length));
    data.push(...body);
    off += body.length;
  }
  const size = off;
  const header = [
    ...u32(size), 0, 0, 0, 0, 0x02, 0x10, 0, 0, ...sig('mntr'), ...sig('GRAY'), ...sig('XYZ '),
    0x07, 0xea, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, // 2026-01-01
    ...sig('acsp'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ...s15(0.9642), ...s15(1), ...s15(0.8249), 0, 0, 0, 0,
  ];
  while (header.length < 128) header.push(0);
  return new Uint8Array([...header, ...table, ...data]);
}
