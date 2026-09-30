/**
 * The app's Web Worker: runs the jobs registered in ./jobs.ts, one AbortController per run.
 * See ./protocol.ts for the messages.
 */
import { JOBS, type JobName } from './jobs.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

const PROGRESS_INTERVAL_MS = 80;

const post = (m: WorkerResponse): void => self.postMessage(m);
const runs = new Map<number, AbortController>();

function errorFields(err: unknown): { name: string; message: string } {
  if (err instanceof Error || err instanceof DOMException) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

async function run(id: number, name: string, input: unknown): Promise<void> {
  const job = Object.hasOwn(JOBS, name) ? JOBS[name as JobName] : undefined;
  if (!job) {
    post({ type: 'error', id, name: 'TypeError', message: `Unknown job "${name}"` });
    return;
  }
  const ctl = new AbortController();
  runs.set(id, ctl);
  // Coalesce progress: post the latest value at most every PROGRESS_INTERVAL_MS.
  let latest: unknown;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending) post({ type: 'progress', id, progress: latest });
    pending = false;
  };
  const progress = (p: unknown): void => {
    latest = p;
    pending = true;
    timer ??= setTimeout(flush, PROGRESS_INTERVAL_MS);
  };
  try {
    // Each job's input type is checked on the page side (WorkerClient.run); here it is opaque.
    const output = await (job.run as (i: unknown, c: { signal: AbortSignal; progress: (p: unknown) => void }) => Promise<unknown>)(input, {
      signal: ctl.signal,
      progress,
    });
    flush();
    post({ type: 'done', id, output });
  } catch (err) {
    flush();
    post({ type: 'error', id, ...errorFields(ctl.signal.aborted ? ctl.signal.reason ?? err : err) });
  } finally {
    runs.delete(id);
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') runs.get(msg.id)?.abort(new DOMException('Cancelled', 'AbortError'));
  else void run(msg.id, msg.job, msg.input);
};
