/**
 * Worker-side job registry. Only the worker imports this module's values (and with them the
 * library); the page imports its types.
 *
 * A tool's job lives in tools/<id>/job.ts and is added here; its UI goes in ./tools.ts.
 */
import { probeJob } from './probe.ts';
import type { JobTypes } from './protocol.ts';
import { compressJob } from './tools/compress/job.ts';
import { editJob } from './tools/edit/job.ts';
import { attachmentJob, imageJob, inspectJob } from './tools/inspect/job.ts';
import { mergeJob } from './tools/merge/job.ts';
import { textJob } from './tools/text/job.ts';
import { unlockJob } from './tools/unlock/job.ts';
import { layoutJob, viewJob } from './tools/view/job.ts';

export const JOBS = {
  probe: probeJob,
  compress: compressJob,
  inspect: inspectJob,
  image: imageJob,
  attachment: attachmentJob,
  text: textJob,
  edit: editJob,
  merge: mergeJob,
  unlock: unlockJob,
  layout: layoutJob,
  view: viewJob,
};

export type Jobs = { [K in keyof typeof JOBS]: JobTypes<(typeof JOBS)[K]> };
export type JobName = keyof Jobs;
