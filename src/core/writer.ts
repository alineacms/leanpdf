import { ascii, latin1 } from './bytes.ts';
import { deflate } from './flate.ts';
import { PdfRef, PdfString, type PdfDict } from './objects.ts';
import type { OutputSink, RandomAccessSource } from './types.ts';

const BUF = 64 * 1024;

/**
 * Tracks the output position, batches small writes and merges adjacent passthrough copies so the
 * sink sees few, large operations.
 */
export class OutputWriter {
  pos = 0;
  private readonly sink: OutputSink;
  private readonly source: RandomAccessSource;
  private buf = new Uint8Array(BUF);
  private fill = 0;
  private copyOff = -1;
  private copyLen = 0;
  private copySrc: RandomAccessSource;

  constructor(sink: OutputSink, source: RandomAccessSource) {
    this.sink = sink;
    this.source = source;
    this.copySrc = source;
  }

  async write(b: Uint8Array | string): Promise<void> {
    if (typeof b === 'string') b = ascii(b);
    if (!b.length) return;
    await this.flushCopy();
    if (b.length >= BUF / 4) {
      await this.flushBuf();
      await this.sink.write(b);
    } else {
      if (this.fill + b.length > BUF) await this.flushBuf();
      this.buf.set(b, this.fill);
      this.fill += b.length;
    }
    this.pos += b.length;
  }

  /** Copy a range of `source` (default: the writer's source). Adjacent ranges of one source merge. */
  async copy(offset: number, length: number, source: RandomAccessSource = this.source): Promise<void> {
    if (length <= 0) return;
    if (this.copyOff >= 0 && this.copySrc === source && this.copyOff + this.copyLen === offset) {
      this.copyLen += length;
    } else {
      await this.flushCopy();
      await this.flushBuf();
      this.copyOff = offset;
      this.copyLen = length;
      this.copySrc = source;
    }
    this.pos += length;
  }

  private async flushBuf(): Promise<void> {
    if (!this.fill) return;
    const chunk = this.buf.slice(0, this.fill);
    this.fill = 0;
    await this.sink.write(chunk);
  }

  private async flushCopy(): Promise<void> {
    if (this.copyOff < 0) return;
    const off = this.copyOff;
    this.copyOff = -1;
    await this.sink.copyRange(this.copySrc, off, this.copyLen);
  }

  async flush(): Promise<void> {
    await this.flushCopy();
    await this.flushBuf();
  }
}

/** One output cross-reference entry: [type 0/1/2, field2, field3]. */
export type XrefEntryFn = (num: number) => [number, number, number];

const isHexString = (raw: Uint8Array): boolean => /^<[0-9A-Fa-f\s]*>$/.test(latin1(raw));

/**
 * The document-level trailer keys we carry over: /Root and /Info (indirect references) and /ID
 * (two strings). Anything else, or anything malformed, is dropped rather than copied into the
 * one part of the file every reader must be able to parse.
 */
export function trailerEntries(trailer: PdfDict): string {
  let s = '';
  for (const k of ['Root', 'Info']) {
    if (trailer.get(k) instanceof PdfRef) s += `/${k} ${latin1(trailer.raw.get(k)!)}\n`;
  }
  const id = trailer.get('ID');
  if (Array.isArray(id) && id.length === 2 && id.every((x) => x instanceof PdfString && (x.raw[0] !== 0x3c || isHexString(x.raw)))) {
    s += `/ID [${id.map((x) => latin1((x as PdfString).raw)).join(' ')}]\n`;
  }
  return s;
}

/**
 * Next-free links for the free list, computed lazily in one ascending pass: each free entry
 * points at the next free object number, and the last one back to 0.
 */
function freeLinker(size: number, entry: XrefEntryFn): (num: number) => number {
  let scan = 0;
  let found = 0;
  return (num) => {
    if (scan <= num) {
      scan = num + 1;
      found = 0;
      for (; scan < size; scan++) {
        if (entry(scan)[0] === 0) {
          found = scan;
          break;
        }
      }
    }
    return found;
  };
}

function putDigits(out: Uint8Array, at: number, v: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) {
    out[at + i] = 48 + (v % 10);
    v = Math.floor(v / 10);
  }
}

/** Classic `xref` table plus trailer. */
export async function writeXrefTable(w: OutputWriter, size: number, entry: XrefEntryFn, trailer: PdfDict): Promise<void> {
  const start = w.pos;
  await w.write(`xref\n0 ${size}\n`);
  const next = freeLinker(size, entry);
  const BATCH = 4096;
  for (let base = 0; base < size; base += BATCH) {
    const n = Math.min(BATCH, size - base);
    const out = new Uint8Array(n * 20);
    for (let i = 0; i < n; i++) {
      const num = base + i;
      const [t, a, b] = entry(num);
      const at = i * 20;
      const free = t !== 1;
      putDigits(out, at, free ? next(num) : a, 10);
      out[at + 10] = 32;
      putDigits(out, at + 11, num === 0 ? 65535 : Math.min(b, 65535), 5);
      out[at + 16] = 32;
      out[at + 17] = free ? 102 : 110; // f / n
      out[at + 18] = 13;
      out[at + 19] = 10;
    }
    await w.write(out);
  }
  await w.write(`trailer\n<< /Size ${size}\n${trailerEntries(trailer)}>>\nstartxref\n${start}\n%%EOF\n`);
}

const byteWidth = (v: number): number => {
  let n = 1;
  while (v >= 256 ** n) n++;
  return n;
};

/**
 * Cross-reference stream (PDF 1.5). Object `num` is the stream itself; the caller has made sure
 * it is unused. Rows are PNG-Up predicted and deflated.
 */
export async function writeXrefStream(
  w: OutputWriter,
  num: number,
  entry: XrefEntryFn,
  trailer: PdfDict,
): Promise<void> {
  const pos = w.pos;
  const size = num + 1;
  const get: XrefEntryFn = (n) => (n === num ? [1, pos, 0] : entry(n));
  const next = freeLinker(size, get);
  let maxA = pos;
  let maxB = 0;
  for (let n = 0; n < size; n++) {
    const [t, a, b] = get(n);
    if (t !== 0 && a > maxA) maxA = a;
    if (b > maxB) maxB = b;
  }
  if (size > maxA) maxA = size;
  const w2 = byteWidth(maxA);
  const w3 = byteWidth(maxB);
  const row = 1 + w2 + w3;
  function* rows(): Generator<Uint8Array> {
    const BATCH = 4096;
    const prev = new Uint8Array(row);
    const cur = new Uint8Array(row);
    for (let base = 0; base < size; base += BATCH) {
      const n = Math.min(BATCH, size - base);
      const out = new Uint8Array(n * (row + 1));
      for (let i = 0; i < n; i++) {
        const num = base + i;
        let [t, a, b] = get(num);
        if (t === 0) {
          a = next(num);
          if (num === 0) b = 65535;
        }
        cur[0] = t;
        for (let k = w2; k >= 1; k--, a = Math.floor(a / 256)) cur[k] = a % 256;
        for (let k = w2 + w3; k > w2; k--, b = Math.floor(b / 256)) cur[k] = b % 256;
        const at = i * (row + 1);
        out[at] = 2; // PNG Up
        for (let k = 0; k < row; k++) out[at + 1 + k] = cur[k] - prev[k];
        prev.set(cur);
      }
      yield out;
    }
  }
  const data = await deflate(rows());
  await w.write(
    `${num} 0 obj\n<< /Type /XRef /Size ${size} /Index [0 ${size}] /W [1 ${w2} ${w3}]\n` +
      `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${row} >> /Length ${data.length}\n` +
      `${trailerEntries(trailer)}>>\nstream\n`,
  );
  await w.write(data);
  await w.write(`\nendstream\nendobj\nstartxref\n${pos}\n%%EOF\n`);
}
