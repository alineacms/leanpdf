/**
 * Viewer jobs (worker): the size of every page, and one page rendered to an ImageBitmap. The
 * opened document is kept for the next page of the same file, so its cross-reference index and
 * fonts are read once. Files that fit are read into memory first: a page takes dozens of small
 * reads, and each read from a File is a round trip to the browser, slow on phones above all.
 */
import { getPages, openPdf, renderPage, type PdfDocument } from '../../../../../src/index.ts';
import { defineJob } from '../../protocol.ts';

export interface LayoutOutput {
  /** Page sizes in points, as shown (rotation applied). */
  sizes: [number, number][];
  /** Time to read the file into memory (when it was) and to open it. */
  readMs?: number;
  openMs: number;
}

export interface ViewInput {
  file: File;
  /** 0-based. */
  page: number;
  /** Fit within this many pixels wide. */
  width: number;
}

export interface ViewOutput {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  warnings: string[];
  ms: number;
}

/** Largest file read into memory. */
const IN_MEMORY = 128 << 20;

let open: { key: string; doc: Promise<{ doc: PdfDocument } & LayoutOutput> } | undefined;

function opened(f: File, signal: AbortSignal): Promise<{ doc: PdfDocument } & LayoutOutput> {
  const key = `${f.name}\0${f.size}\0${f.lastModified}`;
  if (open?.key === key) return open.doc;
  const doc = (async () => {
    let t = performance.now();
    const bytes = f.size <= IN_MEMORY ? await f.arrayBuffer() : undefined;
    const readMs = bytes && performance.now() - t;
    t = performance.now();
    const doc = await openPdf(bytes ?? f, { signal });
    const sizes = (await getPages(doc)).map((p): [number, number] => (p.rotate % 180 ? [p.height, p.width] : [p.width, p.height]));
    return { doc, sizes, readMs, openMs: performance.now() - t };
  })();
  open = { key, doc };
  doc.catch(() => {
    if (open?.doc === doc) open = undefined;
  });
  return doc;
}

export const layoutJob = defineJob(async (input: { file: File }, ctx): Promise<LayoutOutput> => {
  const { sizes, readMs, openMs } = await opened(input.file, ctx.signal);
  return { sizes, readMs, openMs };
});

export const viewJob = defineJob(async (input: ViewInput, ctx): Promise<ViewOutput> => {
  const { doc } = await opened(input.file, ctx.signal);
  const t0 = performance.now();
  const canvas = new OffscreenCanvas(1, 1);
  const r = await renderPage(doc, input.page, canvas, { width: input.width, signal: ctx.signal });
  return { bitmap: canvas.transferToImageBitmap(), width: r.width, height: r.height, warnings: r.warnings, ms: performance.now() - t0 };
});
