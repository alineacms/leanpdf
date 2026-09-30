/** Worker for the corpus runner: MuPDF renders, so a file that hangs it can be abandoned. */
import { renderPdf } from '../support/render.ts';

declare const self: Worker;
self.onmessage = (e: MessageEvent<{ id: number; pdf: Uint8Array; pages: number; dpi: number }>) => {
  const { id, pdf, pages, dpi } = e.data;
  try {
    const r = renderPdf(pdf, pages, dpi);
    self.postMessage({ id, pageCount: r.pageCount, pages: r.pages, messages: r.messages.slice(0, 5) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
