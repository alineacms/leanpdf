import { describe, expect, test } from 'bun:test';
import { SourceReadError } from '../../src/core/errors.ts';
import { SourceReader } from '../../src/core/reader.ts';
import type { RandomAccessSource } from '../../src/core/types.ts';

const KB = 1024;

/** A source over `bytes` that counts reads; `fail` makes the next read throw. */
function source(bytes: Uint8Array, reported = bytes.length) {
  const s = {
    size: reported,
    reads: 0,
    fail: false,
    async read(offset: number, length: number) {
      s.reads++;
      await new Promise((r) => setTimeout(r, 1));
      if (s.fail) {
        s.fail = false;
        throw new Error('gone');
      }
      return bytes.slice(offset, offset + length);
    },
  };
  return s satisfies RandomAccessSource;
}

const data = Uint8Array.from({ length: 1000 * KB + 123 }, (_, i) => (i * 31 + (i >> 8)) & 255);
const same = (a: Uint8Array, at: number) => a.every((v, i) => v === data[at + i]);

describe('SourceReader', () => {
  test('returns the bytes asked for: within and across blocks, at and past the end', async () => {
    const r = new SourceReader(source(data));
    for (const [at, n] of [[0, 10], [65530, 20], [100, 130 * KB], [data.length - 5, 50], [data.length, 4], [3, 300 * KB]] as const) {
      for (const read of [r.read.bind(r), r.raw.bind(r)]) {
        const b = await read(at, n);
        expect(b.length).toBe(Math.max(0, Math.min(n, data.length - at)));
        expect(same(b, at)).toBe(true);
      }
    }
    expect((await r.read(-10, 4)).length).toBe(4);
  });

  test('nearby reads share blocks; missing neighbours come in one read; a block in flight is shared', async () => {
    const s = source(data);
    const r = new SourceReader(s);
    await r.read(1000, 100);
    await r.read(5000, 2000);
    await r.raw(40 * KB, 10 * KB);
    expect(s.reads).toBe(1);
    await r.read(60 * KB, 100 * KB); // blocks 0 (cached), 1 and 2 (one read)
    expect(s.reads).toBe(2);
    await Promise.all([r.read(200 * KB, 10), r.read(200 * KB + 50, 10), r.raw(200 * KB + 99, 10)]);
    expect(s.reads).toBe(3);
  });

  test('raw() results are the caller’s own; large reads bypass the cache', async () => {
    const s = source(data);
    const r = new SourceReader(s);
    const a = await r.raw(100, 50);
    a.fill(0);
    expect(same(await r.read(100, 50), 100)).toBe(true);
    const reads = s.reads;
    await r.raw(0, 500 * KB);
    await r.raw(0, 500 * KB);
    expect(s.reads).toBe(reads + 2);
  });

  test('holds at most 64 blocks, dropping the least recently used', async () => {
    const s = source(new Uint8Array(70 * 64 * KB));
    const r = new SourceReader(s);
    for (let b = 0; b < 70; b++) await r.read(b * 64 * KB, 1);
    expect(s.reads).toBe(70);
    const reads = s.reads;
    await r.read(69 * 64 * KB, 1);
    expect(s.reads).toBe(reads);
    await r.read(0, 1);
    expect(s.reads).toBe(reads + 1);
  });

  test('a failed read throws SourceReadError and is not kept', async () => {
    const s = source(data);
    const r = new SourceReader(s);
    s.fail = true;
    expect(r.read(10, 10)).rejects.toBeInstanceOf(SourceReadError);
    await new Promise((res) => setTimeout(res, 5));
    expect(same(await r.read(10, 10), 10)).toBe(true);
  });

  test('a source shorter than it says ends the result early', async () => {
    const r = new SourceReader(source(data.subarray(0, 100 * KB), 200 * KB));
    expect((await r.read(90 * KB, 20 * KB)).length).toBe(10 * KB);
    expect((await r.raw(60 * KB, 60 * KB)).length).toBe(40 * KB);
  });
});
