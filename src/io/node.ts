import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { compressPdf } from '../core/compress.ts';
import type { CompressOptions, CompressReport, OutputSink, RandomAccessSource } from '../core/types.ts';

const COPY_CHUNK = 1 << 20;

/** A file opened with `fs.promises.open` as a random-access source. */
export class NodeFileSource implements RandomAccessSource {
  readonly handle: FileHandle;
  readonly size: number;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  static async open(path: string): Promise<NodeFileSource> {
    const handle = await open(path, 'r');
    try {
      return new NodeFileSource(handle, (await handle.stat()).size);
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    length = Math.max(0, Math.min(length, this.size - offset));
    const buf = new Uint8Array(length);
    let n = 0;
    while (n < length) {
      const { bytesRead } = await this.handle.read(buf, n, length - n, offset + n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    return n === length ? buf : buf.subarray(0, n);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

/** Appends to a file through a FileHandle. Passthrough ranges are copied in 1 MB chunks. */
export class NodeFileSink implements OutputSink {
  readonly handle: FileHandle;
  private pos = 0;
  private copyBuf: Uint8Array | undefined;

  constructor(handle: FileHandle) {
    this.handle = handle;
  }

  static async create(path: string): Promise<NodeFileSink> {
    return new NodeFileSink(await open(path, 'w'));
  }

  async write(chunk: Uint8Array): Promise<void> {
    let n = 0;
    while (n < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, n, chunk.length - n, this.pos + n);
      n += bytesWritten;
    }
    this.pos += n;
  }

  async copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void> {
    // From a file, read into one reused buffer: allocating a chunk per read leaves garbage
    // proportional to the bytes copied, and peak memory then depends on when the GC runs.
    const buf = source instanceof NodeFileSource ? (this.copyBuf ??= new Uint8Array(COPY_CHUNK)) : undefined;
    for (let p = offset, end = offset + length; p < end; ) {
      const n = Math.min(COPY_CHUNK, end - p);
      const chunk = buf ? buf.subarray(0, (await (source as NodeFileSource).handle.read(buf, 0, n, p)).bytesRead) : await source.read(p, n);
      if (!chunk.length) throw new Error('Unexpected end of input');
      await this.write(chunk);
      p += chunk.length;
    }
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => {});
  }
}

/**
 * Compress `input` into `output`. Writes to a temporary file next to the output and renames it
 * into place, so the output path is only replaced by a complete file (and input may equal output).
 */
export async function compressPdfFile(input: string, output: string, opts: CompressOptions): Promise<CompressReport> {
  const source = await NodeFileSource.open(input);
  const tmp = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    const sink = await NodeFileSink.create(tmp);
    const report = await compressPdf(source, sink, opts);
    await rename(tmp, output);
    return report;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  } finally {
    await source.close();
  }
}
