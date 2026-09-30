/**
 * Worker side: where a job that writes a PDF puts it. With a FileSystemFileHandle the output is
 * streamed to that file (the browser writes a temporary file and only replaces the target on
 * close; an abort discards it); otherwise it becomes a Blob whose unchanged bytes are slices of
 * the input.
 */
import { BlobPartsSink, WritableStreamSink, type OutputSink } from '../../../src/index.ts';

export interface Written {
  /** The result, when it was kept in memory. */
  blob?: Blob;
  /** Name of the file it was streamed to. */
  savedTo?: string;
  ms: number;
}

/** Run `write` (which must close or abort the sink, as the library's functions do) to `handle` or to a Blob. */
export async function writeOutput<R>(handle: FileSystemFileHandle | undefined, write: (sink: OutputSink) => Promise<R>): Promise<Written & { result: R }> {
  const t0 = performance.now();
  if (handle) {
    const result = await write(new WritableStreamSink(await handle.createWritable()));
    return { result, savedTo: handle.name, ms: performance.now() - t0 };
  }
  const sink = new BlobPartsSink();
  const result = await write(sink);
  return { result, blob: sink.blob, ms: performance.now() - t0 };
}
