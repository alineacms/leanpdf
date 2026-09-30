import { EMPTY } from './bytes.ts';
import { PdfSyntaxError } from './errors.ts';
import { Lexer, T_ACLOSE, T_AOPEN, T_DCLOSE, T_DOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR, type Token } from './lexer.ts';

export class PdfName {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class PdfRef {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}

/** A string kept as its raw source bytes, delimiters included. Values are never interpreted. */
export class PdfString {
  readonly raw: Uint8Array;
  constructor(raw: Uint8Array) {
    this.raw = raw;
  }
}

export class PdfDict {
  readonly map = new Map<string, PdfObj>();
  /** Raw source bytes of each value, so unchanged entries can be written back verbatim. */
  readonly raw = new Map<string, Uint8Array>();
  /** The dictionary repeated a key. */
  dup = false;

  get(key: string): PdfObj | undefined {
    return this.map.get(key);
  }

  set(key: string, value: PdfObj, raw: Uint8Array): void {
    if (this.map.has(key)) this.dup = true;
    this.map.set(key, value);
    this.raw.set(key, raw);
  }
}

export type PdfObj = null | boolean | number | PdfName | PdfString | PdfRef | PdfDict | PdfObj[];

export const nameOf = (o: PdfObj | undefined): string | undefined => (o instanceof PdfName ? o.name : undefined);
export const numOf = (o: PdfObj | undefined): number | undefined => (typeof o === 'number' ? o : undefined);
export const intOf = (o: PdfObj | undefined): number | undefined =>
  typeof o === 'number' && Number.isInteger(o) ? o : undefined;

const STRUCTURAL = /* @__PURE__ */ new Set(['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref']);
const MAX_DEPTH = 100;

/** Object parser on top of the lexer, with two tokens of lookahead for `N G R`. */
export class Parser {
  readonly lex: Lexer;
  private q: Token[] = [];
  /** End offset of the last consumed token. */
  lastEnd = 0;

  constructor(lex: Lexer) {
    this.lex = lex;
  }

  peek(i = 0): Token {
    while (this.q.length <= i) this.q.push(this.lex.next());
    return this.q[i];
  }

  next(): Token {
    const t = this.q.length ? this.q.shift()! : this.lex.next();
    this.lastEnd = t.e;
    return t;
  }

  parse(depth = 0): PdfObj {
    if (depth > MAX_DEPTH) throw new PdfSyntaxError('objects nested too deeply');
    const t = this.next();
    switch (t.t) {
      case T_NUM: {
        const v = t.v as number;
        if (t.int && v >= 0) {
          const g = this.peek();
          if (g.t === T_NUM && g.int && (g.v as number) >= 0) {
            const r = this.peek(1);
            if (r.t === T_KW && r.v === 'R') {
              this.next();
              this.next();
              return new PdfRef(v, g.v as number);
            }
          }
        }
        return v;
      }
      case T_NAME:
        return new PdfName(t.v as string);
      case T_STR:
        return new PdfString(t.v as Uint8Array);
      case T_AOPEN: {
        const arr: PdfObj[] = [];
        for (;;) {
          const p = this.peek();
          if (p.t === T_ACLOSE) {
            this.next();
            return arr;
          }
          if (p.t === T_EOF || p.t === T_DCLOSE) throw new PdfSyntaxError('unterminated array');
          arr.push(this.parse(depth + 1));
        }
      }
      case T_DOPEN: {
        const d = new PdfDict();
        for (;;) {
          const k = this.next();
          if (k.t === T_DCLOSE) return d;
          if (k.t === T_EOF) throw new PdfSyntaxError('unterminated dictionary');
          if (k.t !== T_NAME) {
            if (k.t === T_KW && STRUCTURAL.has(k.v as string)) throw new PdfSyntaxError('unterminated dictionary');
            if (k.t === T_DOPEN || k.t === T_AOPEN) {
              // A stray container where a key belongs: skip all of it, not just its opening token.
              this.q.unshift(k);
              this.parse(depth + 1);
            }
            continue; // tolerate stray tokens
          }
          const v0 = this.peek();
          if (v0.t === T_DCLOSE) {
            d.set(k.v as string, null, EMPTY);
            continue;
          }
          const value = this.parse(depth + 1);
          d.set(k.v as string, value, this.lex.buf.subarray(v0.s, this.lastEnd));
        }
      }
      case T_KW:
        if (t.v === 'true') return true;
        if (t.v === 'false') return false;
        if (t.v === 'null') return null;
        if (STRUCTURAL.has(t.v as string)) throw new PdfSyntaxError(`unexpected keyword ${t.v}`);
        return null;
      case T_EOF:
        throw new PdfSyntaxError('unexpected end of data');
      default:
        throw new PdfSyntaxError('unexpected delimiter');
    }
  }
}

/** Encode a name (without the leading slash) using #xx escapes where needed. */
export function encodeName(name: string): string {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const regular = c > 0x20 && c < 0x7f && '()<>[]{}/%#'.indexOf(name[i]) < 0;
    out += regular ? name[i] : '#' + (c & 255).toString(16).padStart(2, '0');
  }
  return out;
}
