/**
 * Canvas painting of shadings and soft-mask conversion. Axial and radial shadings use the
 * browser's own gradients; PDF's /Extend (canvas gradients always extend) becomes a clip.
 * Function-based and mesh shadings arrive rasterized from ./shading.ts.
 */
import type { ShadingPaint } from './shading.ts';
import { canvas, css, env, intersect, invert, mul, pixelBox, transformBox, type Box, type Ctx, type Matrix } from './util.ts';

const FAR = 1e5;
/** Largest rasterized shading, in pixels. */
const MAX_RASTER = 1 << 24;

type Ctx2D = Ctx | CanvasRenderingContext2D;

/** Set a transform on a target whose device origin is at (ox, oy). */
export const setT = (ctx: Ctx2D, m: Matrix, ox: number, oy: number): void => ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - ox, m[5] - oy);

/**
 * Paint a shading over `box` (device pixels, already clipped by the caller), `m` mapping shading
 * space to device space. `background` paints /Background first (shading patterns, not `sh`).
 */
export function paintShading(ctx: Ctx2D, sp: ShadingPaint, m: Matrix, box: Box, ox: number, oy: number, background: boolean): void {
  let area: Box = box;
  ctx.save();
  if (sp.bbox) {
    setT(ctx, m, ox, oy);
    ctx.beginPath();
    ctx.rect(sp.bbox[0], sp.bbox[1], sp.bbox[2] - sp.bbox[0], sp.bbox[3] - sp.bbox[1]);
    ctx.clip();
    area = intersect(box, transformBox(sp.bbox, m));
  }
  if (background && sp.background) {
    ctx.setTransform(1, 0, 0, 1, -ox, -oy);
    ctx.fillStyle = css(sp.background);
    ctx.fillRect(area[0], area[1], area[2] - area[0], area[3] - area[1]);
  }
  if (sp.kind === 'raster') {
    const pb = pixelBox(area);
    if (pb && (pb[2] - pb[0]) * (pb[3] - pb[1]) <= MAX_RASTER) {
      const w = pb[2] - pb[0];
      const h = pb[3] - pb[1];
      const data = sp.render(mul(m, [1, 0, 0, 1, -pb[0], -pb[1]]), w, h);
      const [c, cctx] = canvas(w, h);
      cctx.putImageData(new (env().ImageData)(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      ctx.setTransform(1, 0, 0, 1, -ox, -oy);
      ctx.drawImage(c, pb[0], pb[1]);
    }
    ctx.restore();
    return;
  }
  const inv = invert(m);
  if (!inv || !sp.stops.length) {
    ctx.restore();
    return;
  }
  let g: CanvasGradient;
  if (sp.kind === 'axial') {
    const [x0, y0, x1, y1] = sp.coords;
    if (x0 === x1 && y0 === y1) {
      ctx.restore();
      return;
    }
    if (!sp.extend[0] || !sp.extend[1]) {
      // Clip to the band between the perpendiculars at the ends that don't extend.
      setT(ctx, mul([x1 - x0, y1 - y0, y0 - y1, x1 - x0, x0, y0], m), ox, oy);
      ctx.beginPath();
      const s0 = sp.extend[0] ? -FAR : 0;
      ctx.rect(s0, -FAR, (sp.extend[1] ? FAR : 1) - s0, 2 * FAR);
      ctx.clip();
    }
    g = ctx.createLinearGradient(x0, y0, x1, y1);
  } else {
    const [x0, y0, r0, x1, y1, r1] = sp.coords;
    // For nested circles: the painted area ends at the larger circle, and starts outside the smaller.
    const grows = r1 >= r0;
    const [outer, inner] = grows ? [sp.extend[1], sp.extend[0]] : [sp.extend[0], sp.extend[1]];
    setT(ctx, m, ox, oy);
    if (!outer) {
      ctx.beginPath();
      ctx.arc(grows ? x1 : x0, grows ? y1 : y0, Math.max(r0, r1), 0, 2 * Math.PI);
      ctx.clip();
    }
    if (!inner && Math.min(r0, r1) > 0) {
      ctx.beginPath();
      ctx.rect(-FAR, -FAR, 2 * FAR, 2 * FAR);
      ctx.arc(grows ? x0 : x1, grows ? y0 : y1, Math.min(r0, r1), 0, 2 * Math.PI);
      ctx.clip('evenodd');
    }
    g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  }
  for (const s of sp.stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), css(s.color));
  // Fill the area, expressed in shading space.
  const sb = transformBox([area[0], area[1], area[2], area[3]], inv);
  setT(ctx, m, ox, oy);
  ctx.fillStyle = g;
  ctx.fillRect(sb[0], sb[1], sb[2] - sb[0], sb[3] - sb[1]);
  ctx.restore();
}

/**
 * Turn a rendered soft-mask group into alpha: luminosity masks use the brightness of each pixel,
 * alpha masks its alpha; `transfer` (256 entries) maps the result.
 */
export function maskToAlpha(ctx: Ctx, w: number, h: number, luminosity: boolean, transfer?: Uint8Array): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let a = luminosity ? (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8 : d[i + 3];
    if (transfer) a = transfer[a];
    d[i + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
}
