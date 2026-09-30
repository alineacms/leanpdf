/** Rendering with mupdf (WASM) and image comparison metrics. */
import * as mupdf from 'mupdf';

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, no padding. */
  rgb: Uint8Array;
}

export interface RenderResult {
  pageCount: number;
  /** One entry per rendered page; null when mupdf failed on that page. */
  pages: (Raster | null)[];
  /** mupdf warnings and errors emitted while opening and rendering. */
  messages: string[];
}

/**
 * Render the first `maxPages` pages at `dpi`. mupdf's log output is captured instead of printed.
 * Throws if the document cannot be opened at all.
 */
export function renderPdf(data: Uint8Array, maxPages = 4, dpi = 72): RenderResult {
  const messages: string[] = [];
  mupdf.setLog({ error: (m) => messages.push(`error: ${m}`), warning: (m) => messages.push(`warning: ${m}`) });
  let doc: mupdf.Document | undefined;
  try {
    doc = mupdf.Document.openDocument(data, 'application/pdf');
    const pageCount = doc.countPages();
    const pages: (Raster | null)[] = [];
    const m = mupdf.Matrix.scale(dpi / 72, dpi / 72);
    for (let i = 0; i < Math.min(pageCount, maxPages); i++) {
      let page: mupdf.Page | undefined;
      let pix: mupdf.Pixmap | undefined;
      try {
        page = doc.loadPage(i);
        pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
        const width = pix.getWidth();
        const height = pix.getHeight();
        const stride = pix.getStride();
        const px = pix.getPixels();
        const rgb = new Uint8Array(width * height * 3);
        for (let y = 0; y < height; y++) rgb.set(px.subarray(y * stride, y * stride + width * 3), y * width * 3);
        pages.push({ width, height, rgb });
      } catch (e) {
        messages.push(`page ${i}: ${e instanceof Error ? e.message : String(e)}`);
        pages.push(null);
      } finally {
        pix?.destroy();
        page?.destroy();
      }
    }
    return { pageCount, pages, messages };
  } finally {
    doc?.destroy();
    mupdf.setLog(null);
  }
}

export function sameRaster(a: Raster, b: Raster): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.rgb;
  const y = b.rgb;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Mean absolute error over all RGB samples, 0..255. */
export function meanAbsError(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let s = 0;
  for (let i = 0; i < a.rgb.length; i++) s += Math.abs(a.rgb[i] - b.rgb[i]);
  return s / a.rgb.length;
}

function luma(r: Raster): Float64Array {
  const out = new Float64Array(r.width * r.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * r.rgb[3 * i] + 0.587 * r.rgb[3 * i + 1] + 0.114 * r.rgb[3 * i + 2];
  return out;
}

/**
 * Mean SSIM on luminance over `win` x `win` windows with stride `win / 2` (Wang et al. constants,
 * uniform window). 1 means identical.
 */
export function ssim(a: Raster, b: Raster, win = 8): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const x = luma(a);
  const y = luma(b);
  const w = a.width;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const step = Math.max(1, win >> 1);
  const n = win * win;
  let total = 0;
  let count = 0;
  for (let y0 = 0; y0 + win <= a.height; y0 += step) {
    for (let x0 = 0; x0 + win <= w; x0 += step) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let j = 0; j < win; j++) {
        let o = (y0 + j) * w + x0;
        for (let i = 0; i < win; i++, o++) {
          const p = x[o];
          const q = y[o];
          sx += p;
          sy += q;
          sxx += p * p;
          syy += q * q;
          sxy += p * q;
        }
      }
      const mx = sx / n;
      const my = sy / n;
      const vx = sxx / n - mx * mx;
      const vy = syy / n - my * my;
      const cov = sxy / n - mx * my;
      total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}
