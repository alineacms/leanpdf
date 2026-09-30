/**
 * The message protocol between the app page and its Web Worker.
 *
 * The worker runs *jobs*. A job is an async function from a structured-cloneable input to a
 * structured-cloneable output, with an AbortSignal and a progress callback. Jobs are registered
 * by name in ./jobs.ts; the page starts one with WorkerClient.run(name, input), which is typed
 * from that registry.
 *
 *   page -> worker   { type: 'run', id, job, input }      start job `job`; `id` names this run
 *                    { type: 'cancel', id }               abort run `id` (its signal fires)
 *   worker -> page   { type: 'progress', id, progress }   throttled to a few per second
 *                    { type: 'done', id, output }
 *                    { type: 'error', id, name, message } name 'AbortError' after a cancel
 */

export interface JobContext<P> {
  signal: AbortSignal;
  /** Report progress. Cheap to call often: the worker coalesces updates. */
  progress(p: P): void;
}

export interface Job<I, O, P> {
  run(input: I, ctx: JobContext<P>): Promise<O>;
}

export function defineJob<I, O, P = never>(run: (input: I, ctx: JobContext<P>) => Promise<O>): Job<I, O, P> {
  return { run };
}

/** Input, output and progress types of a job. */
export type JobTypes<J> = J extends Job<infer I, infer O, infer P> ? { input: I; output: O; progress: P } : never;

export type WorkerRequest = { type: 'run'; id: number; job: string; input: unknown } | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: unknown }
  | { type: 'done'; id: number; output: unknown }
  | { type: 'error'; id: number; name: string; message: string };
