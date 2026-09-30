/** Byte-level helpers. Everything works on Uint8Array; strings only for short latin1 slices. */

/** 1 = whitespace, 2 = delimiter, 0 = regular character. */
export const charClass = /* @__PURE__ */ (() => {
  const t = new Uint8Array(256);
  for (const c of [0, 9, 10, 12, 13, 32]) t[c] = 1;
  for (const c of '()<>[]{}/%') t[c.charCodeAt(0)] = 2;
  return t;
})();

export const isWhite = (c: number): boolean => charClass[c] === 1;
export const isRegular = (c: number): boolean => charClass[c] === 0;
export const isDigit = (c: number): boolean => c >= 48 && c <= 57;

export const EMPTY = new Uint8Array(0);

export function latin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i += 4096) {
    s += String.fromCharCode.apply(null, b.subarray(i, Math.min(end, i + 4096)) as unknown as number[]);
  }
  return s;
}

/** Encode a latin1 / ASCII string to bytes. */
export function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) {
    out.set(p, n);
    n += p.length;
  }
  return out;
}

/** First index of `needle` in `hay[from, to)`, or -1. */
export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0, to = hay.length): number {
  const last = to - needle.length;
  for (let i = hay.indexOf(needle[0], from); i !== -1 && i <= last; i = hay.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Last index of `needle` in `hay` starting at or before `from`, or -1. */
export function lastIndexOf(hay: Uint8Array, needle: Uint8Array, from = hay.length - needle.length): number {
  for (let i = hay.lastIndexOf(needle[0], from); i !== -1; i = i > 0 ? hay.lastIndexOf(needle[0], i - 1) : -1) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Does `b` contain `word` at `pos`, followed by a non-regular character (or the end)? */
export function keywordAt(b: Uint8Array, pos: number, word: Uint8Array): boolean {
  if (pos < 0 || pos + word.length > b.length) return false;
  for (let i = 0; i < word.length; i++) if (b[pos + i] !== word[i]) return false;
  const next = pos + word.length;
  return next >= b.length || !isRegular(b[next]);
}

export function skipWhite(b: Uint8Array, pos: number): number {
  while (pos < b.length && charClass[b[pos]] === 1) pos++;
  return pos;
}

export const KW_OBJ = /* @__PURE__ */ ascii('obj');
export const KW_ENDOBJ = /* @__PURE__ */ ascii('endobj');
export const KW_ENDSTREAM = /* @__PURE__ */ ascii('endstream');
export const KW_STARTXREF = /* @__PURE__ */ ascii('startxref');
export const KW_TRAILER = /* @__PURE__ */ ascii('trailer');
export const KW_XREF = /* @__PURE__ */ ascii('xref');
