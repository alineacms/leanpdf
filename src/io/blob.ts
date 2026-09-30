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
 * Collects output as Blob parts. Passthrough ranges from a BlobSource are kept as blob slices,
 * so unchanged bytes are never copied into JS memory.
 */
export class BlobPartsSink implements OutputSink {
  private parts: BlobPart[] = [];
  private result: Blob | null = null;
  readonly type: string;

  constructor(type = 'application/pdf') {
    this.type = type;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
  }

  async copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void> {
    if (source instanceof BlobSource) this.parts.push(source.blob.slice(offset, offset + length));
    else await copyInChunks(source, offset, length, (c) => this.write(c));
  }

  async close(): Promise<void> {
    this.result = new Blob(this.parts, { type: this.type });
    this.parts = [];
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
