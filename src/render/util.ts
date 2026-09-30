/** Small helpers shared by the renderer's modules: matrices, device boxes, canvases, blend modes. */

/** A PDF matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the same numbers as Canvas setTransform). */
export type Matrix = number[];

/** Device-space box [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: the matrix of applying m first. */
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

export function invert(m: Matrix): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return undefined;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Six finite numbers, or undefined. */
export const asMatrix = (a: unknown): Matrix | undefined =>
  Array.isArray(a) && a.length === 6 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (a as Matrix) : undefined;

/** Bounding box of `box` (in the space `m` maps from) in device space. */
export function transformBox(box: number[], m: Matrix): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export const intersect = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** Whole pixels covering a box; null when empty. */
export function pixelBox(b: Box): Box | null {
  const r: Box = [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

export type Canvas = OffscreenCanvas;
export type Ctx = OffscreenCanvasRenderingContext2D;

/** A new offscreen canvas and its 2D context. */
export function canvas(w: number, h: number, readback = false): [Canvas, Ctx] {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('No 2D canvas');
  return [c, ctx];
}

/** PDF blend mode names to canvas composite operations (Normal and Compatible are source-over). */
const BLENDS = 'Multiply Screen Overlay Darken Lighten ColorDodge ColorBurn HardLight SoftLight Difference Exclusion Hue Saturation Color Luminosity';

export function blendMode(name: string | undefined): GlobalCompositeOperation | undefined {
  if (name === 'Normal' || name === 'Compatible') return 'source-over';
  if (!name || !BLENDS.split(' ').includes(name)) return undefined;
  return name.replace(/[a-z](?=[A-Z])/g, (c) => `${c}-`).toLowerCase() as GlobalCompositeOperation;
}

/** sRGB bytes as a CSS color. */
export const css = (c: ArrayLike<number>): string => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/** Device scale of a matrix: the geometric mean of its axis lengths. */
export const scaleOf = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
