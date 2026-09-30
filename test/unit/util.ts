import type { OutputSink, RandomAccessSource } from '../../src/core/types.ts';

/** In-memory source that also counts reads, to check bounded access patterns. */
export class BytesSource implements RandomAccessSource {
  readonly bytes: Uint8Array;
  readonly size: number;
  reads = 0;
  bytesRead = 0;
  constructor(bytes: Uint8Array | string) {
    this.bytes = typeof bytes === 'string' ? latin1Bytes(bytes) : bytes;
    this.size = this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads++;
    const out = this.bytes.slice(offset, Math.min(this.size, offset + length));
    this.bytesRead += out.length;
    return out;
  }
}

export class BytesSink implements OutputSink {
  chunks: Uint8Array[] = [];
  closed = false;
  copies = 0;
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
  }
  async copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void> {
    this.copies++;
    this.chunks.push(await source.read(offset, length));
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.chunks));
  }
  text(): string {
    return Buffer.from(this.bytes()).toString('latin1');
  }
}

export function latin1Bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

export interface MiniObject {
  num: number;
  gen?: number;
  body: string;
}

/**
 * Assemble a PDF with a classic xref table from object bodies. Returns the file text and the
 * offsets of each object, so tests can corrupt them deliberately.
 */
export function miniPdf(objects: MiniObject[], trailer: string, opts: { header?: string } = {}): { text: string; offsets: Map<number, number> } {
  const parts: string[] = [opts.header ?? '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'];
  let len = parts[0].length;
  const offsets = new Map<number, number>();
  const gens = new Map<number, number>();
  let size = 1;
  for (const o of objects) {
    offsets.set(o.num, len);
    gens.set(o.num, o.gen ?? 0);
    const s = `${o.num} ${o.gen ?? 0} obj\n${o.body}\nendobj\n`;
    parts.push(s);
    len += s.length;
    size = Math.max(size, o.num + 1);
  }
  const xref = len;
  parts.push(`xref\n0 ${size}\n0000000000 65535 f\r\n`);
  for (let n = 1; n < size; n++) {
    const off = offsets.get(n);
    parts.push(off === undefined ? '0000000000 00000 f\r\n' : `${String(off).padStart(10, '0')} ${String(gens.get(n)).padStart(5, '0')} n\r\n`);
  }
  let text = parts.join('');
  text += `trailer\n<< /Size ${size} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return { text, offsets };
}

/** A minimal one-page document: catalog 1, pages 2, page 3, content 4. */
export const BASE_OBJECTS: MiniObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>' },
  { num: 4, body: '<< /Length 23 >>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream' },
];
