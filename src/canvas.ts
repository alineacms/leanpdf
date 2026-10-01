/**
 * Rendering in Node and Bun with @napi-rs/canvas (Skia), the only module that imports it. Pages
 * render exactly as in the browser, with the library's canvases, paths and fonts.
 */
import { createCanvas, DOMMatrix, GlobalFonts, ImageData, Path2D, type Canvas } from '@napi-rs/canvas';
import type { PdfDocument } from './core/document.ts';
import { renderPage as renderToCanvas, type RenderOptions, type RenderResult } from './render/page.ts';
import { setCanvasBackend } from './render/util.ts';

export type { RenderOptions, RenderResult } from './render/page.ts';

/**
 * @napi-rs/canvas's Path2D.addPath continues the last contour into the added path, drawing a line
 * from where one glyph ends to where the next starts. Starting a contour at the added path's first
 * point first avoids that, so these paths remember where they start.
 */
class Path extends Path2D {
  start?: [number, number];

  override moveTo(x: number, y: number): void {
    this.start ??= [x, y];
    super.moveTo(x, y);
  }

  override rect(x: number, y: number, w: number, h: number): void {
    this.start ??= [x, y];
    super.rect(x, y, w, h);
  }

  override addPath(path: Path2D, m?: DOMMatrix): void {
    const s = (path as Path).start;
    if (s) this.moveTo(m ? m.a * s[0] + m.c * s[1] + m.e : s[0], m ? m.b * s[0] + m.d * s[1] + m.f : s[1]);
    super.addPath(path, m);
  }
}

/**
 * Unlike browsers, Skia here doesn't fall back to another font for a glyph the chosen one lacks,
 * so a missing Zapf Dingbats or Symbol could draw nothing. Those names are pointed at the first
 * installed font that draws their glyphs (tried by drawing them), preferring the usual stand-ins.
 */
const STAND_INS: [name: string, probe: string, prefer: string[]][] = [
  ['Zapf Dingbats', '\u2714\u2665\u275e', ['D050000L', 'Noto Sans Symbols 2', 'DejaVu Sans', 'FreeSerif', 'FreeSans', 'Segoe UI Symbol', 'Apple Symbols']],
  ['Symbol', '\u2211\u03b1\u221e', ['Standard Symbols PS', 'Noto Sans Symbols', 'DejaVu Sans', 'FreeSerif', 'Segoe UI Symbol', 'Apple Symbols', 'Liberation Serif']],
];

/** Whether `family` draws every character of `probe` (each leaves some ink). */
function draws(family: string, probe: string): boolean {
  const c = createCanvas(40, 40);
  const ctx = c.getContext('2d');
  ctx.font = `32px "${family}"`;
  for (const ch of probe) {
    ctx.clearRect(0, 0, 40, 40);
    ctx.fillText(ch, 4, 32);
    const d = ctx.getImageData(0, 0, 40, 40).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) ink += d[i];
    if (!ink) return false;
  }
  return true;
}

function aliasStandIns(): void {
  const installed = [...new Set(GlobalFonts.families.map((f) => f.family))];
  for (const [name, probe, prefer] of STAND_INS) {
    if (GlobalFonts.has(name)) continue;
    const order = [...prefer.filter((f) => installed.includes(f)), ...installed.filter((f) => !prefer.includes(f))];
    const found = order.find((f) => draws(f, probe));
    if (found) GlobalFonts.setAlias(found, name);
  }
}

let ready = false;

/** Make renderPage draw with @napi-rs/canvas. Done for you by the functions below. */
export function useNapiCanvas(): void {
  if (ready) return;
  setCanvasBackend({
    createCanvas: (w, h) => createCanvas(w, h) as unknown as OffscreenCanvas,
    Path2D: Path as unknown as typeof globalThis.Path2D,
    DOMMatrix: DOMMatrix as unknown as typeof globalThis.DOMMatrix,
    ImageData: ImageData as unknown as typeof globalThis.ImageData,
  });
  aliasStandIns();
  ready = true;
}

/**
 * Render page `pageIndex` (0-based) onto a @napi-rs/canvas Canvas, which is resized to the page;
 * see renderPage in the main module. Without a canvas, a new one is made: it's on the result.
 */
export async function renderPage(doc: PdfDocument, pageIndex: number, canvas: Canvas = createCanvas(1, 1), opts: RenderOptions = {}): Promise<RenderResult & { canvas: Canvas }> {
  useNapiCanvas();
  const r = await renderToCanvas(doc, pageIndex, canvas as unknown as OffscreenCanvas, opts);
  return { ...r, canvas };
}

export interface RenderImageOptions extends RenderOptions {
  /** Image format. Default 'png'. */
  format?: 'png' | 'jpeg' | 'webp';
  /** JPEG or WebP quality, 0 to 1. Default 0.9. */
  quality?: number;
}

/** Render a page and encode it: the image file's bytes, with the size and warnings of renderPage. */
export async function renderPageImage(doc: PdfDocument, pageIndex: number, opts: RenderImageOptions = {}): Promise<RenderResult & { data: Uint8Array }> {
  const { canvas, ...r } = await renderPage(doc, pageIndex, undefined, opts);
  const format = opts.format ?? 'png';
  const quality = Math.round(100 * Math.min(1, Math.max(0, opts.quality ?? 0.9)));
  const data = format === 'png' ? await canvas.encode('png') : await canvas.encode(format, quality);
  return { ...r, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
