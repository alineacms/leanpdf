/** Text job (worker): the text of every page, or of the pages asked for, in reading order. */
import { extractText, getPages, openPdf, type PageText } from '../../../../../src/index.ts';
import { defineJob, type JobContext } from '../../protocol.ts';

export interface TextProgress {
  done: number;
  total: number;
}

export interface TextOutput {
  pages: PageText[];
  pageCount: number;
  ms: number;
}

export const textJob = defineJob(async (input: { file: File; pages?: number[] }, ctx: JobContext<TextProgress>): Promise<TextOutput> => {
  const t0 = performance.now();
  const doc = await openPdf(input.file, { signal: ctx.signal });
  const pageCount = (await getPages(doc)).length;
  const total = input.pages?.length ?? pageCount;
  const pages: PageText[] = [];
  ctx.progress({ done: 0, total });
  for await (const p of extractText(doc, { signal: ctx.signal, ...(input.pages ? { pages: input.pages } : {}) })) {
    pages.push(p);
    ctx.progress({ done: pages.length, total });
  }
  return { pages, pageCount, ms: performance.now() - t0 };
});
