/**
 * Compress job (runs in the worker):
 *  - with a FileSystemFileHandle: compressPdf into the file's WritableStream, straight to disk
 *    (the browser writes to a temporary file and only replaces the target on close; an abort
 *    discards it);
 *  - otherwise compressPdfBlob, whose Blob holds slices of the input for unchanged bytes.
 */
import { BrowserImageCodec, compressPdf, compressPdfBlob, type CompressReport, type RewriteProgress } from '../../../../../src/index.ts';
import { defineJob, type JobContext } from '../../protocol.ts';

export interface CompressSettings {
  maxWidth: number;
  maxHeight: number;
  jpegQuality: number;
}

export interface CompressInput {
  file: File;
  settings: CompressSettings;
  /** Stream the output to this file instead of returning a Blob. */
  handle?: FileSystemFileHandle;
}

export interface CompressOutput {
  report: CompressReport;
  ms: number;
  blob?: Blob;
  savedTo?: string;
}

export const compressJob = defineJob(async (input: CompressInput, ctx: JobContext<RewriteProgress>): Promise<CompressOutput> => {
  const options = { ...input.settings, signal: ctx.signal, onProgress: (p: RewriteProgress) => ctx.progress(p) };
  const t0 = performance.now();
  if (input.handle) {
    const writable = await input.handle.createWritable();
    const report = await compressPdf(input.file, writable, { ...options, codec: new BrowserImageCodec() });
    return { report, ms: performance.now() - t0, savedTo: input.handle.name };
  }
  const { blob, report } = await compressPdfBlob(input.file, options);
  return { report, ms: performance.now() - t0, blob };
});
