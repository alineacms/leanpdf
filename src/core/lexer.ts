import { charClass, latin1 } from './bytes.ts';
import { NEED_MORE } from './errors.ts';

export const T_NUM = 1;
export const T_NAME = 2;
export const T_STR = 3;
export const T_KW = 4;
export const T_EOF = 5;
export const T_AOPEN = 6;
export const T_ACLOSE = 7;
export const T_DOPEN = 8;
export const T_DCLOSE = 9;

export interface Token {
  t: number;
  /** number for T_NUM, decoded name for T_NAME, keyword text for T_KW, raw bytes (with delimiters) for T_STR. */
  v: number | string | Uint8Array | null;
  /** Start offset in the buffer. */
  s: number;
  /** End offset (exclusive). */
  e: number;
  /** T_NUM only: written without a decimal point. */
  int: boolean;
}

const tok = (t: number, v: Token['v'], s: number, e: number, int = false): Token => ({ t, v, s, e, int });

/**
 * PDF tokenizer over a byte buffer. When `final` is false the buffer is a window into a larger
 * file, and any token touching the end of the window raises NeedMoreData so the caller can retry
 * with a larger window.
 */
export class Lexer {
  buf: Uint8Array;
  pos: number;
  final: boolean;

  constructor(buf: Uint8Array, pos = 0, final = true) {
    this.buf = buf;
    this.pos = pos;
    this.final = final;
  }

  /** Skip whitespace and comments. */
  skipWhite(): void {
    const b = this.buf;
    const n = b.length;
    let p = this.pos;
    for (;;) {
      while (p < n && charClass[b[p]] === 1) p++;
      if (p < n && b[p] === 0x25) {
        while (p < n && b[p] !== 10 && b[p] !== 13) p++;
        continue;
      }
      break;
    }
    this.pos = p;
  }

  next(): Token {
    this.skipWhite();
    const b = this.buf;
    const n = b.length;
    const s = this.pos;
    if (s >= n) {
      if (!this.final) throw NEED_MORE;
      return tok(T_EOF, null, s, s);
    }
    const c = b[s];
    let p = s + 1;
    switch (c) {
      case 0x5b: // [
        this.pos = p;
        return tok(T_AOPEN, null, s, p);
      case 0x5d: // ]
        this.pos = p;
        return tok(T_ACLOSE, null, s, p);
      case 0x7b: // {
      case 0x7d: // }
      case 0x29: // ) unbalanced
        this.pos = p;
        return tok(T_KW, String.fromCharCode(c), s, p);
      case 0x3c: {
        // < or <<
        if (p >= n && !this.final) throw NEED_MORE;
        if (b[p] === 0x3c) {
          this.pos = p + 1;
          return tok(T_DOPEN, null, s, p + 1);
        }
        let e = b.indexOf(0x3e, p);
        if (e < 0) {
          if (!this.final) throw NEED_MORE;
          e = n - 1;
        }
        this.pos = e + 1;
        return tok(T_STR, b.subarray(s, e + 1), s, e + 1);
      }
      case 0x3e: // > or >>
        if (p >= n && !this.final) throw NEED_MORE;
        if (b[p] === 0x3e) {
          this.pos = p + 1;
          return tok(T_DCLOSE, null, s, p + 1);
        }
        this.pos = p;
        return tok(T_KW, '>', s, p);
      case 0x28: {
        // literal string, balanced parentheses with backslash escapes
        let depth = 1;
        while (p < n) {
          const ch = b[p++];
          if (ch === 0x5c) p++;
          else if (ch === 0x28) depth++;
          else if (ch === 0x29 && --depth === 0) break;
        }
        if (depth > 0) {
          if (!this.final) throw NEED_MORE;
          p = n;
        }
        this.pos = p;
        return tok(T_STR, b.subarray(s, p), s, p);
      }
      case 0x2f: {
        // name
        while (p < n && charClass[b[p]] === 0) p++;
        if (p >= n && !this.final) throw NEED_MORE;
        this.pos = p;
        return tok(T_NAME, decodeName(b, s + 1, p), s, p);
      }
    }
    while (p < n && charClass[b[p]] === 0) p++;
    if (p >= n && !this.final) throw NEED_MORE;
    this.pos = p;
    return word(b, s, p);
  }
}

/** Interpret a run of regular characters as a number or a keyword. */
function word(b: Uint8Array, s: number, e: number): Token {
  let i = s;
  let neg = false;
  if (b[i] === 0x2b || b[i] === 0x2d) neg = b[i++] === 0x2d;
  while (i < e && b[i] === 0x2d) i++; // tolerate "--5"
  let digits = 0;
  let dot = -1;
  for (let j = i; j < e; j++) {
    const ch = b[j];
    if (ch >= 48 && ch <= 57) digits++;
    else if (ch === 0x2e && dot < 0) dot = j;
    else {
      digits = 0;
      break;
    }
  }
  if (digits > 0) {
    let v = 0;
    if (dot < 0) for (let j = i; j < e; j++) v = v * 10 + b[j] - 48;
    else v = parseFloat(latin1(b, i, e));
    return tok(T_NUM, neg ? -v : v, s, e, dot < 0);
  }
  return tok(T_KW, latin1(b, s, e), s, e);
}

const hexVal = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

function decodeName(b: Uint8Array, s: number, e: number): string {
  const hash = b.indexOf(0x23, s);
  if (hash < 0 || hash >= e) return latin1(b, s, e);
  let out = '';
  for (let i = s; i < e; i++) {
    const c = b[i];
    if (c === 0x23 && i + 2 < e) {
      const h = hexVal(b[i + 1]);
      const l = hexVal(b[i + 2]);
      if (h >= 0 && l >= 0) {
        out += String.fromCharCode(h * 16 + l);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(c);
  }
  return out;
}
