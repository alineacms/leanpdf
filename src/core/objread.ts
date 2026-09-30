import { indexOf, keywordAt, KW_ENDOBJ, KW_ENDSTREAM, skipWhite } from './bytes.ts';
import { NEED_MORE, NeedMoreData, PdfSyntaxError } from './errors.ts';
import { Lexer, T_KW, T_NUM } from './lexer.ts';
import { PdfDict, Parser, type PdfObj } from './objects.ts';
import type { SourceReader } from './reader.ts';

/** The parsed head of an indirect object: `N G obj <value>` and, for streams, where data starts. */
export interface ObjHeader {
  num: number;
  gen: number;
  /** Absolute offset of the object number. */
  offset: number;
  /** The object value; the stream dictionary for streams. */
  value: PdfObj;
  stream: boolean;
  /** Absolute offset of the first stream data byte (streams only, else -1). */
  dataStart: number;
  /** Absolute offset just past the value. */
  valueEnd: number;
  /** Absolute offset just past `endobj` (non-streams), or -1 when it is missing. */
  endobj: number;
}

const MAX_HEADER = 64 << 20;

/** Parse `N G obj <value>` from a buffer whose first byte is at absolute offset `base`. */
export function parseObjectHeader(buf: Uint8Array, base: number, final: boolean): ObjHeader {
  const lex = new Lexer(buf, 0, final);
  const p = new Parser(lex);
  const a = p.next();
  const g = p.next();
  const k = p.next();
  if (a.t !== T_NUM || !a.int || g.t !== T_NUM || !g.int || k.t !== T_KW || k.v !== 'obj') {
    throw new PdfSyntaxError('expected "N G obj"');
  }
  const first = p.peek();
  const value = first.t === T_KW && first.v === 'endobj' ? null : p.parse();
  const valueEnd = p.lastEnd;
  const t = p.peek();
  const head = { num: a.v as number, gen: g.v as number, offset: base + a.s, value, valueEnd: base + valueEnd };
  if (value instanceof PdfDict && t.t === T_KW && t.v === 'stream') {
    let q = t.e;
    if (q + 1 >= buf.length && !final) throw NEED_MORE;
    if (buf[q] === 13) q++;
    if (buf[q] === 10) q++;
    return { ...head, stream: true, dataStart: base + q, endobj: -1 };
  }
  const endobj = t.t === T_KW && t.v === 'endobj' ? base + t.e : -1;
  return { ...head, stream: false, dataStart: -1, endobj };
}

/** Read and parse an object header at `offset`, growing the read window as needed. */
export async function readObjectAt(reader: SourceReader, offset: number, maxWindow = MAX_HEADER): Promise<ObjHeader> {
  for (let win = 1024; ; win *= 4) {
    const buf = await reader.read(offset, win);
    const final = reader.isFinal(offset, buf);
    try {
      return parseObjectHeader(buf, offset, final);
    } catch (e) {
      if (!(e instanceof NeedMoreData)) throw e;
      if (win >= maxWindow) throw new PdfSyntaxError('object header too large');
    }
  }
}

export interface StreamEnd {
  /** Absolute offset just past `endobj`, or past `endstream` if `endobj` is missing. */
  end: number;
  endobj: boolean;
}

/** Check for (whitespace) `endstream` [`endobj`] at `dataEnd`. */
export async function checkStreamEnd(reader: SourceReader, dataEnd: number): Promise<StreamEnd | null> {
  const buf = await reader.read(dataEnd, 128);
  let p = skipWhite(buf, 0);
  if (p + 9 > buf.length || indexOf(buf, KW_ENDSTREAM, p, p + 9) !== p) return null;
  p += 9;
  const lex = new Lexer(buf, p, true);
  lex.skipWhite();
  if (keywordAt(buf, lex.pos, KW_ENDOBJ)) return { end: dataEnd + lex.pos + 6, endobj: true };
  return { end: dataEnd + p, endobj: false };
}

/**
 * Search [from, limit) for `endstream`, preferring one followed by `endobj`. Used when /Length
 * is wrong. Returns the data end (EOL before `endstream` stripped) and object end.
 */
export async function searchStreamEnd(
  reader: SourceReader,
  from: number,
  limit: number,
): Promise<(StreamEnd & { dataEnd: number }) | null> {
  const CH = 1 << 16;
  let fallback: (StreamEnd & { dataEnd: number }) | null = null;
  for (let pos = from; pos < limit; pos += CH - 16) {
    const buf = await reader.raw(pos, Math.min(CH, limit - pos + 16));
    if (!buf.length) break;
    for (let i = indexOf(buf, KW_ENDSTREAM); i >= 0 && pos + i < limit; i = indexOf(buf, KW_ENDSTREAM, i + 9)) {
      let dataEnd = pos + i;
      if (buf[i - 1] === 10) dataEnd--;
      if (buf[dataEnd - pos - 1] === 13) dataEnd--;
      if (dataEnd < from) dataEnd = from;
      const r = await checkStreamEnd(reader, pos + i);
      if (!r) continue;
      if (r.endobj) return { ...r, dataEnd };
      fallback ??= { ...r, dataEnd };
    }
    if (pos + buf.length >= limit) break;
  }
  return fallback;
}
