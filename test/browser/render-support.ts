/**
 * Render tests: leanpdf's renderer runs in headless Chromium (or in this process with
 * @napi-rs/canvas), MuPDF renders the same page as the reference, and the two rasters are
 * compared. Set RENDER_DEBUG=<dir> to write both renders and their difference as PNGs.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import sharp from 'sharp';
import type { RenderOptions } from '../../src/render/page.ts';
import { renderPdf, type Raster } from '../support/render.ts';
import { bundle, HTML, JS, launchChromium, serveStatic, type StaticServer } from './harness.ts';

export interface Rendered extends Raster {
  warnings: string[];
  ms: number;
}

export interface Session {
  /** leanpdf's rendering, as RGB. */
  ours(pdf: Uint8Array, page?: number, opts?: RenderOptions): Promise<Rendered>;
  close(): Promise<void>;
}

/** Start Chromium with the renderer loaded; null (with the reason logged) when Chromium is unavailable. */
export async function startSession(): Promise<Session | { skip: string }> {
  const launch = await launchChromium('render tests');
  if (!launch.browser) return { skip: launch.skip };
  const js = await bundle(new URL('./render-entry.ts', import.meta.url).pathname);
  const server: StaticServer = serveStatic({ '/': HTML(), '/entry.js': JS(js) });
  const page: Page = await launch.browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.addScriptTag({ url: '/entry.js', type: 'module' });
  await page.waitForFunction(() => 'leanRender' in globalThis);
  return {
    async ours(pdf, index = 0, opts = {}) {
      const b64 = Buffer.from(pdf).toString('base64');
      const r = (await page.evaluate(
        ([d, i, o]) => (globalThis as unknown as { leanRender: (a: string, b: number, c: object) => Promise<unknown> }).leanRender(d, i, o),
        [b64, index, opts] as const,
      )) as { width: number; height: number; rgba: string; warnings: string[]; ms: number };
      if (errors.length) throw new Error(errors.join('\n'));
      const rgb = overWhite(Buffer.from(r.rgba, 'base64'), r.width, r.height);
      return { width: r.width, height: r.height, rgb, warnings: r.warnings, ms: r.ms };
    },
    async close() {
      await page.close();
      await server.close();
      await launch.close?.();
    },
  };
}

/** RGBA composited over white (the renderer paints a white background unless asked not to). */
function overWhite(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = rgba[i] * a + 255 * (1 - a);
    rgb[j + 1] = rgba[i + 1] * a + 255 * (1 - a);
    rgb[j + 2] = rgba[i + 2] * a + 255 * (1 - a);
  }
  return rgb;
}

/** The renderer in this process, with @napi-rs/canvas (leanpdf/canvas), as in Node and Bun. */
export async function startNodeSession(): Promise<Session | { skip: string }> {
  let canvas: typeof import('../../src/canvas.ts');
  try {
    canvas = await import('../../src/canvas.ts');
  } catch (e) {
    const skip = `render tests (@napi-rs/canvas): SKIPPED, ${e instanceof Error ? e.message.split('\n')[0] : e}`;
    console.warn(skip);
    return { skip };
  }
  const { openPdf } = await import('../../src/core/open.ts');
  return {
    async ours(pdf, index = 0, opts = {}) {
      const doc = await openPdf(pdf);
      const t0 = performance.now();
      const r = await canvas.renderPage(doc, index, undefined, opts);
      const ms = performance.now() - t0;
      const rgba = r.canvas.getContext('2d').getImageData(0, 0, r.width, r.height).data;
      return { width: r.width, height: r.height, rgb: overWhite(rgba, r.width, r.height), warnings: r.warnings, ms };
    },
    async close() {},
  };
}

/** MuPDF's rendering of a page at `scale` pixels per point. */
export function theirs(pdf: Uint8Array, page = 0, scale = 1): Raster {
  const r = renderPdf(pdf, page + 1, 72 * scale);
  const p = r.pages[page];
  if (!p) throw new Error(`MuPDF could not render page ${page}: ${r.messages.join('; ')}`);
  return p;
}

export interface Diff {
  /** Mean absolute difference over RGB samples (0-255) of the overlapping area. */
  mae: number;
  /** Fraction of pixels whose luminance differs by more than 64: structural differences. */
  bad: number;
}

export function compare(a: Raster, b: Raster): Diff {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let sum = 0;
  let bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 3;
      const j = (y * b.width + x) * 3;
      const d0 = Math.abs(a.rgb[i] - b.rgb[j]);
      const d1 = Math.abs(a.rgb[i + 1] - b.rgb[j + 1]);
      const d2 = Math.abs(a.rgb[i + 2] - b.rgb[j + 2]);
      sum += d0 + d1 + d2;
      if (0.299 * d0 + 0.587 * d1 + 0.114 * d2 > 64) bad++;
    }
  }
  return { mae: sum / (w * h * 3), bad: bad / (w * h) };
}

/** RGB at pixel (x, y). */
export const pixel = (r: Raster, x: number, y: number): number[] => {
  const i = (Math.round(y) * r.width + Math.round(x)) * 3;
  return [r.rgb[i], r.rgb[i + 1], r.rgb[i + 2]];
};

/** Write ours, theirs and their difference as PNGs when RENDER_DEBUG is set. */
export async function debugPng(name: string, ours: Raster, ref?: Raster): Promise<void> {
  const dir = process.env.RENDER_DEBUG;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const png = (r: Raster, file: string) => sharp(Buffer.from(r.rgb), { raw: { width: r.width, height: r.height, channels: 3 } }).png().toFile(join(dir, file));
  await png(ours, `${name}.ours.png`);
  if (!ref) return;
  await png(ref, `${name}.mupdf.png`);
  const w = Math.min(ours.width, ref.width);
  const h = Math.min(ours.height, ref.height);
  const d = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) d[(y * w + x) * 3 + c] = 255 - Math.abs(ours.rgb[(y * ours.width + x) * 3 + c] - ref.rgb[(y * ref.width + x) * 3 + c]);
  await png({ width: w, height: h, rgb: d }, `${name}.diff.png`);
}
