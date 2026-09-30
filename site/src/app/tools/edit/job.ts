/**
 * Edit job (worker): one rewritePdf pass with the plugins the form asked for: select and reorder
 * pages, rotate, and clean up.
 */
import {
  BlobSource, recompressStreams, removeAttachments, removeJavaScript, removeUnused, repairStreams, rewritePdf, rotatePages, selectPages, stripMetadata,
  type Plugin, type ProgressEvent, type RewriteReport,
} from '../../../../../src/index.ts';
import { writeOutput, type Written } from '../../output.ts';
import { defineJob, type JobContext } from '../../protocol.ts';

export interface EditInput {
  file: File;
  /** 0-based pages to keep, in output order. Absent: all, as they are. */
  keep?: number[];
  /** Degrees clockwise (90, 180, 270) and the 0-based input pages to turn (absent: all). */
  rotate?: { by: number; pages?: number[] };
  stripMetadata?: boolean;
  removeJavaScript?: boolean;
  removeAttachments?: boolean;
  removeUnused?: boolean;
  recompressStreams?: boolean;
  repairStreams?: boolean;
  handle?: FileSystemFileHandle;
}

export interface EditOutput extends Written {
  report: RewriteReport;
}

export const editJob = defineJob(async (input: EditInput, ctx: JobContext<ProgressEvent>): Promise<EditOutput> => {
  const plugins: Plugin[] = [];
  if (input.repairStreams) plugins.push(repairStreams());
  if (input.keep) plugins.push(selectPages(input.keep));
  if (input.rotate) {
    const { by, pages } = input.rotate;
    const turn = pages && new Set(pages);
    plugins.push(rotatePages(turn ? (i, cur) => (turn.has(i) ? cur + by : cur) : by));
  }
  if (input.stripMetadata) plugins.push(stripMetadata());
  if (input.removeJavaScript) plugins.push(removeJavaScript());
  if (input.removeAttachments) plugins.push(removeAttachments());
  if (input.removeUnused) plugins.push(removeUnused());
  if (input.recompressStreams) plugins.push(recompressStreams());
  const out = await writeOutput(input.handle, (sink) =>
    rewritePdf(new BlobSource(input.file), sink, plugins, { signal: ctx.signal, onProgress: (p) => ctx.progress(p) }),
  );
  const { result, ...written } = out;
  return { report: result, ...written };
});
