/**
 * Color spaces (ISO 32000 8.6) reduced to what a screen renderer needs: conversion to sRGB. CalGray,
 * CalRGB and Lab are converted exactly; ICCBased goes through /Alternate or the device space with
 * /N components (profiles are not parsed); DeviceCMYK through a polynomial fitted to MuPDF's
 * color-managed conversion.
 */
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { intOf, nameOf, numOf, PdfDict, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { stringBytes } from '../core/strings.ts';
import { clamp, loadFunction, numArray, type PdfFunction } from './function.ts';

export interface ColorSpace {
  /** Family name: DeviceGray, DeviceRGB, DeviceCMYK, CalGray, CalRGB, Lab, ICCBased, Indexed, Separation, DeviceN, Pattern. */
  readonly name: string;
  /** Components of a color value (Indexed: 1; Pattern: those of the base space, 0 without one). */
  readonly n: number;
  /** The initial color of the space (black, index 0, tint 1, ...). */
  readonly initial: readonly number[];
  /** Default /Decode array for image samples of `bpc` bits (Indexed: [0, 2^bpc - 1]). */
  defaultDecode(bpc: number): number[];
  /** A color value as sRGB, 0-255 per channel. */
  rgb(c: ArrayLike<number>): [number, number, number];
  /**
   * Convert `count` pixels: `src` holds `n` component values per pixel from `srcOff` (already
   * mapped through /Decode); writes R, G, B to `dst` from `dstOff` with a stride of 4 (alpha
   * untouched). The fast path for images.
   */
  rgbRow(src: ArrayLike<number>, srcOff: number, count: number, dst: Uint8ClampedArray, dstOff: number): void;
  /** Pattern spaces only: the underlying space of uncolored (PaintType 2) patterns, when given. */
  readonly base?: ColorSpace;
  /** Separation or DeviceN whose colorants are all /None: painting in it marks nothing. */
  readonly none?: boolean;
}

/** Convert one pixel: `n` components of `s` from `i` to R, G, B (0-255, clamped by `d`) at `d[j]`. */
type Px = (s: ArrayLike<number>, i: number, d: Uint8ClampedArray, j: number) => void;

const MAX_DEPTH = 8;
const MAX_COMPONENTS = 32;
/** Scratch for `rgb()`; conversions never nest. */
const T = /* @__PURE__ */ new Uint8ClampedArray(3);

function space(name: string, n: number, px: Px, initial: number[] = Array(n).fill(0), decode?: number[]): ColorSpace {
  return {
    name,
    n,
    initial,
    defaultDecode: () => decode ?? initial.flatMap(() => [0, 1]),
    rgb(c) {
      px(c, 0, T, 0);
      return [T[0], T[1], T[2]];
    },
    rgbRow(s, i, count, d, j) {
      for (let k = 0; k < count; k++, i += n, j += 4) px(s, i, d, j);
    },
  };
}

const gray: Px = (s, i, d, j) => {
  d[j] = d[j + 1] = d[j + 2] = s[i] * 255;
};
const rgb: Px = (s, i, d, j) => {
  d[j] = s[i] * 255;
  d[j + 1] = s[i + 1] * 255;
  d[j + 2] = s[i + 2] * 255;
};

/**
 * CMYK to sRGB: a quartic in c, m, y, k per channel, fitted to MuPDF's color-managed conversion
 * (lcms2, default profiles) on a 17^4 grid: white exact, each ink's own terms fitted to its tint
 * ramp first, then the rest, clipped samples counting only when the fit is inside the gamut. Mean
 * error 1.5 per channel (0-255), at most 17, primaries and tints within 10; the naive formula is off
 * by 16 on average. Coefficients follow the monomials t[a] t[b] t[e] t[h], a <= b <= e <= h, of
 * t = [1, c, m, y, k].
 */
const CMYK = [
  256, -289, -28, 0, -245, 112, 120, 78, 290, 9, 8, 30, 0, 4, 62, -121, 5, 54, 15, -68, -135, -128, -65, -117, -125, 4, -7, -3, 7, -4,
  -3, 0, 11, -1, 33, -279, 550, 124, 65, -297, -202, -94, -35, -12, -51, 71, 111, 48, 66, 69, 62, 18, 25, 42, 27, -5, 0, 2, -10, -5,
  -11, 0, -11, 17, 3, 0, -2, -5, -13, -69, 256, -113, -237, -19, -238, 30, 143, 26, 127, 73, 31, 218, 4, 27, 56, 8, -27, -21, -47,
  -156, 14, -119, -18, -19, -42, 100, -101, -53, 22, -27, -59, 1, -16, -15, 38, -7, 5, 5, 8, -30, 10, 36, 6, 3, 8, 185, -47, -16, 4,
  6, 19, 6, 1, 17, 8, -182, 107, 18, -11, 22, -15, -13, -5, 21, 2, 0, 6, 3, 3, -78, 256, -21, -133, -228, -228, 2, 12, 67, 25, 16,
  152, 134, 74, 190, 45, 4, 20, -25, -10, 12, -54, -9, -63, -75, -1, 10, -38, -44, -97, -112, -33, 33, -50, -27, 37, -1, -12, 15, 9,
  -12, 59, -11, -71, 29, -10, 0, 34, -11, -124, 66, 7, 183, -31, 29, 5, -8, 7, 12, -20, 26, 14, 157, -52, 16, -8, -146, 74, -42, 5,
  -76
];
const tc = /* @__PURE__ */ new Float64Array(5);
const cmyk: Px = (s, i, d, j) => {
  tc[0] = 1;
  for (let k = 0; k < 4; k++) tc[k + 1] = clamp(s[i + k], 0, 1);
  let r = 0;
  let g = 0;
  let b = 0;
  let q = 0;
  for (let a = 0; a < 5; a++) {
    for (let e = a; e < 5; e++) {
      for (let f = e; f < 5; f++) {
        const aef = tc[a] * tc[e] * tc[f];
        for (let h = f; h < 5; h++, q++) {
          const v = aef * tc[h];
          r += CMYK[q] * v;
          g += CMYK[q + 70] * v;
          b += CMYK[q + 140] * v;
        }
      }
    }
  }
  d[j] = r;
  d[j + 1] = g;
  d[j + 2] = b;
};

/** Rows: the polynomial on a 9^4 grid, built on first use, simplex-interpolated (5 corners of 16). */
const G = 9;
const STRIDE = [3 * G * G * G, 3 * G * G, 3 * G, 3];
let grid: Uint8ClampedArray | undefined;
/** The cell's fractions sorted, largest first, with the strides of their axes. */
const frac = /* @__PURE__ */ new Float64Array(4);
const step = /* @__PURE__ */ new Int32Array(4);
const cmykRow: Px = (s, i, d, j) => {
  if (!grid) {
    grid = new Uint8ClampedArray(3 * G ** 4);
    const c = [0, 0, 0, 0];
    for (let n = 0; n < G ** 4; n++) {
      for (let k = 0; k < 4; k++) c[k] = (Math.floor(n / G ** (3 - k)) % G) / (G - 1);
      cmyk(c, 0, grid, 3 * n);
    }
  }
  let p = 0;
  for (let k = 0; k < 4; k++) {
    const u = clamp(s[i + k], 0, 1) * (G - 1);
    const b = u < G - 1 ? u | 0 : G - 2;
    const f = u - b;
    p += b * STRIDE[k];
    let m = k;
    for (; m && frac[m - 1] < f; m--) {
      frac[m] = frac[m - 1];
      step[m] = step[m - 1];
    }
    frac[m] = f;
    step[m] = STRIDE[k];
  }
  // Walk from the cell's base corner one axis at a time, weighting by fraction differences.
  let w = 1;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < 4; k++) {
    const x = w - frac[k];
    r += x * grid[p];
    g += x * grid[p + 1];
    b += x * grid[p + 2];
    p += step[k];
    w = frac[k];
  }
  d[j] = r + w * grid[p];
  d[j + 1] = g + w * grid[p + 1];
  d[j + 2] = b + w * grid[p + 2];
};

/** Linear light to the sRGB curve, 0-255. */
const srgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
/** D50 XYZ to linear sRGB (Bradford-adapted, as color-managed renderers do). */
const SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
/** Bradford cone responses, and back. */
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867];
const D50 = [0.9642, 1, 0.8249];

/** 3 x 3 matrix product, row-major. */
const mat = (a: number[], b: number[]) => a.map((_, i) => a[i - (i % 3)] * b[i % 3] + a[i - (i % 3) + 1] * b[3 + (i % 3)] + a[i - (i % 3) + 2] * b[6 + (i % 3)]);
const diag = (v: number[]) => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
const apply3 = (m: number[], v: number[]) => [0, 3, 6].map((r) => m[r] * v[0] + m[r + 1] * v[1] + m[r + 2] * v[2]);

/** Write sRGB for linear x, y, z mapped through `m` (to linear sRGB). */
function xyzOut(m: number[], x: number, y: number, z: number, d: Uint8ClampedArray, j: number) {
  for (let r = 0; r < 3; r++) d[j + r] = srgb(m[3 * r] * x + m[3 * r + 1] * y + m[3 * r + 2] * z);
}

const labF = (t: number) => (t > 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));

/** Lab to sRGB, relative to D50 whatever the /WhitePoint (which maps to white), as MuPDF does. */
function lab(range: number[]): Px {
  return (s, i, d, j) => {
    const fy = (clamp(s[i], 0, 100) + 16) / 116;
    const x = D50[0] * labF(fy + clamp(s[i + 1], range[0], range[1]) / 500);
    const z = D50[2] * labF(fy - clamp(s[i + 2], range[2], range[3]) / 200);
    xyzOut(SRGB, x, labF(fy), z, d, j);
  };
}

/**
 * CalRGB: gamma per component, /Matrix to XYZ, the /WhitePoint adapted to D50 (Bradford), then to
 * sRGB, all but the gammas folded into one matrix. (CalGray reduces to the gamma alone.)
 */
function calRgb(wp: number[], gamma: number[], m: number[]): Px {
  const w = apply3(BRADFORD, wp);
  const adapt = mat(BRADFORD_INV, mat(diag(apply3(BRADFORD, D50).map((v, k) => v / w[k])), BRADFORD));
  const k = mat(SRGB, mat(adapt, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]));
  return (s, i, d, j) => xyzOut(k, clamp(s[i], 0, 1) ** gamma[0], clamp(s[i + 1], 0, 1) ** gamma[1], clamp(s[i + 2], 0, 1) ** gamma[2], d, j);
}

const DEVICE: Record<string, [number, Px]> = { DeviceGray: [1, gray], DeviceRGB: [3, rgb], DeviceCMYK: [4, cmyk] };
/** Inline-image abbreviations. */
const ALIAS: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };
const cache: Record<string, ColorSpace> = {};

function device(name: string): ColorSpace {
  const [n, px] = DEVICE[name];
  // CMYK rows use the table; single colors the polynomial itself.
  return (cache[name] ??= n === 4 ? { ...space(name, 4, cmykRow, [0, 0, 0, 1]), rgb: space(name, 4, px).rgb } : space(name, n, px));
}

/** A 1-component space through a 256-entry table for rows, `exact` for single colors. */
function tabled(name: string, exact: (c: ArrayLike<number>) => [number, number, number]): ColorSpace {
  const lut = new Uint8Array(768);
  for (let k = 0; k < 256; k++) lut.set(exact([k / 255]), 3 * k);
  const px: Px = (s, i, d, j) => {
    const k = 3 * Math.round(clamp(s[i], 0, 1) * 255);
    d[j] = lut[k];
    d[j + 1] = lut[k + 1];
    d[j + 2] = lut[k + 2];
  };
  return { ...space(name, 1, px, [1]), rgb: exact };
}

/**
 * Load a color space: a name (DeviceRGB, the inline-image abbreviations G/RGB/CMYK/I, or a key of
 * the /ColorSpace resource dictionary `colorSpaces`) or an array. Undefined when unusable.
 */
export function loadColorSpace(doc: PdfDocument, o: PdfObj | undefined, colorSpaces?: PdfDict): Promise<ColorSpace | undefined> {
  return load(doc, o, colorSpaces, 0, false);
}

async function load(doc: PdfDocument, o: PdfObj | undefined, res: PdfDict | undefined, depth: number, noDefault: boolean): Promise<ColorSpace | undefined> {
  if (depth > MAX_DEPTH) return undefined;
  const sub = (x: PdfObj | undefined, nd = false) => load(doc, x, res, depth + 1, nd);
  const v = await doc.resolve(o);
  const arr = Array.isArray(v) ? v : [v ?? null];
  const name = nameOf(await doc.resolve(arr[0]));
  if (name === undefined) return undefined;
  // Own properties only: names come from the file (think /constructor).
  const fam = Object.hasOwn(ALIAS, name) ? ALIAS[name] : name;
  if (Object.hasOwn(DEVICE, fam)) {
    // A /DefaultGray (RGB, CMYK) resource replaces the device space, when it fits.
    const def = noDefault ? undefined : res?.get('Default' + fam.slice(6));
    const cs = def && (await sub(def, true));
    return cs && cs.n === DEVICE[fam][0] ? cs : device(fam);
  }
  if (fam === 'Pattern') {
    const base = arr.length > 1 ? await sub(arr[1]) : undefined;
    return { ...(base ?? space(fam, 0, gray)), name: fam, n: base ? base.n : 0, base };
  }
  if (arr.length < 2) return res && !Array.isArray(v) ? sub(res.get(name)) : undefined;
  const p1 = await doc.resolve(arr[1]);
  const dict = p1 instanceof PdfDict ? p1 : undefined;

  if (fam === 'CalGray' || fam === 'CalRGB') {
    const g = (await numArray(doc, dict?.get('Gamma'))) ?? [];
    const g1 = numOf(await doc.resolve(dict?.get('Gamma'))) ?? 1;
    if (fam === 'CalGray') return space(fam, 1, (s, i, d, j) => void (d[j] = d[j + 1] = d[j + 2] = srgb(clamp(s[i], 0, 1) ** g1)));
    const wp = (await numArray(doc, dict?.get('WhitePoint'))) ?? [];
    const m = (await numArray(doc, dict?.get('Matrix'))) ?? [];
    return space(fam, 3, calRgb(wp.length === 3 && wp[1] > 0 ? wp : D50, g.length === 3 ? g : [1, 1, 1], m.length === 9 ? m : diag([1, 1, 1])));
  }
  if (fam === 'Lab') {
    const r = (await numArray(doc, dict?.get('Range'))) ?? [];
    const range = r.length >= 4 ? r.slice(0, 4) : [-100, 100, -100, 100];
    return space(fam, 3, lab(range), [0, clamp(0, range[0], range[1]), clamp(0, range[2], range[3])], [0, 100, ...range]);
  }
  if (fam === 'ICCBased') {
    // The profile itself is not parsed: /Alternate, or the device space with /N components.
    const n = intOf(await doc.resolve(dict?.get('N')));
    const alt = dict?.get('Alternate') ? await sub(dict.get('Alternate')) : undefined;
    const cs = alt && alt.n === n ? alt : n === 1 ? device('DeviceGray') : n === 3 ? device('DeviceRGB') : n === 4 ? device('DeviceCMYK') : undefined;
    const range = await numArray(doc, dict?.get('Range'));
    return cs && { ...cs, name: fam, defaultDecode: range && range.length >= 2 * cs.n ? () => range : cs.defaultDecode };
  }
  if (fam === 'Indexed') {
    const base = await sub(arr[1]);
    const hival = clamp(intOf(await doc.resolve(arr[2])) ?? -1, -1, 255);
    const l = await doc.resolve(arr[3]);
    const data = l instanceof PdfString ? stringBytes(l) : arr[3] instanceof PdfRef ? await readStream(doc, arr[3], 1 << 16) : null;
    if (!base || !base.n || hival < 0 || !data) return undefined;
    // Table bytes span each base component's range (Lab's is not [0, 1]).
    const r = base.defaultDecode(8);
    const lut = new Uint8Array(3 * hival + 3);
    const c: number[] = [];
    for (let k = 0; k <= hival; k++) {
      for (let q = 0; q < base.n; q++) c[q] = r[2 * q] + ((data[k * base.n + q] ?? 0) * (r[2 * q + 1] - r[2 * q])) / 255;
      lut.set(base.rgb(c), 3 * k);
    }
    const px: Px = (s, i, d, j) => {
      const k = 3 * Math.round(clamp(s[i], 0, hival));
      d[j] = lut[k];
      d[j + 1] = lut[k + 1];
      d[j + 2] = lut[k + 2];
    };
    return { ...space(fam, 1, px, [0]), defaultDecode: (bpc) => [0, 2 ** bpc - 1] };
  }
  if (fam === 'Separation' || fam === 'DeviceN') {
    const names = fam === 'DeviceN' ? (Array.isArray(p1) ? p1 : []) : [p1];
    const n = names.length;
    if (!n || n > MAX_COMPONENTS) return undefined;
    const nm = names.map(nameOf);
    // /None marks nothing; /All marks every colorant, which on screen is an inverted gray.
    if (nm.every((x) => x === 'None')) return { ...space(fam, n, gray, Array(n).fill(1)), none: true };
    if (nm[0] === 'All' && n === 1) {
      return tabled(fam, (c) => {
        const v = Math.round(255 - 255 * clamp(c[0], 0, 1));
        return [v, v, v];
      });
    }
    const alt = await sub(arr[2]);
    const fn = await loadFunction(doc, arr[3]);
    if (!alt || !alt.n || alt.name === 'Pattern' || !fn) return undefined;
    const out: number[] = [];
    const exact = (c: ArrayLike<number>) => alt.rgb(fn(c, out));
    if (n === 1) return tabled(fam, exact);
    return { ...space(fam, n, devicen(n, fn, alt), Array(n).fill(1)), rgb: exact };
  }
  return undefined;
}

/**
 * DeviceN pixels through the tint transform, memoized on the 8-bit quantized input for up to four
 * components (images tend to repeat colors; tint transforms can be slow calculator functions).
 */
function devicen(n: number, fn: PdfFunction, alt: ColorSpace): Px {
  const inp: number[] = [];
  const out: number[] = [];
  const memo = new Map<number, number>();
  return (s, i, d, j) => {
    let key = n <= 4 ? 0 : -1;
    for (let k = 0; k < n; k++) {
      inp[k] = s[i + k];
      if (key >= 0) key = key * 256 + Math.round(clamp(inp[k], 0, 1) * 255);
    }
    const hit = memo.get(key);
    if (hit !== undefined) {
      d[j] = hit >> 16;
      d[j + 1] = (hit >> 8) & 255;
      d[j + 2] = hit & 255;
      return;
    }
    alt.rgbRow(fn(inp, out), 0, 1, d, j);
    if (key >= 0) {
      if (memo.size > 65535) memo.clear();
      memo.set(key, (d[j] << 16) | (d[j + 1] << 8) | d[j + 2]);
    }
  };
}
