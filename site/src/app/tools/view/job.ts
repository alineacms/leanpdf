/**
 * View job (worker): render one page to an ImageBitmap. The opened document is kept for the
 * next page of the same file, so its cross-reference index and fonts are read once.
 */
import { getPages, openPdf, renderPage, type PdfDocument } from '../../../../../src/index.ts';
import { defineJob } from '../../protocol.ts';

export interface ViewInput {
  file: File;
  /** 0-based. */
  page: number;
  /** Pixels per point; or fit within width/height pixels. */
  scale?: number;
  width?: number;
  height?: number;
}

export interface ViewOutput {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  pageCount: number;
  /** Page sizes in points, as shown (rotation applied). */
  sizes: [number, number][];
  warnings: string[];
  ms: number;
}

let open: { key: string; doc: Promise<{ doc: PdfDocument; sizes: [number, number][] }> } | undefined;

export const viewJob = defineJob(async (input: ViewInput, ctx): Promise<ViewOutput> => {
  const f = input.file;
  const key = `${f.name}\0${f.size}\0${f.lastModified}`;
  if (open?.key !== key) {
    const doc = (async () => {
      const doc = await openPdf(f, { signal: ctx.signal });
      const sizes = (await getPages(doc)).map((p): [number, number] => (p.rotate % 180 ? [p.height, p.width] : [p.width, p.height]));
      return { doc, sizes };
    })();
    open = { key, doc };
    doc.catch(() => {
      if (open?.doc === doc) open = undefined;
    });
  }
  const { doc, sizes } = await open.doc;
  const t0 = performance.now();
  const canvas = new OffscreenCanvas(1, 1);
  const r = await renderPage(doc, input.page, canvas, { scale: input.scale, width: input.width, height: input.height, signal: ctx.signal });
  return { bitmap: canvas.transferToImageBitmap(), width: r.width, height: r.height, pageCount: sizes.length, sizes, warnings: r.warnings, ms: performance.now() - t0 };
});
