/**
 * Browser side of the rendering benchmark (bench/features.ts): open a PDF from memory and render
 * every page to a canvas with leanpdf or PDF.js, timing each page until its pixels can be read.
 */
import { getPages, openPdf, renderPage } from '../src/index.ts';

interface Result {
  openMs: number;
  pageMs: number[];
  /** Luminance of the first `keep` pages, base64, for comparing with MuPDF. */
  gray: { width: number; height: number; data: string }[];
}

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Rec. 601 luminance over white, like MuPDF's DeviceGray. */
function luminance(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    const a = rgba[i + 3] / 255;
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    out[j] = Math.round(y * a + 255 * (1 - a));
  }
  return { width, height, data: toB64(out) };
}

type PdfJs = typeof import('pdfjs-dist');

async function leanpdf(bytes: Uint8Array, scale: number, keep: number): Promise<Result> {
  const canvas = document.createElement('canvas');
  const t0 = performance.now();
  const doc = await openPdf(bytes);
  const count = (await getPages(doc)).length;
  const openMs = performance.now() - t0;
  const pageMs: number[] = [];
  const gray: Result['gray'] = [];
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    const r = await renderPage(doc, i, canvas, { scale });
    const ctx = canvas.getContext('2d')!;
    // Reading a pixel waits for the drawing to be rasterized.
    ctx.getImageData(0, 0, 1, 1);
    pageMs.push(performance.now() - t);
    if (i < keep) gray.push(luminance(ctx, r.width, r.height));
  }
  return { openMs, pageMs, gray };
}

async function pdfjs(bytes: Uint8Array, scale: number, keep: number): Promise<Result> {
  const lib: PdfJs = await import(/* bundler: leave alone */ `${location.origin}/pdfjs/legacy/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = '/pdfjs/legacy/build/pdf.worker.min.mjs';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const t0 = performance.now();
  const loading = lib.getDocument({
    data: bytes,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    cMapUrl: '/pdfjs/cmaps/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
  });
  const doc = await loading.promise;
  const openMs = performance.now() - t0;
  const pageMs: number[] = [];
  const gray: Result['gray'] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const t = performance.now();
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    ctx.getImageData(0, 0, 1, 1);
    pageMs.push(performance.now() - t);
    if (i <= keep) gray.push(luminance(ctx, canvas.width, canvas.height));
    page.cleanup();
  }
  await loading.destroy();
  return { openMs, pageMs, gray };
}

(globalThis as unknown as { benchRender: unknown }).benchRender = async (tool: 'leanpdf' | 'pdfjs', url: string, scale: number, keep: number): Promise<Result> => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return tool === 'leanpdf' ? leanpdf(bytes, scale, keep) : pdfjs(bytes, scale, keep);
};
