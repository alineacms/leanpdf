/**
 * Shadings (ISO 32000 8.7.4.5). Axial and radial shadings become color stops for the browser's own
 * gradients; function-based and mesh shadings are rasterized for a given device transform, with
 * Gouraud-interpolated triangles (patches are subdivided into them).
 */
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { intOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import { loadColorSpace } from './colorspace.ts';
import { clamp, lerp, loadFunction, numArray } from './function.ts';
import { invert, mul, type Matrix } from './util.ts';

export interface GradientStop {
  /** 0..1 along the gradient. */
  offset: number;
  /** sRGB, 0-255. */
  color: [number, number, number];
}

type Box = [number, number, number, number];

/**
 * A shading, prepared for painting. Axial and radial shadings become gradient stops for the
 * browser's own linear and radial gradients (the painter handles /Extend); function-based and
 * mesh shadings are rasterized for a given device transform.
 */
export type ShadingPaint =
  | { kind: 'axial'; coords: [number, number, number, number]; stops: GradientStop[]; extend: [boolean, boolean]; bbox?: Box; background?: [number, number, number] }
  | { kind: 'radial'; coords: [number, number, number, number, number, number]; stops: GradientStop[]; extend: [boolean, boolean]; bbox?: Box; background?: [number, number, number] }
  | {
      kind: 'raster';
      /**
       * Extent in shading space, when known: /BBox, else the mesh's (or function domain's) bounds,
       * unless a /Background is to fill beyond them.
       */
      bbox?: Box;
      background?: [number, number, number];
      /**
       * Rasterize into a `width` x `height` RGBA buffer, `matrix` mapping shading space to its
       * pixels (y down). Alpha is 0 where the shading paints nothing.
       */
      render(matrix: number[], width: number, height: number): Uint8ClampedArray;
    };

/** Samples of a gradient's function before redundant stops are dropped. */
const STOPS = 256;
/** Color difference (0-255) a dropped stop may leave. */
const STOP_TOLERANCE = 1;
/** Function evaluations for a function-based shading; pixels in between are interpolated. */
const MAX_EVALS = 1 << 18;
/** Triangles read from a mesh or subdivided from patches, and patches read. */
const MAX_TRIANGLES = 1 << 18;
const MAX_PATCHES = 1 << 16;
/** Pixels painted per raster pixel (overlapping triangles) before painting stops. */
const MAX_OVERDRAW = 16;
/** Stitching bounds made exact stops (more are only sampled). */
const MAX_BOUNDS = 1024;
/** Target size of a patch grid cell, in device pixels. */
const CELL = 4;
const MAX_MESH_BYTES = 32 << 20;
/** Entries of the color table for parametric (/Function) meshes. */
const LUT = 1024;

type Rgb = [number, number, number];

/** Load a shading dictionary or stream (types 1-7). `colorSpaces` is the resource /ColorSpace dictionary. Undefined when unusable. */
/** Shadings by object number, per document (or per /ColorSpace resources, which /Default spaces come from). */
const loaded = /* @__PURE__ */ new WeakMap<PdfDocument | PdfDict, Map<number, Promise<ShadingPaint | undefined>>>();

export function loadShading(doc: PdfDocument, o: PdfObj | undefined, colorSpaces?: PdfDict): Promise<ShadingPaint | undefined> {
  if (!(o instanceof PdfRef)) return build(doc, o, colorSpaces);
  const owner = colorSpaces ?? doc;
  let m = loaded.get(owner);
  if (!m) loaded.set(owner, (m = new Map()));
  let s = m.get(o.num);
  if (!s) {
    m.set(o.num, (s = build(doc, o, colorSpaces)));
    // A read error isn't kept.
    s.catch(() => m.delete(o.num));
  }
  return s;
}

async function build(doc: PdfDocument, o: PdfObj | undefined, colorSpaces?: PdfDict): Promise<ShadingPaint | undefined> {
  const d = await doc.resolve(o);
  if (!(d instanceof PdfDict)) return undefined;
  const get = (k: string) => doc.resolve(d.get(k));
  const type = intOf(await get('ShadingType')) ?? 0;
  const cs = await loadColorSpace(doc, d.get('ColorSpace'), colorSpaces);
  if (!cs || !cs.n || cs.name === 'Pattern' || cs.none) return undefined;
  const fo = d.get('Function');
  const fn = fo === undefined ? undefined : await loadFunction(doc, fo);
  if ((fo !== undefined || type < 4) && !fn) return undefined;
  const tmp: number[] = [];
  const color = (v: number[]) => cs.rgb(fn ? fn(v, tmp) : v);
  const b = await numArray(doc, d.get('BBox'));
  const bbox: Box | undefined = b && b.length >= 4 ? [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] : undefined;
  const bg = await numArray(doc, d.get('Background'));
  const background = bg && bg.length >= cs.n ? cs.rgb(bg) : undefined;
  // Without a /BBox, the geometry's bounds limit the raster, unless a background fills beyond it.
  const ext: Box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number) => {
    ext[0] = Math.min(ext[0], x);
    ext[1] = Math.min(ext[1], y);
    ext[2] = Math.max(ext[2], x);
    ext[3] = Math.max(ext[3], y);
  };
  const extent = () => bbox ?? (background || !(ext[0] <= ext[2]) ? undefined : ext);

  if (type === 2 || type === 3) {
    const coords = await numArray(doc, d.get('Coords'));
    const [t0, t1] = (await numArray(doc, d.get('Domain'))) ?? [0, 1];
    const e = await get('Extend');
    const extend: [boolean, boolean] = Array.isArray(e) ? [e[0] === true, e[1] === true] : [false, false];
    if (!coords || coords.length < (type === 2 ? 4 : 6) || (type === 3 && (coords[2] < 0 || coords[5] < 0))) return undefined;
    const stops = gradientStops((t) => color([t]), t0, t1, fn!.bounds ?? []);
    return type === 2
      ? { kind: 'axial', coords: coords.slice(0, 4) as [number, number, number, number], stops, extend, bbox, background }
      : { kind: 'radial', coords: coords.slice(0, 6) as [number, number, number, number, number, number], stops, extend, bbox, background };
  }

  if (type === 1) {
    const dom = (await numArray(doc, d.get('Domain'))) ?? [0, 1, 0, 1];
    const mt = (await numArray(doc, d.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
    if (dom.length < 4 || mt.length < 6) return undefined;
    const [x0, x1, y0, y1] = dom;
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) grow(...apply(mt, x, y));
    const at = [0, 0];
    return {
      kind: 'raster',
      bbox: extent(),
      background,
      render(matrix, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        const inv = invert(mul(mt, matrix));
        if (!inv) return out;
        // Colors on a grid of `s` pixel steps, bilinear in between.
        const s = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_EVALS)));
        const gw = Math.ceil((w - 1) / s) + 2;
        const gh = Math.ceil((h - 1) / s) + 2;
        const grid = new Float32Array(gw * gh * 3);
        for (let gy = 0; gy < gh; gy++) {
          for (let gx = 0; gx < gw; gx++) {
            const [x, y] = apply(inv, gx * s + 0.5, gy * s + 0.5);
            at[0] = clamp(x, Math.min(x0, x1), Math.max(x0, x1));
            at[1] = clamp(y, Math.min(y0, y1), Math.max(y0, y1));
            grid.set(color(at), (gy * gw + gx) * 3);
          }
        }
        for (let py = 0, o = 0; py < h; py++) {
          const gy = Math.floor(py / s);
          const fy = (py - gy * s) / s;
          for (let px = 0; px < w; px++, o += 4) {
            const [x, y] = apply(inv, px + 0.5, py + 0.5);
            if ((x - x0) * (x - x1) > 0 || (y - y0) * (y - y1) > 0) continue;
            const gx = Math.floor(px / s);
            const fx = (px - gx * s) / s;
            const g = (gy * gw + gx) * 3;
            for (let c = 0; c < 3; c++) {
              const top = grid[g + c] + fx * (grid[g + 3 + c] - grid[g + c]);
              const bot = grid[g + gw * 3 + c] + fx * (grid[g + gw * 3 + 3 + c] - grid[g + gw * 3 + c]);
              out[o + c] = top + fy * (bot - top);
            }
            out[o + 3] = 255;
          }
        }
        return out;
      },
    };
  }

  if (type < 4 || type > 7 || !(o instanceof PdfRef)) return undefined;
  const data = await readStream(doc, o, MAX_MESH_BYTES);
  const bpc = intOf(await get('BitsPerCoordinate')) ?? 0;
  const bpv = intOf(await get('BitsPerComponent')) ?? 0;
  const bpf = type === 5 ? 0 : (intOf(await get('BitsPerFlag')) ?? 0);
  const vpr = intOf(await get('VerticesPerRow')) ?? 0;
  const na = fn ? 1 : cs.n;
  const dec = await numArray(doc, d.get('Decode'));
  if (!data || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bpc) || ![1, 2, 4, 8, 12, 16].includes(bpv) || (type !== 5 && ![2, 4, 8].includes(bpf))) return undefined;
  if (!dec || dec.length < 4 + 2 * na || (type === 5 && vpr < 2)) return undefined;

  // Vertex records are byte-aligned for types 4 and 5, patches for 6 and 7 (as Adobe and
  // Ghostscript read them).
  let pos = 0;
  const end = data.length * 8;
  const read = (n: number) => {
    let v = 0;
    for (let left = n; left > 0; ) {
      const take = Math.min(left, 8 - (pos & 7));
      v = v * 2 ** take + ((data[pos >> 3] >> (8 - (pos & 7) - take)) & ((1 << take) - 1));
      pos += take;
      left -= take;
    }
    return v;
  };
  const align = () => (pos = (pos + 7) & ~7);
  const sample = (bits: number, i: number) => lerp(read(bits), 0, 2 ** bits - 1, dec[2 * i], dec[2 * i + 1]);
  /** Read a point onto `out`. */
  const point = (out: number[]) => {
    const x = sample(bpc, 0);
    const y = sample(bpc, 1);
    grow(x, y);
    out.push(x, y);
  };
  /** Read a color (or t) onto `out`. */
  const col = (out: number[]) => {
    for (let k = 0; k < na; k++) out.push(sample(bpv, k + 2));
  };
  // Vertices as x, y, then `na` color values (or t); triangles as vertex indexes.
  const S = 2 + na;
  const verts: number[] = [];
  const tris: number[] = [];
  const patches: number[] = [];
  if (type === 4 || type === 5) {
    const vbits = bpf + 2 * bpc + na * bpv;
    for (let need = 0, prev = [-1, -1, -1]; pos + vbits <= end && verts.length < 3 * S * MAX_TRIANGLES; align()) {
      const f = bpf ? read(bpf) : 0;
      const i = verts.length / S;
      point(verts);
      col(verts);
      if (type === 5) {
        const r = Math.floor(i / vpr);
        const c = i % vpr;
        if (r && c) tris.push(i - vpr - 1, i - vpr, i - 1, i - vpr, i, i - 1);
      } else if (need) {
        prev.push(i);
        if (!--need) tris.push(...(prev = prev.slice(-3)));
      } else if (f === 0) {
        prev = [i];
        need = 2;
      } else if (prev[0] >= 0 && f < 3) tris.push(...(prev = f === 1 ? [prev[1], prev[2], i] : [prev[0], prev[2], i]));
    }
  } else {
    // Patches: the 12 boundary points in stream order, as indexes into the 4 x 4 control grid
    // (u major), then the 4 inner points of tensor patches; corner colors at loop points 0, 3, 6, 9.
    const LOOP = [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4];
    const INNER = [5, 6, 10, 9];
    const P = 32 + 4 * na;
    let prev = -1;
    for (; pos + bpf <= end && patches.length < P * MAX_PATCHES; align()) {
      const f = read(bpf);
      if (f > 3 || (f && prev < 0)) break;
      const p = patches.length;
      const pts: number[] = [];
      const cols: number[] = [];
      const loopAt = (base: number, k: number) => base + 2 * LOOP[k % 12];
      if (f) {
        // The first edge and its two colors come from the previous patch.
        for (let k = 0; k < 4; k++) pts.push(patches[loopAt(prev, 3 * f + k)], patches[loopAt(prev, 3 * f + k) + 1]);
        for (const c of [f, (f + 1) & 3]) for (let k = 0; k < na; k++) cols.push(patches[prev + 32 + c * na + k]);
      }
      const need = (f ? 8 : 12) + (type === 7 ? 4 : 0);
      if (pos + need * 2 * bpc + (f ? 2 : 4) * na * bpv > end) break;
      for (let k = 0; k < need; k++) point(pts);
      while (cols.length < 4 * na) col(cols);
      patches.length = p + P;
      const order = type === 7 ? LOOP.concat(INNER) : LOOP;
      for (let k = 0; k < order.length; k++) {
        patches[p + 2 * order[k]] = pts[2 * k];
        patches[p + 2 * order[k] + 1] = pts[2 * k + 1];
      }
      if (type === 6) coonsInner(patches, p);
      for (let k = 0; k < 4 * na; k++) patches[p + 32 + k] = cols[k];
      prev = p;
    }
  }
  if (!tris.length && !patches.length) return undefined;

  // Parametric meshes: a table of colors over the /Decode range of t.
  let lut: Uint8ClampedArray | undefined;
  const [ta, tb] = [dec[4], dec[5]];
  if (fn) {
    lut = new Uint8ClampedArray(3 * LUT);
    for (let k = 0; k < LUT; k++) lut.set(color([lerp(k, 0, LUT - 1, ta, tb)]), 3 * k);
  }
  return {
    kind: 'raster',
    bbox: extent(),
    background,
    render(matrix, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      const buf = new Float32Array(w * na);
      const gx: number[] = [];
      const gy: number[] = [];
      let work = MAX_OVERDRAW * w * h;
      /** Paint `cnt` pixels of `buf` at byte offset `o`. */
      const paint = (cnt: number, o: number) => {
        if (lut) {
          for (let i = 0; i < cnt; i++, o += 4) {
            const k = 3 * Math.round(clamp(lerp(buf[i], ta, tb, 0, LUT - 1), 0, LUT - 1));
            out[o] = lut[k];
            out[o + 1] = lut[k + 1];
            out[o + 2] = lut[k + 2];
            out[o + 3] = 255;
          }
        } else {
          cs.rgbRow(buf, 0, cnt, out, o);
          for (let i = 0; i < cnt; i++) out[o + 4 * i + 3] = 255;
        }
      };
      /** Fill the triangle of vertices at offsets a, b, c of `v` (device space), pixel centers in. */
      const fill = (v: Float64Array, a: number, b: number, c: number) => {
        if (v[b + 1] < v[a + 1]) [a, b] = [b, a];
        if (v[c + 1] < v[a + 1]) [a, c] = [c, a];
        if (v[c + 1] < v[b + 1]) [b, c] = [c, b];
        const x0 = v[a], y0 = v[a + 1], x1 = v[b], y1 = v[b + 1], x2 = v[c], y2 = v[c + 1];
        const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (!det) return;
        for (let k = 0; k < na; k++) {
          const d1 = v[b + 2 + k] - v[a + 2 + k];
          const d2 = v[c + 2 + k] - v[a + 2 + k];
          gx[k] = (d1 * (y2 - y0) - d2 * (y1 - y0)) / det;
          gy[k] = (d2 * (x1 - x0) - d1 * (x2 - x0)) / det;
        }
        const ye = Math.min(h, Math.ceil(y2 - 0.5));
        for (let py = Math.max(0, Math.ceil(y0 - 0.5)); py < ye && work > 0; py++) {
          const yc = py + 0.5;
          const xa = x0 + ((yc - y0) * (x2 - x0)) / (y2 - y0);
          const xb = yc < y1 ? x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0) : x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1);
          const xs = Math.max(0, Math.ceil(Math.min(xa, xb) - 0.5));
          const cnt = Math.min(w, Math.ceil(Math.max(xa, xb) - 0.5)) - xs;
          if (cnt <= 0) continue;
          work -= cnt;
          for (let k = 0; k < na; k++) {
            let val = v[a + 2 + k] + gx[k] * (xs + 0.5 - x0) + gy[k] * (yc - y0);
            for (let i = k; i < cnt * na; i += na, val += gx[k]) buf[i] = val;
          }
          paint(cnt, (py * w + xs) * 4);
        }
      };
      if (tris.length) {
        const dv = Float64Array.from(verts);
        for (let i = 0; i < dv.length; i += S) [dv[i], dv[i + 1]] = apply(matrix, dv[i], dv[i + 1]);
        for (let i = 0; i < tris.length; i += 3) fill(dv, tris[i] * S, tris[i + 1] * S, tris[i + 2] * S);
        return out;
      }
      // Patches: one grid size for all (so shared edges meet), from the largest device extent.
      const P = 32 + 4 * na;
      const count = patches.length / P;
      let ext = 0;
      for (let p = 0; p < patches.length; p += P) {
        for (let i = 0; i < 16; i++) {
          const [x, y] = apply(matrix, patches[p + 2 * i], patches[p + 2 * i + 1]);
          const [x2, y2] = apply(matrix, patches[p + 2 * (i ^ 1)], patches[p + 2 * (i ^ 1) + 1]);
          const [x3, y3] = apply(matrix, patches[p + 2 * (i ^ 4)], patches[p + 2 * (i ^ 4) + 1]);
          ext = Math.max(ext, Math.hypot(x2 - x, y2 - y), Math.hypot(x3 - x, y3 - y));
        }
      }
      const n = Math.max(1, Math.min(Math.ceil((3 * ext) / CELL), Math.floor(Math.sqrt(MAX_TRIANGLES / 2 / count)), 64));
      const bern = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      const B = Array.from({ length: n + 1 }, (_, k) => bern(k / n));
      const g = new Float64Array((n + 1) * (n + 1) * S);
      for (let p = 0; p < patches.length; p += P) {
        for (let iv = 0, o = 0; iv <= n; iv++) {
          for (let iu = 0; iu <= n; iu++, o += S) {
            let x = 0;
            let y = 0;
            for (let i = 0; i < 4; i++) {
              for (let j = 0; j < 4; j++) {
                const wt = B[iu][i] * B[iv][j];
                x += wt * patches[p + 8 * i + 2 * j];
                y += wt * patches[p + 8 * i + 2 * j + 1];
              }
            }
            [g[o], g[o + 1]] = apply(matrix, x, y);
            // Corner colors c00, c03, c33, c30, bilinear in u and v.
            const u = iu / n;
            const v = iv / n;
            for (let k = 0, q = p + 32; k < na; k++, q++) {
              g[o + 2 + k] = (1 - u) * ((1 - v) * patches[q] + v * patches[q + na]) + u * (v * patches[q + 2 * na] + (1 - v) * patches[q + 3 * na]);
            }
          }
        }
        // Larger v paints over smaller, then larger u (for patches that fold over themselves).
        for (let iv = 0; iv < n; iv++) {
          for (let iu = 0; iu < n; iu++) {
            const q = (iv * (n + 1) + iu) * S;
            const r = q + (n + 1) * S;
            fill(g, q, q + S, r);
            fill(g, q + S, r + S, r);
          }
        }
      }
      return out;
    },
  };
}

/** Coons patch: the inner control points of the equivalent tensor-product patch (u major grid). */
function coonsInner(p: number[], at: number) {
  for (const [a, b] of [[0, 0], [0, 3], [3, 0], [3, 3]]) {
    const q = (i: number, j: number, c: number) => p[at + 8 * (a ? 3 - i : i) + 2 * (b ? 3 - j : j) + c];
    const inner = at + 8 * (a ? 2 : 1) + 2 * (b ? 2 : 1);
    for (let c = 0; c < 2; c++) {
      p[inner + c] = (-4 * q(0, 0, c) + 6 * (q(0, 1, c) + q(1, 0, c)) - 2 * (q(0, 3, c) + q(3, 0, c)) + 3 * (q(3, 1, c) + q(1, 3, c)) - q(3, 3, c)) / 9;
    }
  }
}

/**
 * Stops for a gradient over [t0, t1]: evenly spaced samples plus both sides of every stitching
 * bound (jumps become two stops at one offset), then only the stops that linear interpolation
 * between their neighbors wouldn't reproduce.
 */
function gradientStops(color: (t: number) => Rgb, t0: number, t1: number, bounds: number[]): GradientStop[] {
  const at: [number, number][] = [];
  for (let i = 0; i <= STOPS; i++) at.push([i / STOPS, i / STOPS]);
  for (const b of bounds.slice(0, MAX_BOUNDS)) {
    const off = lerp(b, t0, t1, 0, 1);
    if (off > 0 && off < 1) at.push([off, off - 1e-9], [off, off]);
  }
  at.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const pts = at.map(([offset, s]) => ({ offset, color: color(t0 + s * (t1 - t0)) }));
  const out = [pts[0]];
  for (let a = 0, j = 2; j <= pts.length; j++) {
    // Extend the segment from `a` to j while every point in between stays within tolerance.
    const e = pts[j];
    let fits = !!e;
    for (let k = a + 1; k < j && fits; k++) {
      const span = e.offset - pts[a].offset;
      const u = span ? (pts[k].offset - pts[a].offset) / span : 0;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(pts[a].color[c] + u * (e.color[c] - pts[a].color[c]) - pts[k].color[c]) > STOP_TOLERANCE) fits = false;
      }
    }
    if (!fits) out.push(pts[(a = j - 1)]);
  }
  return out;
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
