import { indexOf, isDigit, isRegular, isWhite, KW_OBJ, KW_TRAILER } from './bytes.ts';
import { isFatal, NeedMoreData } from './errors.ts';
import { Lexer } from './lexer.ts';
import { intOf, nameOf, PdfDict, Parser } from './objects.ts';
import { checkStreamEnd, readObjectAt, searchStreamEnd } from './objread.ts';
import type { SourceReader } from './reader.ts';
import { E_OFFSET, XrefIndex } from './xref.ts';

export interface ScanResult {
  index: XrefIndex;
  /** Trailer dictionaries (classic `trailer` or xref stream dicts) in file order. */
  trailers: PdfDict[];
  /** Last object that looked like a document catalog, or -1. */
  catalog: number;
  /** Object streams, in file order. */
  objStms: number[];
}

const CH = 1 << 20;
const OV = 64;

/** Parse the dictionary following a `trailer` keyword. */
async function readTrailer(reader: SourceReader, offset: number): Promise<PdfDict | null> {
  for (let win = 4096; win <= 1 << 24; win *= 4) {
    const buf = await reader.read(offset, win);
    try {
      const d = new Parser(new Lexer(buf, 0, reader.isFinal(offset, buf))).parse();
      return d instanceof PdfDict ? d : null;
    } catch (e) {
      if (!(e instanceof NeedMoreData)) return null;
    }
  }
  return null;
}

/**
 * Rebuild the object index by scanning the whole file for `N G obj`, in bounded chunks. Stream
 * bodies are skipped using their length, so data that merely looks like an object is ignored.
 * Later definitions win, matching incremental-update semantics.
 */
export async function scanObjects(reader: SourceReader, signal?: AbortSignal): Promise<ScanResult> {
  const index = new XrefIndex();
  const trailers: PdfDict[] = [];
  const objStms: number[] = [];
  let catalog = -1;
  let skipUntil = 0;
  for (let pos = 0; pos < reader.size; pos = Math.max(pos + CH - OV, skipUntil - OV / 2)) {
    signal?.throwIfAborted();
    const buf = await reader.raw(pos, Math.min(CH, reader.size - pos));
    const last = pos + buf.length >= reader.size;
    const lo = pos === 0 ? 0 : OV / 2;
    const hi = last ? buf.length : buf.length - OV / 2;
    const hits: number[] = [];
    for (let i = indexOf(buf, KW_OBJ, lo); i >= 0 && i < hi; i = indexOf(buf, KW_OBJ, i + 3)) hits.push(i);
    for (let i = indexOf(buf, KW_TRAILER, lo); i >= 0 && i < hi; i = indexOf(buf, KW_TRAILER, i + 7)) hits.push(-i - 1);
    hits.sort((x, y) => (x < 0 ? -x - 1 : x) - (y < 0 ? -y - 1 : y));
    for (const h of hits) {
      if (h < 0) {
        const i = -h - 1;
        if (pos + i < skipUntil || (i > 0 && isRegular(buf[i - 1])) || isRegular(buf[i + 7] ?? 32)) continue;
        const t = await readTrailer(reader, pos + i + 7);
        if (t) trailers.push(t);
        continue;
      }
      const i = h;
      if (i + 3 < buf.length && isRegular(buf[i + 3])) continue;
      // Walk back over "num ws gen ws".
      let j = i - 1;
      let ws = 0;
      while (j >= 0 && isWhite(buf[j])) j--, ws++;
      const genEnd = j + 1;
      while (j >= 0 && isDigit(buf[j])) j--;
      const genLen = genEnd - j - 1;
      if (!ws || genLen < 1 || genLen > 5) continue;
      ws = 0;
      while (j >= 0 && isWhite(buf[j])) j--, ws++;
      const numEnd = j + 1;
      while (j >= 0 && isDigit(buf[j])) j--;
      const numLen = numEnd - j - 1;
      if (!ws || numLen < 1 || numLen > 10 || (j >= 0 && isRegular(buf[j])) || (j < 0 && pos > 0)) continue;
      const start = pos + j + 1;
      if (start < skipUntil) continue;
      let hdr;
      try {
        hdr = await readObjectAt(reader, start, 1 << 24);
      } catch (e) {
        if (isFatal(e)) throw e;
        continue;
      }
      index.set(hdr.num, E_OFFSET, start, hdr.gen);
      const d = hdr.value;
      const type = d instanceof PdfDict ? nameOf(d.get('Type')) : undefined;
      if (hdr.stream) {
        const len = intOf((d as PdfDict).get('Length'));
        let end = -1;
        if (len !== undefined && len >= 0) end = (await checkStreamEnd(reader, hdr.dataStart + len))?.end ?? -1;
        if (end < 0) end = (await searchStreamEnd(reader, hdr.dataStart, reader.size))?.end ?? hdr.dataStart;
        skipUntil = end;
        if (type === 'XRef') trailers.push(d as PdfDict);
        else if (type === 'ObjStm') objStms.push(hdr.num);
      } else {
        if (type === 'Catalog') catalog = hdr.num;
        skipUntil = hdr.endobj >= 0 ? hdr.endobj : hdr.valueEnd;
      }
    }
    if (last) break;
  }
  return { index, trailers, catalog, objStms };
}
