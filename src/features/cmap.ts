/**
 * CMap parsing for text extraction: ToUnicode maps (bfchar/bfrange) and embedded encoding CMaps
 * of composite fonts (codespace ranges, cidchar/cidrange). Ranges are kept as ranges, never
 * expanded, so a hostile `<0000> <FFFFFFFF>` costs nothing.
 */
import { Lexer, T_ACLOSE, T_AOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR } from '../core/lexer.ts';
import { PdfString } from '../core/objects.ts';
import { stringBytes } from '../core/strings.ts';
import { glyphText } from './text-glyphs.ts';

/** A codespace range: code length in bytes and per-byte bounds. */
interface Space {
  n: number;
  lo: Uint8Array;
  hi: Uint8Array;
}

type Dest = number | string | string[];

export interface CMap {
  space: Space[];
  /** Single-code mappings (bfchar, cidchar). */
  map: Map<number, Dest>;
  /** [lo, hi, destination] (bfrange, cidrange). */
  ranges: [number, number, Dest][];
  /** Name given with `usecmap` or /UseCMap. */
  use?: string;
  /** WMode 1. */
  vertical: boolean;
}

const MAX_ENTRIES = 1 << 20;

const codeOf = (b: Uint8Array): number => {
  let v = 0;
  for (let i = 0; i < b.length && i < 4; i++) v = v * 256 + b[i];
  return v;
};

/** UTF-16BE (a lone byte is taken as a character code). */
export function utf16(b: Uint8Array): string {
  if (b.length === 1) return String.fromCharCode(b[0]);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}

/** Parse a CMap stream. Tolerant: unknown syntax is skipped. */
export function parseCMap(data: Uint8Array): CMap {
  const cm: CMap = { space: [], map: new Map(), ranges: [], vertical: false };
  const lex = new Lexer(data, 0, true);
  let mode = '';
  let args: (Uint8Array | number | string[])[] = [];
  let lastName = '';
  let entries = 0;
  for (let t = lex.next(); t.t !== T_EOF; t = lex.next()) {
    if (t.t === T_KW) {
      const k = t.v as string;
      if (k.startsWith('begin')) mode = k.slice(5);
      else if (k.startsWith('end')) mode = '';
      else if (k === 'usecmap' && lastName) cm.use = lastName;
      args = [];
      continue;
    }
    if (t.t === T_NAME) {
      lastName = t.v as string;
      if (mode === 'bfchar' && args.length === 1) {
        // Old-style destination: a glyph name.
        const code = codeOf(args[0] as Uint8Array);
        cm.map.set(code, glyphText(lastName) ?? '');
        args = [];
      }
      continue;
    }
    if (t.t === T_NUM) {
      if (lastName === 'WMode') cm.vertical = t.v === 1; // `/WMode 1 def`
      lastName = '';
      if (!mode) continue;
      args.push(t.v as number); // a CID, or a misplaced number that keeps the entries aligned
    } else if (t.t === T_STR) {
      args.push(stringBytes(new PdfString(t.v as Uint8Array)));
    } else if (t.t === T_AOPEN) {
      const list: string[] = [];
      for (let u = lex.next(); u.t !== T_ACLOSE && u.t !== T_EOF; u = lex.next()) {
        if (u.t === T_STR) list.push(utf16(stringBytes(new PdfString(u.v as Uint8Array))));
      }
      args.push(list);
    } else continue;
    if (++entries > MAX_ENTRIES) break;
    const [a, b, c] = args;
    if (mode === 'codespacerange' && args.length === 2) {
      const lo = a as Uint8Array;
      const hi = b as Uint8Array;
      if (lo instanceof Uint8Array && hi instanceof Uint8Array && lo.length === hi.length && lo.length >= 1 && lo.length <= 4) {
        cm.space.push({ n: lo.length, lo, hi });
      }
      args = [];
    } else if ((mode === 'bfchar' || mode === 'cidchar') && args.length === 2) {
      if (a instanceof Uint8Array) cm.map.set(codeOf(a), b instanceof Uint8Array ? utf16(b) : (b as number | string[]));
      args = [];
    } else if ((mode === 'bfrange' || mode === 'cidrange') && args.length === 3) {
      if (a instanceof Uint8Array && b instanceof Uint8Array) {
        const lo = codeOf(a);
        const hi = codeOf(b);
        if (hi >= lo) cm.ranges.push([lo, hi, c instanceof Uint8Array ? utf16(c) : c]);
      }
      args = [];
    } else if (args.length > 3) args = [];
  }
  cm.space.sort((x, y) => x.n - y.n);
  return cm;
}

/** Destination of `code`: text for a ToUnicode map, CID for an encoding CMap. */
export function lookup(cm: CMap, code: number): Dest | undefined {
  const v = cm.map.get(code);
  if (v !== undefined) return v;
  for (const [lo, hi, d] of cm.ranges) {
    if (code < lo || code > hi) continue;
    const k = code - lo;
    if (typeof d === 'number') return d + k;
    if (Array.isArray(d)) return d[k];
    // Increment the last UTF-16 unit of the destination.
    return d ? d.slice(0, -1) + String.fromCharCode(d.charCodeAt(d.length - 1) + k) : d;
  }
  return undefined;
}

/** Byte length of the code starting at b[i] according to the codespace ranges, or 0 if none match. */
export function codeLength(cm: CMap, b: Uint8Array, i: number): number {
  for (const s of cm.space) {
    if (i + s.n > b.length) continue;
    let k = 0;
    while (k < s.n && b[i + k] >= s.lo[k] && b[i + k] <= s.hi[k]) k++;
    if (k === s.n) return s.n;
  }
  return 0;
}
