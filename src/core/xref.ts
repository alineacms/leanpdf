import { indexOf, keywordAt, KW_STARTXREF, KW_XREF, lastIndexOf, latin1, skipWhite, ascii } from './bytes.ts';
import { isFatal, NeedMoreData, PdfSyntaxError } from './errors.ts';
import { inflateRange } from './flate.ts';
import { Lexer, T_KW, T_NUM } from './lexer.ts';
import { intOf, nameOf, PdfDict, Parser, type PdfObj } from './objects.ts';
import { readObjectAt, searchStreamEnd } from './objread.ts';
import { RowDecoder } from './predictor.ts';
import type { SourceReader } from './reader.ts';

export const E_NONE = 0;
export const E_FREE = 1;
export const E_OFFSET = 2;
export const E_COMPRESSED = 3;

/** PDF implementation limit on object numbers; guards against absurd allocations. */
export const MAX_OBJECTS = 8_388_608;

/**
 * objNum -> entry, stored in typed arrays: the only O(n) structure the compressor keeps.
 * E_OFFSET: a = byte offset, b = generation. E_COMPRESSED: a = object stream number, b = index.
 * E_FREE: b = generation.
 */
export class XrefIndex {
  type: Uint8Array;
  a: Float64Array;
  b: Uint32Array;
  /** Highest object number seen + 1. */
  size = 0;

  constructor(capacity = 1024) {
    this.type = new Uint8Array(capacity);
    this.a = new Float64Array(capacity);
    this.b = new Uint32Array(capacity);
  }

  private grow(n: number): void {
    let cap = this.type.length;
    while (cap < n) cap *= 2;
    const t = new Uint8Array(cap);
    const a = new Float64Array(cap);
    const b = new Uint32Array(cap);
    t.set(this.type);
    a.set(this.a);
    b.set(this.b);
    this.type = t;
    this.a = a;
    this.b = b;
  }

  set(num: number, type: number, a: number, b: number): void {
    if (!(num >= 0 && num < MAX_OBJECTS)) return;
    if (num >= this.type.length) this.grow(num + 1);
    this.type[num] = type;
    this.a[num] = a;
    this.b[num] = b;
    if (num >= this.size) this.size = num + 1;
  }

  /** First definition wins: sections are read newest first. */
  setIfUnset(num: number, type: number, a: number, b: number): void {
    if (num < this.type.length && this.type[num] !== E_NONE) return;
    this.set(num, type, a, b);
  }

  get(num: number): number {
    return num >= 0 && num < this.size ? this.type[num] : E_NONE;
  }

  /** Object numbers of uncompressed objects, sorted by byte offset. */
  sortedOffsets(): Uint32Array {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.type[i] === E_OFFSET) n++;
    const out = new Uint32Array(n);
    n = 0;
    for (let i = 0; i < this.size; i++) if (this.type[i] === E_OFFSET) out[n++] = i;
    const a = this.a;
    return out.sort((x, y) => a[x] - a[y]);
  }
}

type EntryFn = (num: number, type: number, a: number, b: number) => void;

/** Keys that describe a cross-reference section rather than the document. */
export const XREF_KEYS = new Set([
  'Size', 'Prev', 'XRefStm', 'Type', 'W', 'Index', 'Filter', 'DecodeParms', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms',
]);

export interface XrefLoad {
  index: XrefIndex;
  /** Trailer keys merged across sections, newest wins. */
  trailer: PdfDict;
  /** Offsets of all cross-reference sections (they bound the objects before them). */
  sections: number[];
  /** Largest /Size declared by any section. */
  declaredSize: number;
}

/** Locate the `startxref` value near the end of the file, or -1. */
export async function findStartXref(reader: SourceReader): Promise<number> {
  for (const tail of [2048, 1 << 16, 1 << 20]) {
    const off = Math.max(0, reader.size - tail);
    const buf = await reader.read(off, tail);
    const i = lastIndexOf(buf, KW_STARTXREF);
    if (i >= 0) {
      const t = new Lexer(buf, i + 9, true).next();
      if (t.t === T_NUM && t.int) return t.v as number;
    }
    if (off === 0) break;
  }
  return -1;
}

/** Find the `%PDF-x.y` header in the first KB. */
export async function findHeader(reader: SourceReader): Promise<{ offset: number; version: string }> {
  const buf = await reader.read(0, 1024);
  const i = indexOf(buf, ascii('%PDF-'));
  if (i < 0) return { offset: -1, version: '1.4' };
  const m = /^\d\.\d/.exec(latin1(buf, i + 5, Math.min(buf.length, i + 8)));
  return { offset: i, version: m ? m[0] : '1.4' };
}

/** Parse a classic `xref` table and its trailer, streaming the entries in bounded chunks. */
export async function parseXrefTable(reader: SourceReader, offset: number, onEntry: EntryFn): Promise<PdfDict> {
  const head = await reader.read(offset, 64);
  const start = skipWhite(head, 0);
  if (!keywordAt(head, start, KW_XREF)) throw new PdfSyntaxError('expected xref');
  let pos = offset + start + 4;
  let remaining = 0;
  let num = 0;
  let firstOfTable = true;
  let chunk = 1 << 16;
  for (;;) {
    const buf = await reader.read(pos, chunk);
    const lex = new Lexer(buf, 0, reader.isFinal(pos, buf));
    let committed = 0;
    try {
      for (;;) {
        if (remaining > 0) {
          const o = lex.next();
          const g = lex.next();
          const k = lex.next();
          if (o.t !== T_NUM || g.t !== T_NUM || k.t !== T_KW || (k.v !== 'n' && k.v !== 'f')) {
            throw new PdfSyntaxError('bad xref entry');
          }
          // Some writers number the first table "1 N" while listing object 0 first.
          if (firstOfTable && num === 1 && k.v === 'f' && o.v === 0 && g.v === 65535) num = 0;
          firstOfTable = false;
          onEntry(num++, k.v === 'n' ? E_OFFSET : E_FREE, o.v as number, g.v as number);
          remaining--;
          committed = lex.pos;
          continue;
        }
        const t = lex.next();
        if (t.t === T_NUM && t.int) {
          const c = lex.next();
          if (c.t !== T_NUM || !c.int) throw new PdfSyntaxError('bad xref subsection');
          num = t.v as number;
          remaining = c.v as number;
          committed = lex.pos;
          continue;
        }
        if (t.t === T_KW && t.v === 'trailer') {
          const d = new Parser(lex).parse();
          if (!(d instanceof PdfDict)) throw new PdfSyntaxError('bad trailer');
          return d;
        }
        throw new PdfSyntaxError('bad xref table');
      }
    } catch (e) {
      if (!(e instanceof NeedMoreData)) throw e;
      if (committed === 0) {
        if (chunk >= 1 << 26) throw new PdfSyntaxError('xref table too large');
        chunk *= 4;
      }
      pos += committed;
    }
  }
}

const be = (row: Uint8Array, at: number, w: number): number => {
  let v = 0;
  for (let i = 0; i < w; i++) v = v * 256 + row[at + i];
  return v;
};

/** Parse an xref stream (`/Type /XRef`) at `offset`, streaming entries through the decoder. */
export async function parseXrefStream(reader: SourceReader, offset: number, onEntry: EntryFn): Promise<PdfDict> {
  const hdr = await readObjectAt(reader, offset);
  const d = hdr.value;
  if (!hdr.stream || !(d instanceof PdfDict) || nameOf(d.get('Type')) !== 'XRef') throw new PdfSyntaxError('expected xref stream');
  const W = d.get('W');
  if (!Array.isArray(W) || W.length < 3) throw new PdfSyntaxError('bad /W');
  const w = W.slice(0, 3).map((x) => intOf(x) ?? -1);
  if (w.some((x) => x < 0 || x > 8)) throw new PdfSyntaxError('bad /W');
  const rowLen = w[0] + w[1] + w[2];
  if (rowLen === 0) throw new PdfSyntaxError('bad /W');
  const size = intOf(d.get('Size')) ?? 0;
  const idxObj = d.get('Index');
  const idx = (Array.isArray(idxObj) ? idxObj : [0, size]).map((x) => intOf(x) ?? -1);
  if (idx.length % 2 || idx.some((x) => x < 0)) throw new PdfSyntaxError('bad /Index');
  let expected = 0;
  for (let i = 1; i < idx.length; i += 2) expected += idx[i];

  let length = intOf(d.get('Length'));
  if (length === undefined || length < 0 || hdr.dataStart + length > reader.size) {
    const s = await searchStreamEnd(reader, hdr.dataStart, reader.size);
    if (!s) throw new PdfSyntaxError('xref stream without end');
    length = s.dataEnd - hdr.dataStart;
  }

  const filter = d.get('Filter');
  const fname = nameOf(Array.isArray(filter) ? (filter.length === 1 ? filter[0] : undefined) : filter);
  if (filter !== undefined && fname !== 'FlateDecode' && fname !== 'Fl') throw new PdfSyntaxError('unsupported xref stream filter');
  let parms: PdfObj | undefined = d.get('DecodeParms');
  if (Array.isArray(parms)) parms = parms[0];
  const pd = parms instanceof PdfDict ? parms : undefined;
  const predictor = (pd && intOf(pd.get('Predictor'))) || 1;
  const columns = (pd && intOf(pd.get('Columns'))) || rowLen;
  const colors = (pd && intOf(pd.get('Colors'))) || 1;
  const bpc = (pd && intOf(pd.get('BitsPerComponent'))) || 8;

  // Entries are assembled from predictor rows, which need not line up with entry rows.
  const entry = new Uint8Array(rowLen);
  let fill = 0;
  let sub = 0;
  let left = idx[1] ?? 0;
  let num = idx[0] ?? 0;
  let seen = 0;
  const emit = (): boolean => {
    while (left === 0) {
      sub += 2;
      if (sub >= idx.length) return true;
      num = idx[sub];
      left = idx[sub + 1];
    }
    const type = w[0] ? be(entry, 0, w[0]) : 1;
    const a = be(entry, w[0], w[1]);
    const b = w[2] ? be(entry, w[0] + w[1], w[2]) : 0;
    if (type === 0) onEntry(num, E_FREE, a, b);
    else if (type === 1) onEntry(num, E_OFFSET, a, b);
    else if (type === 2) onEntry(num, E_COMPRESSED, a, b);
    num++;
    left--;
    return ++seen >= expected;
  };
  const dec = new RowDecoder(predictor, colors, bpc, columns, (row) => {
    for (let i = 0; i < row.length; ) {
      const take = Math.min(row.length - i, rowLen - fill);
      entry.set(row.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill === rowLen) {
        fill = 0;
        if (emit()) return true;
      }
    }
  });
  if (expected > 0) {
    if (filter === undefined) {
      for (let p = hdr.dataStart, end = hdr.dataStart + length; p < end; p += 1 << 16) {
        if (dec.push(await reader.raw(p, Math.min(1 << 16, end - p)))) break;
      }
    } else {
      await inflateRange(reader, hdr.dataStart, length, (c) => dec.push(c));
    }
  }
  if (seen < expected) throw new PdfSyntaxError('truncated xref stream');
  return d;
}

/** Merge trailers newest first, dropping keys that only describe the xref section. */
function mergeTrailers(trailers: PdfDict[]): PdfDict {
  const out = new PdfDict();
  for (const t of trailers) {
    for (const [k, v] of t.map) {
      if (!XREF_KEYS.has(k) && !out.map.has(k)) out.set(k, v, t.raw.get(k)!);
    }
  }
  return out;
}

/**
 * Follow the xref chain from `startxref` through /Prev and /XRefStm. Later sections win; within a
 * hybrid section, in-use table entries beat the XRefStm, which beats free table entries.
 * `delta` is added to every offset (for files with junk before the header).
 */
export async function loadXref(reader: SourceReader, startxref: number, delta = 0): Promise<XrefLoad> {
  const index = new XrefIndex();
  const setIfUnset: EntryFn = (n, t, a, b) => index.setIfUnset(n, t, t === E_OFFSET ? a + delta : a, b);
  const trailers: PdfDict[] = [];
  const sections: number[] = [];
  const seen = new Set<number>();
  const queue = [startxref + delta];
  let declaredSize = 0;
  while (queue.length) {
    const off = queue.shift()!;
    if (seen.has(off)) continue;
    if (seen.size > 4096) throw new PdfSyntaxError('xref chain too long');
    if (!(off >= 0 && off < reader.size)) throw new PdfSyntaxError('xref offset out of range');
    seen.add(off);
    const head = await reader.read(off, 32);
    let trailer: PdfDict;
    if (keywordAt(head, skipWhite(head, 0), KW_XREF)) {
      const frees: number[] = [];
      trailer = await parseXrefTable(reader, off, (n, t, a, b) => (t === E_FREE ? frees.push(n, b) : setIfUnset(n, t, a, b)));
      const stm = intOf(trailer.get('XRefStm'));
      if (stm !== undefined && !seen.has(stm + delta)) {
        seen.add(stm + delta);
        await parseXrefStream(reader, stm + delta, setIfUnset);
        sections.push(stm + delta);
      }
      for (let i = 0; i < frees.length; i += 2) index.setIfUnset(frees[i], E_FREE, 0, frees[i + 1]);
    } else {
      trailer = await parseXrefStream(reader, off, setIfUnset);
    }
    sections.push(off);
    trailers.push(trailer);
    const size = intOf(trailer.get('Size'));
    if (size !== undefined && size > declaredSize && size <= MAX_OBJECTS) declaredSize = size;
    const prev = intOf(trailer.get('Prev'));
    if (prev !== undefined) queue.push(prev + delta);
  }
  if (index.size === 0) throw new PdfSyntaxError('empty xref');
  index.set(0, E_FREE, 0, 65535);
  return { index, trailer: mergeTrailers(trailers), sections, declaredSize };
}

/**
 * Check that every uncompressed entry points at `N G obj`. Offsets that point at whitespace
 * just before the object are corrected in place. Returns the object numbers that failed.
 */
export async function validateOffsets(reader: SourceReader, index: XrefIndex, order: Uint32Array): Promise<number[]> {
  const bad: number[] = [];
  for (const num of order) {
    const off = index.a[num];
    let ok = false;
    try {
      const buf = await reader.read(off, 64);
      const lex = new Lexer(buf, 0, true);
      lex.skipWhite();
      const start = lex.pos;
      const a = lex.next();
      const g = lex.next();
      const k = lex.next();
      ok = a.t === T_NUM && a.v === num && g.t === T_NUM && g.v === index.b[num] && k.t === T_KW && k.v === 'obj';
      if (ok && start > 0) index.a[num] = off + start;
    } catch (e) {
      if (isFatal(e)) throw e;
    }
    if (!ok) bad.push(num);
  }
  return bad;
}
