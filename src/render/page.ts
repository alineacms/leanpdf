/**
 * renderPage: draw a page onto a canvas with the browser's Canvas 2D API. Works on the main
 * thread and in Web Workers (OffscreenCanvas). Only the page's own objects are read, fonts and
 * decoded images are cached per document, and images are decoded at about the size they are drawn.
 */
import { pageContent } from '../core/content.ts';
import type { PdfDocument } from '../core/document.ts';
import { PdfEncryptedError } from '../core/errors.ts';
import { intOf, nameOf, numOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import { walkPages } from '../core/pages.ts';
import type { RenderFont } from './font.ts';
import { ImageCache } from './image.ts';
import { Interpreter, type RenderContext } from './interpret.ts';
import { asMatrix, mul, transformBox, type Matrix } from './util.ts';

export interface RenderOptions {
  /** Pixels per PDF point (1 = 72 dpi). Default 1. */
  scale?: number;
  /** Fit the page within this many pixels wide and/or high instead (keeps the aspect ratio). */
  width?: number;
  height?: number;
  /** CSS color painted first; null leaves the canvas transparent. Default white. */
  background?: string | null;
  /** Draw annotation appearances (form fields, stamps, highlights, ...). Default true. */
  annotations?: boolean;
  signal?: AbortSignal;
}

export interface RenderResult {
  /** Canvas size in pixels. */
  width: number;
  height: number;
  /** Pixels per point used. */
  scale: number;
  /** What couldn't be drawn (e.g. JPEG 2000 images), once per kind. */
  warnings: string[];
}

const MAX_CONTENT = 128 << 20;
/** Browsers cap canvas size; stay well within it. */
const MAX_SIDE = 16384;
const MAX_AREA = 1 << 27;

/** Fonts and decoded images per document, kept across renders. */
const caches = new WeakMap<PdfDocument, { fonts: Map<number, Promise<RenderFont>>; images: ImageCache }>();

const norm = (b: number[]): number[] => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];

/** Optional content: which groups the default configuration hides, and how to evaluate OCMDs. */
async function optionalContent(doc: PdfDocument): Promise<(oc: PdfObj | undefined) => Promise<boolean>> {
  const root = await doc.resolve(doc.trailer.get('Root'));
  const props = root instanceof PdfDict ? await doc.resolve(root.get('OCProperties')) : undefined;
  const d = props instanceof PdfDict ? await doc.resolve(props.get('D')) : undefined;
  if (!(d instanceof PdfDict)) return async () => true;
  const refs = async (o: PdfObj | undefined) => {
    const a = await doc.resolve(o);
    return new Set((Array.isArray(a) ? a : []).flatMap((x) => (x instanceof PdfRef ? [x.num] : [])));
  };
  const on = await refs(d.get('ON'));
  const off = await refs(d.get('OFF'));
  const baseOff = nameOf(await doc.resolve(d.get('BaseState'))) === 'OFF';
  const groupOn = (num: number) => (baseOff ? on.has(num) : !off.has(num));
  const visible = async (o: PdfObj | undefined, depth = 0): Promise<boolean> => {
    if (!(o instanceof PdfRef) && !(o instanceof PdfDict)) return true;
    const v = await doc.resolve(o);
    if (!(v instanceof PdfDict) || depth > 16) return true;
    if (nameOf(await doc.resolve(v.get('Type'))) !== 'OCMD') return o instanceof PdfRef ? groupOn(o.num) : true;
    const ve = await doc.resolve(v.get('VE'));
    if (Array.isArray(ve)) return expr(ve, depth);
    const ocgs = await doc.resolve(v.get('OCGs'));
    const list = (Array.isArray(ocgs) ? ocgs : [v.get('OCGs')]).filter((x): x is PdfRef => x instanceof PdfRef);
    if (!list.length) return true;
    const states = list.map((r) => groupOn(r.num));
    const p = nameOf(await doc.resolve(v.get('P'))) ?? 'AnyOn';
    return p === 'AllOn' ? states.every(Boolean) : p === 'AnyOff' ? states.some((x) => !x) : p === 'AllOff' ? states.every((x) => !x) : states.some(Boolean);
  };
  const expr = async (a: PdfObj[], depth: number): Promise<boolean> => {
    const op = nameOf((await doc.resolve(a[0])) as PdfObj);
    const args: boolean[] = [];
    for (const x of a.slice(1)) {
      const v = await doc.resolve(x);
      args.push(Array.isArray(v) && depth < 16 ? await expr(v, depth + 1) : x instanceof PdfRef ? groupOn(x.num) : true);
    }
    return op === 'Not' ? !args[0] : op === 'And' ? args.every(Boolean) : args.some(Boolean);
  };
  return (oc) => visible(oc);
}

/**
 * Render page `pageIndex` (0-based) onto `canvas`, which is resized to the page. Returns the size
 * used and anything that couldn't be drawn. Fonts that aren't embedded are drawn with similar
 * system fonts; JPEG 2000 and JBIG2 images are not drawn yet. Throws PdfEncryptedError for
 * encrypted documents (decrypt them first) and RangeError for a page that doesn't exist.
 */
export async function renderPage(doc: PdfDocument, pageIndex: number, canvas: HTMLCanvasElement | OffscreenCanvas, opts: RenderOptions = {}): Promise<RenderResult> {
  if (doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
  let page;
  for await (const p of walkPages(doc)) {
    if (p.index === pageIndex) {
      page = p;
      break;
    }
  }
  if (!page) throw new RangeError(`No page ${pageIndex}`);
  const media = norm(page.mediaBox);
  let [x0, y0, x1, y1] = norm(page.cropBox);
  [x0, y0, x1, y1] = [Math.max(x0, media[0]), Math.max(y0, media[1]), Math.min(x1, media[2]), Math.min(y1, media[3])];
  if (!(x1 > x0 && y1 > y0)) [x0, y0, x1, y1] = media;
  const turned = page.rotate === 90 || page.rotate === 270;
  const pw = turned ? y1 - y0 : x1 - x0;
  const ph = turned ? x1 - x0 : y1 - y0;
  const unit = numOf(await doc.resolve(page.dict.get('UserUnit'))) ?? 1;
  let s = (opts.scale ?? 1) * (unit > 0 ? unit : 1);
  if (opts.width || opts.height) s = Math.min(opts.width ? opts.width / pw : Infinity, opts.height ? opts.height / ph : Infinity);
  s = Math.min(s, MAX_SIDE / pw, MAX_SIDE / ph, Math.sqrt(MAX_AREA / (pw * ph)));
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('Invalid scale');
  const W = Math.max(1, Math.round(pw * s));
  const H = Math.max(1, Math.round(ph * s));
  const base: Matrix =
    page.rotate === 90 ? [0, s, s, 0, -y0 * s, -x0 * s] : page.rotate === 180 ? [-s, 0, 0, s, x1 * s, -y0 * s] : page.rotate === 270 ? [0, -s, -s, 0, y1 * s, x1 * s] : [s, 0, 0, -s, -x0 * s, y1 * s];

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('No 2D canvas context');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const background = opts.background === undefined ? '#fff' : opts.background;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
  }

  const warnings = new Set<string>();
  let cache = caches.get(doc);
  if (!cache) caches.set(doc, (cache = { fonts: new Map(), images: new ImageCache() }));
  const rc: RenderContext = { doc, signal: opts.signal, warn: (m) => warnings.add(m), visible: await optionalContent(doc), ...cache };
  const interp = new Interpreter(rc, { ctx, ox: 0, oy: 0, w: W, h: H }, base);
  const run = { res: page.resources, base, depth: 0 };
  ctx.save();
  await interp.run(await pageContent(doc, page.dict.get('Contents'), MAX_CONTENT), run);
  ctx.restore();

  if (opts.annotations !== false) {
    const annots = await doc.resolve(page.dict.get('Annots'));
    for (const a of Array.isArray(annots) ? annots : []) {
      opts.signal?.throwIfAborted();
      const d = await doc.resolve(a);
      if (!(d instanceof PdfDict)) continue;
      const flags = intOf(await doc.resolve(d.get('F'))) ?? 0;
      // Hidden (2) or NoView (32), and popups, which viewers show on demand.
      if (flags & 34 || nameOf(await doc.resolve(d.get('Subtype'))) === 'Popup') continue;
      if (d.get('OC') !== undefined && !(await rc.visible(d.get('OC')))) continue;
      const ap = await doc.resolve(d.get('AP'));
      let n = ap instanceof PdfDict ? ap.get('N') : undefined;
      const states = await doc.resolve(n);
      if (states instanceof PdfDict && !(n instanceof PdfRef && (await doc.header(n.num))?.stream)) {
        const as = nameOf(await doc.resolve(d.get('AS')));
        n = as ? states.get(as) : undefined;
      }
      if (!(n instanceof PdfRef)) continue;
      const hdr = await doc.header(n.num);
      const fd = hdr?.value;
      if (!hdr?.stream || !(fd instanceof PdfDict)) continue;
      const num = async (o: PdfObj | undefined) => {
        const v = await doc.resolve(o);
        return Array.isArray(v) ? Promise.all(v.map(async (x) => numOf(await doc.resolve(x)) ?? 0)) : undefined;
      };
      const rect = await num(d.get('Rect'));
      const bbox = await num(fd.get('BBox'));
      if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4) continue;
      // Map the appearance's (transformed) bounding box onto the annotation rectangle (PDF 12.5.5).
      const m = asMatrix(await num(fd.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
      const [bx0, by0, bx1, by1] = transformBox(bbox, m);
      const [rx0, ry0, rx1, ry1] = norm(rect);
      const sx = bx1 > bx0 ? (rx1 - rx0) / (bx1 - bx0) : 1;
      const sy = by1 > by0 ? (ry1 - ry0) / (by1 - by0) : 1;
      await interp.annotation(n, mul([sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy], base), run);
    }
  }
  return { width: W, height: H, scale: s, warnings: [...warnings] };
}
