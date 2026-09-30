/**
 * Demo worker. Compresses the posted File off the main thread:
 *  - with a FileSystemFileHandle: compressPdf + WritableStreamSink, streaming straight to disk;
 *  - otherwise: compressPdfBlob, and the resulting Blob is posted back.
 */
import {
  BlobSource,
  BrowserImageCodec,
  compressPdf,
  compressPdfBlob,
  WritableStreamSink,
  type CompressReport,
  type ProgressEvent,
  type RecompressOptions,
} from '../src/index.ts';

export type WorkerRequest =
  | { type: 'start'; file: File; handle?: FileSystemFileHandle; options: RecompressOptions }
  | { type: 'cancel' };

export type WorkerResponse =
  | ({ type: 'progress' } & ProgressEvent)
  | { type: 'done'; report: CompressReport; ms: number; blob?: Blob; savedTo?: string }
  | { type: 'error'; name: string; message: string };

const post = (m: WorkerResponse): void => self.postMessage(m);
let controller: AbortController | null = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    controller?.abort(new DOMException('Cancelled', 'AbortError'));
    return;
  }
  controller?.abort();
  const ctl = new AbortController();
  controller = ctl;
  const common = {
    ...msg.options,
    signal: ctl.signal,
    onProgress: (p: ProgressEvent) => post({ type: 'progress', ...p }),
  };
  const t0 = performance.now();
  try {
    if (msg.handle) {
      // Chromium writes to a swap file and only replaces the target on close(); abort() discards it.
      const writable = await msg.handle.createWritable();
      const report = await compressPdf(new BlobSource(msg.file), new WritableStreamSink(writable), { ...common, codec: new BrowserImageCodec() });
      post({ type: 'done', report, ms: performance.now() - t0, savedTo: msg.handle.name });
    } else {
      const { blob, report } = await compressPdfBlob(msg.file, common);
      post({ type: 'done', report, ms: performance.now() - t0, blob });
    }
  } catch (err) {
    const name = err instanceof Error || err instanceof DOMException ? err.name : 'Error';
    post({ type: 'error', name, message: err instanceof Error || err instanceof DOMException ? err.message : String(err) });
  } finally {
    if (controller === ctl) controller = null;
  }
};
