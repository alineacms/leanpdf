/** Merge job (worker): the inputs' pages, in order, in one new PDF. */
import { BlobSource, mergePdfs, type MergeProgress, type MergeReport } from '../../../../../src/index.ts';
import { writeOutput, type Written } from '../../output.ts';
import { defineJob, type JobContext } from '../../protocol.ts';

export interface MergeInput {
  inputs: { file: File; /** 0-based pages in output order; absent: all. */ pages?: number[] }[];
  handle?: FileSystemFileHandle;
}

export interface MergeOutput extends Written {
  report: MergeReport;
}

export const mergeJob = defineJob(async (input: MergeInput, ctx: JobContext<MergeProgress>): Promise<MergeOutput> => {
  const { result, ...written } = await writeOutput(input.handle, (sink) =>
    mergePdfs(
      input.inputs.map((i) => new BlobSource(i.file)),
      sink,
      { signal: ctx.signal, onProgress: (p) => ctx.progress(p), pages: input.inputs.map((i) => i.pages) },
    ),
  );
  return { report: result, ...written };
});
