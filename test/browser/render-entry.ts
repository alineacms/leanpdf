/** Browser side of the render tests: render a page of a PDF (base64) and return its RGBA pixels (base64). */
import { openPdf } from '../../src/core/open.ts';
import { renderPage, type RenderOptions } from '../../src/render/page.ts';

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

(globalThis as unknown as { leanRender: unknown }).leanRender = async (pdf: string, pageIndex: number, opts: RenderOptions) => {
  const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
  const doc = await openPdf(new Blob([bytes]));
  const canvas = new OffscreenCanvas(1, 1);
  const t0 = performance.now();
  const r = await renderPage(doc, pageIndex, canvas, opts);
  const ms = performance.now() - t0;
  const data = canvas.getContext('2d')!.getImageData(0, 0, r.width, r.height).data;
  return { ...r, ms, rgba: toB64(new Uint8Array(data.buffer)) };
};
