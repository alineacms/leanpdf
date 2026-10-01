/** Unlock job (worker): an unencrypted copy of an encrypted PDF. */
import { decryptPdf, type DecryptReport, type RewriteProgress, type RewriteReport } from '../../../../../src/index.ts';
import { writeOutput, type Written } from '../../output.ts';
import { defineJob, type JobContext } from '../../protocol.ts';

export interface UnlockOutput extends Written {
  report: DecryptReport & RewriteReport;
}

export const unlockJob = defineJob(
  async (input: { file: File; password: string; handle?: FileSystemFileHandle }, ctx: JobContext<RewriteProgress>): Promise<UnlockOutput> => {
    const { result, ...written } = await writeOutput(input.handle, (sink) =>
      decryptPdf(input.file, sink, { password: input.password, signal: ctx.signal, onProgress: (p) => ctx.progress(p) }),
    );
    return { report: result, ...written };
  },
);
