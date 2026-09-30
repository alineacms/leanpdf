import { latin1 } from '../core/bytes.ts';
import { Lexer, T_EOF, T_KW, T_NUM, type Token } from '../core/lexer.ts';
import { encodeName, nameOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { serialize } from '../core/serialize.ts';

/** How one input's objects are written into the merged document's number space. */
export interface Numbering {
  /** Output object number of source object `num`; 0 when it is not written. */
  out(num: number): number;
  /** The explicit destination a named destination resolves to, if known. */
  dest(name: PdfObj | undefined): PdfObj | undefined;
}

/** A reference in the output, or `null` for an object that is not written. */
export const refText = (n: Numbering, num: number): string => {
  const o = n.out(num);
  return o > 0 ? `${o} 0 R` : 'null';
};

const isIntTok = (t: Token | null): t is Token => t !== null && t.t === T_NUM && t.int && (t.v as number) >= 0;

/** Source bytes of a value with every `N G R` renumbered; all other bytes are copied as they are. */
export function renum(b: Uint8Array, n: Numbering): string {
  const lex = new Lexer(b, 0, true);
  let s = '';
  let last = 0;
  let a: Token | null = null;
  let g: Token | null = null;
  for (let t = lex.next(); t.t !== T_EOF; t = lex.next()) {
    if (t.t === T_KW && t.v === 'R' && isIntTok(a) && isIntTok(g)) {
      s += latin1(b, last, a.s) + refText(n, a.v as number);
      last = t.e;
      a = g = null;
    } else {
      a = g;
      g = t;
    }
  }
  return s + latin1(b, last, b.length);
}

/** Arrays under these keys leave out references to objects that are not written. */
const LISTS = ['Kids', 'Annots', 'Fields'];

const isGoTo = (d: PdfObj | undefined): d is PdfDict => d instanceof PdfDict && nameOf(d.get('S')) === 'GoTo';
const isDestKey = (d: PdfDict, k: string): boolean => k === 'Dest' || (k === 'D' && isGoTo(d));

/** Does destination `v` (explicit or named) lead to a page of the output? */
function liveDest(v: PdfObj | undefined, n: Numbering): boolean {
  const d = n.dest(v) ?? v;
  return Array.isArray(d) && d[0] !== null && !(d[0] instanceof PdfRef && !n.out(d[0].num));
}

/**
 * Serialize a value into the output number space. Dictionary entries keep their source bytes
 * (renumbered); nested dictionaries are rebuilt so that named destinations can be replaced by the
 * explicit ones they resolve to. /Dest entries and GoTo /A actions that lead nowhere in the output
 * (a page that is left out, an unknown name) are removed. `edits` replaces top-level entries (null
 * removes one); new keys go last.
 */
export function ser(o: PdfObj | undefined, n: Numbering, edits?: Map<string, string | null>): string {
  if (o instanceof PdfRef) return refText(n, o.num);
  if (Array.isArray(o)) return `[${o.map((x) => ser(x, n)).join(' ')}]`;
  if (!(o instanceof PdfDict)) return serialize(o);
  let s = '<<';
  for (const [k, v] of o.map) {
    let t = edits?.get(k);
    if (t === null) continue;
    if (t === undefined) {
      if (k === 'Dest' ? !liveDest(v, n) : k === 'A' && isGoTo(v) && !liveDest(v.get('D'), n)) continue;
      const dest = isDestKey(o, k) ? n.dest(v) : undefined;
      const raw = o.raw.get(k);
      if (dest) t = ser(dest, n);
      else if (v instanceof PdfDict) t = ser(v, n);
      else if (Array.isArray(v) && LISTS.includes(k)) t = ser(v.filter((x) => !(x instanceof PdfRef) || n.out(x.num) > 0), n);
      else t = raw && raw.length ? renum(raw, n) : ser(v, n);
    }
    s += `${encodeName(k)} ${t}\n`;
  }
  if (edits) for (const [k, t] of edits) if (t !== null && !o.map.has(k)) s += `${encodeName(k)} ${t}\n`;
  return s + '>>';
}

/** Collect the named destinations `ser` may replace, so they can be looked up beforehand. */
export function namedDests(o: PdfObj | undefined, out: (PdfString | PdfName)[], depth = 0): void {
  if (depth > 100) return;
  if (Array.isArray(o)) for (const x of o) namedDests(x, out, depth + 1);
  else if (o instanceof PdfDict) {
    for (const [k, v] of o.map) {
      if (isDestKey(o, k) && (v instanceof PdfString || v instanceof PdfName)) out.push(v);
      else namedDests(v, out, depth + 1);
    }
  }
}
