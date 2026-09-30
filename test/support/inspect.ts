/** Structural view of a PDF through the project's own reader, for object-level comparisons. */
import { PdfDocument } from '../../src/core/document.ts';
import { PdfDict } from '../../src/core/objects.ts';
import { SourceReader } from '../../src/core/reader.ts';
import type { RandomAccessSource } from '../../src/core/types.ts';
import { E_COMPRESSED } from '../../src/core/xref.ts';

/** In-memory RandomAccessSource. */
export class BytesSource implements RandomAccessSource {
  readonly data: Uint8Array;
  readonly size: number;
  constructor(data: Uint8Array) {
    this.data = data;
    this.size = data.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.data.slice(offset, Math.min(this.size, offset + length));
  }
}

export interface ObjInfo {
  num: number;
  gen: number;
  offset: number;
  /** The object's source text through `endobj` (trailing whitespace removed). */
  bytes: Uint8Array;
  /** Parsed value (the stream dictionary for streams); undefined when unparseable. */
  value?: unknown;
  dict?: PdfDict;
  stream: boolean;
  /** Stream data, when the stream's extent could be determined. */
  data?: Uint8Array;
}

export interface Structure {
  doc: PdfDocument;
  uncompressed: Map<number, ObjInfo>;
  /** num -> [object stream number, index]. */
  compressed: Map<number, [number, number]>;
  /** The value of the last `startxref`. */
  startxref: number;
}

const isWs = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

export function trimEnd(b: Uint8Array): Uint8Array {
  let e = b.length;
  while (e > 0 && isWs(b[e - 1])) e--;
  return b.subarray(0, e);
}

export function lastStartxref(b: Uint8Array): number {
  const tail = Buffer.from(b.subarray(Math.max(0, b.length - 4096))).toString('latin1');
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  return m ? Number(m[1]) : -1;
}

/** Open `data` with the project's reader and describe every live object. */
export async function inspect(data: Uint8Array): Promise<Structure> {
  const reader = new SourceReader(new BytesSource(data));
  const doc = await PdfDocument.open(reader);
  const index = doc.index;
  const order = index.sortedOffsets();
  const sections = [...doc.sections].sort((a, b) => a - b);
  const uncompressed = new Map<number, ObjInfo>();
  const compressed = new Map<number, [number, number]>();
  for (let i = 0; i < order.length; i++) {
    const num = order[i];
    const offset = index.a[num];
    let boundary = i + 1 < order.length ? index.a[order[i + 1]] : data.length;
    for (const s of sections) {
      if (s > offset) {
        boundary = Math.min(boundary, s);
        break;
      }
    }
    const hdr = await doc.header(num);
    if (!hdr) {
      uncompressed.set(num, { num, gen: index.b[num], offset, bytes: trimEnd(data.subarray(offset, boundary)), stream: false });
      continue;
    }
    const span = await doc.span(hdr, boundary);
    const info: ObjInfo = {
      num,
      gen: hdr.gen,
      offset,
      bytes: trimEnd(data.subarray(span.start, span.end)),
      value: hdr.value,
      stream: hdr.stream,
    };
    if (hdr.value instanceof PdfDict) info.dict = hdr.value;
    if (hdr.stream && span.dataEnd >= 0) info.data = data.subarray(span.dataStart, span.dataEnd);
    uncompressed.set(num, info);
  }
  for (let n = 0; n < index.size; n++) {
    if (index.get(n) === E_COMPRESSED) compressed.set(n, [index.a[n], index.b[n]]);
  }
  return { doc, uncompressed, compressed, startxref: lastStartxref(data) };
}
