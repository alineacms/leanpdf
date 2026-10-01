import { EMPTY } from './bytes.ts';
import { SourceReadError } from './errors.ts';
import type { RandomAccessSource } from './types.ts';

/** Cache block size. */
const BLOCK = 64 * 1024;
/** Blocks kept: 4 MB. */
const BLOCKS = 64;
/** raw() reads up to this size go through the cache; larger ones (big streams) read past it. */
const CACHED_RAW = 2 * BLOCK;

/**
 * Bounded read cache over a RandomAccessSource. Reads are served from 64 KB blocks, the least
 * recently used dropped past 4 MB; missing neighbouring blocks are fetched in one source read, and
 * a block being fetched is shared. Reading a document jumps between nearby places (an object's
 * header, its stream, the next object), and each source read can be costly: a Blob read is a round
 * trip to the browser. Large reads bypass the cache.
 */
export class SourceReader {
  readonly src: RandomAccessSource;
  readonly size: number;
  /** Block index to its bytes (shorter at the end of the source), most recently used last. */
  private readonly blocks = new Map<number, Promise<Uint8Array>>();

  constructor(src: RandomAccessSource) {
    this.src = src;
    this.size = src.size;
  }

  /**
   * Read up to `length` bytes at `offset`, clipped to the end of the source. The result may share
   * memory with the cache: don't modify it.
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0) offset = 0;
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return EMPTY;
    if (end - offset > CACHED_RAW) return this.fetch(offset, end - offset);
    return this.cached(offset, end, false);
  }

  /** Read up to `length` bytes at `offset` into an array of the caller's own. */
  async raw(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length);
    if (length > CACHED_RAW || offset < 0 || end <= offset) return this.fetch(offset, length);
    return this.cached(offset, end, true);
  }

  /** Whether a buffer read at `offset` reaches the end of the source. */
  isFinal(offset: number, buf: Uint8Array): boolean {
    return offset + buf.length >= this.size;
  }

  /** [offset, end) from cached blocks, fetching the missing ones; a copy when `copy`. */
  private async cached(offset: number, end: number, copy: boolean): Promise<Uint8Array> {
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    const one = first === last && this.blocks.get(first);
    if (one) {
      // The common case: within one cached block.
      this.blocks.delete(first);
      this.blocks.set(first, one);
      const v = (await one).subarray(offset - first * BLOCK, end - first * BLOCK);
      return copy ? v.slice() : v;
    }
    const wanted: Promise<Uint8Array>[] = [];
    for (let b = first; b <= last; ) {
      const hit = this.blocks.get(b);
      if (hit) {
        // Most recently used goes last.
        this.blocks.delete(b);
        this.blocks.set(b, hit);
        wanted.push(hit);
        b++;
        continue;
      }
      // One source read for this run of missing blocks.
      let e = b;
      while (e < last && !this.blocks.has(e + 1)) e++;
      const start = b * BLOCK;
      const run = this.fetch(start, Math.min(this.size, (e + 1) * BLOCK) - start);
      for (let k = b; k <= e; k++) {
        const at = (k - b) * BLOCK;
        const p = run.then((buf) => buf.subarray(at, at + BLOCK));
        this.blocks.set(k, p);
        // A failed read isn't kept; the caller gets the error.
        p.catch(() => this.blocks.get(k) === p && this.blocks.delete(k));
        wanted.push(p);
      }
      b = e + 1;
    }
    for (const k of this.blocks.keys()) {
      if (this.blocks.size <= BLOCKS) break;
      this.blocks.delete(k);
    }
    const parts = await Promise.all(wanted);
    const from = offset - first * BLOCK;
    if (parts.length === 1) {
      const v = parts[0].subarray(from, end - first * BLOCK);
      return copy ? v.slice() : v;
    }
    const out = new Uint8Array(end - offset);
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const stop = Math.min(BLOCK, end - (first + i) * BLOCK);
      out.set(parts[i].subarray(i ? 0 : from, stop), n);
      n += Math.max(0, Math.min(parts[i].length, stop) - (i ? 0 : from));
      // A short block (the source ended early): the result ends there.
      if (parts[i].length < stop) break;
    }
    return n < out.length ? out.subarray(0, n) : out;
  }

  /** Uncached read from the source. */
  private async fetch(offset: number, length: number): Promise<Uint8Array> {
    let buf: Uint8Array;
    try {
      buf = await this.src.read(offset, length);
    } catch (e) {
      throw new SourceReadError(e);
    }
    return buf.length > length ? buf.subarray(0, length) : buf;
  }
}
