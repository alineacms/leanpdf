/** Page side of the worker protocol (./protocol.ts): start jobs, follow progress, cancel. */
import type { JobName, Jobs } from './jobs.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

/** URL of the worker bundle, injected by site/build.ts. */
declare const __WORKER_URL__: string;

interface Pending {
  resolve(output: unknown): void;
  reject(err: unknown): void;
  onProgress?: (p: unknown) => void;
}

export interface RunOptions<P> {
  signal?: AbortSignal;
  onProgress?: (p: P) => void;
}

/** An error from the worker, carrying the original error's name (e.g. "PdfEncryptedError"). */
export class JobError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** One lazily started worker shared by all tools. If it crashes, the next run starts a new one. */
export class WorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly url: string;

  constructor(url: string = __WORKER_URL__) {
    this.url = url;
  }

  run<K extends JobName>(job: K, input: Jobs[K]['input'], opts: RunOptions<Jobs[K]['progress']> = {}): Promise<Jobs[K]['output']> {
    const { signal, onProgress } = opts;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<Jobs[K]['output']>((resolve, reject) => {
      const onAbort = (): void => this.post({ type: 'cancel', id });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (o) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(o as Jobs[K]['output']);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
        onProgress: onProgress as ((p: unknown) => void) | undefined,
      });
      worker.postMessage({ type: 'run', id, job, input } satisfies WorkerRequest);
    });
  }

  private post(m: WorkerRequest): void {
    this.worker?.postMessage(m);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.url, { type: 'module', name: 'leanpdf' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      this.fail(new JobError('WorkerError', e.message || 'The worker stopped unexpectedly.'));
    };
    worker.onmessageerror = () => this.fail(new JobError('DataCloneError', 'A message from the worker could not be read.'));
    this.worker = worker;
    return worker;
  }

  private fail(err: Error): void {
    this.worker?.terminate();
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  private onMessage(m: WorkerResponse): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') {
      p.onProgress?.(m.progress);
      return;
    }
    this.pending.delete(m.id);
    if (m.type === 'done') p.resolve(m.output);
    else p.reject(m.name === 'AbortError' ? new DOMException(m.message, 'AbortError') : new JobError(m.name, m.message));
  }
}
