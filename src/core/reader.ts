import { EMPTY } from './bytes.ts';
import { SourceReadError } from './errors.ts';
import type { RandomAccessSource } from './types.ts';

const WINDOW = 64 * 1024;

/**
 * Bounded read cache over a RandomAccessSource. Small reads are served from one cached window,
 * which makes the mostly-forward header scans cheap. Large reads bypass the cache.
 */
export class SourceReader {
  readonly src: RandomAccessSource;
  readonly size: number;
  private wStart = 0;
  private wBuf: Uint8Array = EMPTY;

  constructor(src: RandomAccessSource) {
    this.src = src;
    this.size = src.size;
  }

  /** Read up to `length` bytes at `offset`, clipped to the end of the source. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0) offset = 0;
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return EMPTY;
    const w = this.wStart;
    if (offset >= w && end <= w + this.wBuf.length) return this.wBuf.subarray(offset - w, end - w);
    if (end - offset > WINDOW / 2) return this.raw(offset, end - offset);
    const buf = await this.raw(offset, Math.min(this.size, offset + WINDOW) - offset);
    this.wBuf = buf;
    this.wStart = offset;
    return buf.subarray(0, end - offset);
  }

  /** Uncached read. */
  async raw(offset: number, length: number): Promise<Uint8Array> {
    let buf: Uint8Array;
    try {
      buf = await this.src.read(offset, length);
    } catch (e) {
      throw new SourceReadError(e);
    }
    return buf.length > length ? buf.subarray(0, length) : buf;
  }

  /** Whether a buffer read at `offset` reaches the end of the source. */
  isFinal(offset: number, buf: Uint8Array): boolean {
    return offset + buf.length >= this.size;
  }
}
