/**
 * Worker-side job registry. Only the worker imports this module's values (and with them the
 * library); the page imports its types.
 *
 * To add a tool: write its job in tools/<id>/job.ts, add it here, and add its UI to ./tools.ts.
 */
import type { JobTypes } from './protocol.ts';
import { compressJob } from './tools/compress/job.ts';

export const JOBS = {
  compress: compressJob,
};

export type Jobs = { [K in keyof typeof JOBS]: JobTypes<(typeof JOBS)[K]> };
export type JobName = keyof Jobs;
