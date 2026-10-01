/**
 * Rendering in Node and Bun with @napi-rs/canvas (Skia), the only module that imports it. Pages
 * render exactly as in the browser, with the library's canvases, paths and fonts.
 */
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas } from '@napi-rs/canvas';
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
