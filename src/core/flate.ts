import { concat } from './bytes.ts';
import type { SourceReader } from './reader.ts';

const CHUNK = 256 * 1024;

/** A pull-based stream of source bytes [offset, offset+length), read in bounded chunks. */
function rangeStream(
  reader: SourceReader,
  offset: number,
  length: number,
  onError: (e: unknown) => void,
): ReadableStream<Uint8Array> {
  let pos = offset;
  const end = offset + length;
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        if (pos >= end) return ctrl.close();
        try {
          const b = await reader.raw(pos, Math.min(CHUNK, end - pos));
          if (!b.length) return ctrl.close();
          pos += b.length;
          ctrl.enqueue(b);
        } catch (e) {
          onError(e);
          ctrl.error(e);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/** Does the data start with a valid zlib header? Otherwise we try raw deflate. */
const isZlib = (h: Uint8Array): boolean => h.length >= 2 && (h[0] & 0x0f) === 8 && ((h[0] << 8) | h[1]) % 31 === 0;

/**
 * Stream-inflate a FlateDecode range, handing each decompressed chunk to `onChunk` (return true to
 * stop early). Returns false if the data was corrupt or truncated; whatever decoded before the
 * error has already been delivered. Source read errors are rethrown.
 */
export async function inflateRange(
  reader: SourceReader,
  offset: number,
  length: number,
  onChunk: (chunk: Uint8Array) => boolean | void,
): Promise<boolean> {
  const head = await reader.read(offset, 2);
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream(isZlib(head) ? 'deflate' : ('deflate-raw' as CompressionFormat));
  } catch {
    return false;
  }
  let ioError: unknown;
  const r = rangeStream(reader, offset, length, (e) => (ioError = e))
    .pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();
  for (;;) {
    let res: Awaited<ReturnType<typeof r.read>>;
    try {
      res = await r.read();
    } catch {
      if (ioError) throw ioError;
      return false;
    }
    if (res.done) return true;
    let stop: boolean | void;
    try {
      stop = onChunk(res.value);
    } catch (e) {
      r.cancel().catch(() => {});
      throw e;
    }
    if (stop === true) {
      r.cancel().catch(() => {});
      return true;
    }
  }
}

/** Inflate a whole range into memory, up to `max` bytes. */
export async function inflateAll(
  reader: SourceReader,
  offset: number,
  length: number,
  max: number,
): Promise<{ data: Uint8Array; complete: boolean }> {
  const parts: Uint8Array[] = [];
  let n = 0;
  let over = false;
  const ok = await inflateRange(reader, offset, length, (c) => {
    parts.push(c);
    n += c.length;
    if (n > max) return (over = true);
  });
  return { data: concat(parts), complete: ok && !over };
}

/**
 * Incremental zlib-format compressor over CompressionStream. Chunks must not be modified after
 * `write`. Awaiting `write` applies backpressure; callers that can't wait may ignore it.
 */
export class Deflater {
  private readonly w: WritableStreamDefaultWriter<Uint8Array>;
  private readonly out: Uint8Array[] = [];
  private readonly pump: Promise<void>;

  constructor() {
    const cs = new CompressionStream('deflate');
    this.w = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    const r = cs.readable.getReader();
    this.pump = (async () => {
      for (;;) {
        const { done, value } = await r.read();
        if (done) return;
        this.out.push(value);
      }
    })();
    this.pump.catch(() => {});
  }

  write(chunk: Uint8Array): Promise<void> {
    const p = this.w.write(chunk);
    p.catch(() => {});
    return p;
  }

  async finish(): Promise<Uint8Array> {
    await this.w.close();
    await this.pump;
    return concat(this.out);
  }
}

/** Deflate (zlib format) a sequence of chunks produced on demand, with backpressure. */
export async function deflate(chunks: Iterable<Uint8Array>): Promise<Uint8Array> {
  const d = new Deflater();
  for (const c of chunks) await d.write(c);
  return d.finish();
}
