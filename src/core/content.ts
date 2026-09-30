/**
 * Content stream helpers shared by text extraction and rendering: a page's concatenated content,
 * array and dictionary operands, and inline images.
 */
import { isRegular, isWhite } from './bytes.ts';
import { readStream } from './decode.ts';
import type { PdfDocument } from './document.ts';
import { Lexer, T_ACLOSE, T_AOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR } from './lexer.ts';
import { intOf, nameOf, numOf, Parser, PdfDict, PdfName, PdfRef, type PdfObj } from './objects.ts';

/** An operand on the content stream stack. */
export type Operand = number | Uint8Array | PdfName | PdfDict | Operand[] | null;

/** A page's content streams, concatenated with a line break between them (at most `max` bytes). */
export async function pageContent(doc: PdfDocument, c: PdfObj | undefined, max: number): Promise<Uint8Array> {
  let list: PdfObj[] = [c ?? null];
  if (c instanceof PdfRef) {
    const o = await doc.getObject(c.num);
    if (Array.isArray(o)) list = o;
  } else if (Array.isArray(c)) list = c;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const ref of list) {
    const data = ref instanceof PdfRef && (await readStream(doc, ref, max - total));
    if (!data) continue;
    parts.push(data);
    total += data.length + 1;
  }
  const out = new Uint8Array(total).fill(10);
  total = 0;
  for (const p of parts) {
    out.set(p, total);
    total += p.length + 1;
  }
  return out;
}

/** Array operand (TJ, dash patterns, decode arrays): numbers, strings, names, nested arrays. */
export function readArray(lex: Lexer, depth = 0): Operand[] {
  const out: Operand[] = [];
  while (out.length < 1 << 16) {
    const t = lex.next();
    if (t.t === T_ACLOSE || t.t === T_EOF) break;
    if (t.t === T_NUM || t.t === T_STR) out.push(t.v as number | Uint8Array);
    else if (t.t === T_NAME) out.push(new PdfName(t.v as string));
    else if (t.t === T_AOPEN && depth < 8) out.push(readArray(lex, depth + 1));
    else if (t.t === T_KW && !/^(true|false|null)$/.test(t.v as string)) {
      // An operator: the array was never closed. Leave the operator for the interpreter.
      lex.pos = t.s;
      break;
    }
  }
  return out;
}

/** Parse one object at `start` with the object parser; resume after what it consumed. */
export function readObject(lex: Lexer, start: number): PdfObj {
  lex.pos = start;
  const p = new Parser(lex);
  let v: PdfObj = null;
  try {
    v = p.parse();
  } catch {
    // Malformed: keep going after the consumed tokens.
  }
  lex.pos = Math.max(p.lastEnd, start + 1);
  return v;
}

/** Dictionary operand (BDC properties). */
export function readDict(lex: Lexer, start: number): PdfDict | null {
  const v = readObject(lex, start);
  return v instanceof PdfDict ? v : null;
}

const COMPONENTS: Record<string, number> = { G: 1, DeviceGray: 1, CalGray: 1, I: 1, Indexed: 1, RGB: 3, DeviceRGB: 3, CalRGB: 3, CMYK: 4, DeviceCMYK: 4 };

/** An inline image: its dictionary entries (abbreviated keys as written) and its data. */
export interface InlineImage {
  info: Map<string, PdfObj>;
  data: Uint8Array;
}

/**
 * Read an inline image after `BI` (`<entries> ID <data> EI`). The data length is computed when
 * the image is unfiltered (or has /L), else we look for an `EI` between whitespace that is
 * followed by something that looks like content. Leaves the lexer after `EI`.
 */
export function readInlineImage(lex: Lexer): InlineImage {
  const b = lex.buf;
  const info = new Map<string, PdfObj>();
  for (;;) {
    const t = lex.next();
    if (t.t === T_EOF) return { info, data: new Uint8Array(0) };
    if (t.t === T_KW && t.v === 'ID') break;
    if (t.t !== T_NAME) continue;
    const at = lex.pos;
    const peek = lex.next();
    if (peek.t === T_KW && peek.v === 'ID') break;
    info.set(t.v as string, readObject(lex, at));
  }
  const start = lex.pos + 1;
  const get = (k: string, short: string) => info.get(k) ?? info.get(short);
  const f = get('Filter', 'F');
  const im = get('ImageMask', 'IM') === true;
  const w = intOf(get('Width', 'W'));
  const h = intOf(get('Height', 'H'));
  const cs = get('ColorSpace', 'CS');
  const comps = im ? 1 : COMPONENTS[nameOf(Array.isArray(cs) ? cs[0] : cs) ?? ''];
  const bpc = im ? 1 : (intOf(get('BitsPerComponent', 'BPC')) ?? 8);
  let len = numOf(get('Length', 'L')) ?? -1;
  if ((f === undefined || (Array.isArray(f) && !f.length)) && w && h && comps) len = h * Math.ceil((w * comps * bpc) / 8);
  let e = start + len;
  while (len >= 0 && e < b.length && isWhite(b[e])) e++;
  if (len < 0 || b[e] !== 0x45 || b[e + 1] !== 0x49 || isRegular(b[e + 2] ?? 32)) {
    // Unknown or wrong length: search for a plausible EI.
    for (e = b.indexOf(0x45, start); e >= 0; e = b.indexOf(0x45, e + 1)) {
      if (b[e + 1] === 0x49 && e >= start && isWhite(b[e - 1]) && isWhite(b[e + 2] ?? 32) && looksLikeContent(b, e + 2)) break;
    }
    if (e < 0) e = b.length;
    len = e - start;
  }
  lex.pos = e + 2;
  return { info, data: b.subarray(start, Math.min(b.length, start + Math.max(0, len))) };
}

/** Are the bytes after a candidate `EI` plausible content (text up to the next string)? */
function looksLikeContent(b: Uint8Array, i: number): boolean {
  for (const end = Math.min(b.length, i + 48); i < end; i++) {
    const c = b[i];
    if (c === 0x28 || c === 0x3c) return true;
    if (c > 0x7e || (c < 0x20 && !isWhite(c))) return false;
  }
  return true;
}
