import type { OutputSink, RandomAccessSource } from '../core/types.ts';

const COPY_CHUNK = 1 << 20;

/** Copy a source range through a writer in bounded chunks. */
export async function copyInChunks(
  source: RandomAccessSource,
  offset: number,
  length: number,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  for (let pos = offset, end = offset + length; pos < end; ) {
    const chunk = await source.read(pos, Math.min(COPY_CHUNK, end - pos));
    if (!chunk.length) throw new Error('Unexpected end of input');
    await write(chunk);
    pos += chunk.length;
  }
}

/** A Blob or File as a random-access source. Reads use `blob.slice().arrayBuffer()`. */
export class BlobSource implements RandomAccessSource {
  readonly blob: Blob;
  readonly size: number;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

/**
 * Can this runtime build a Blob from slices of `blob` mixed with other parts? Browsers and Node
 * can; Bun (1.3) silently drops file-backed slices (e.g. from Bun.file or fs.openAsBlob).
 */
async function slicesCompose(blob: Blob): Promise<boolean> {
  if (blob.size < 2) return true;
  const probe = new Blob([blob.slice(0, 1), new Uint8Array(1), blob.slice(1, 2)]);
  if (probe.size !== 3) return false;
  const b = new Uint8Array(await probe.arrayBuffer());
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return b[0] === head[0] && b[2] === head[1];
}

/**
 * Collects output as Blob parts. Passthrough ranges from a BlobSource are kept as blob slices,
 * so unchanged bytes are never copied into JS memory (where the runtime supports composing them).
 */
export class BlobPartsSink implements OutputSink {
  private parts: BlobPart[] = [];
  private size = 0;
  private result: Blob | null = null;
  private zeroCopy = new WeakMap<Blob, Promise<boolean>>();
  readonly type: string;

  constructor(type = 'application/pdf') {
    this.type = type;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
    this.size += chunk.length;
  }

  async copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void> {
    if (source instanceof BlobSource) {
      let ok = this.zeroCopy.get(source.blob);
      if (!ok) this.zeroCopy.set(source.blob, (ok = slicesCompose(source.blob)));
      if (await ok) {
        this.parts.push(source.blob.slice(offset, offset + length));
        this.size += length;
        return;
      }
    }
    await copyInChunks(source, offset, length, (c) => this.write(c));
  }

  async close(): Promise<void> {
    const result = new Blob(this.parts, { type: this.type });
    this.parts = [];
    // Never hand out a silently truncated file.
    if (result.size !== this.size) throw new Error(`BlobPartsSink: assembled ${result.size} bytes, expected ${this.size}`);
    this.result = result;
  }

  async abort(): Promise<void> {
    this.parts = [];
  }

  /** The finished output. Available after `close()`. */
  get blob(): Blob {
    if (!this.result) throw new Error('BlobPartsSink is not closed yet');
    return this.result;
  }
}

/**
 * Streams output into a WritableStream, e.g. from `FileSystemFileHandle.createWritable()` or
 * `Writable.toWeb(fs.createWriteStream(path))`. Honors backpressure.
 */
export class WritableStreamSink implements OutputSink {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(stream: WritableStream<Uint8Array>) {
    this.writer = stream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writer.ready;
    await this.writer.write(chunk);
  }

  copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void> {
    return copyInChunks(source, offset, length, (c) => this.write(c));
  }

  async close(): Promise<void> {
    await this.writer.close();
  }

  async abort(reason?: unknown): Promise<void> {
    await this.writer.abort(reason);
  }
}
