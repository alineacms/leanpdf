import { PdfName, PdfString, type PdfObj } from './objects.ts';

const hexVal = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

/** The bytes a string object stands for: literal escapes resolved, or hex decoded. */
export function stringBytes(s: PdfString): Uint8Array {
  const r = s.raw;
  const out: number[] = [];
  if (r[0] === 0x3c) {
    let hi = -1;
    for (let i = 1; i < r.length; i++) {
      const v = hexVal(r[i]);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return Uint8Array.from(out);
  }
  const end = r[r.length - 1] === 0x29 ? r.length - 1 : r.length;
  for (let i = 1; i < end; i++) {
    let c = r[i];
    if (c === 0x0d) {
      // Bare CR or CRLF inside a literal means LF.
      if (r[i + 1] === 0x0a) i++;
      out.push(0x0a);
      continue;
    }
    if (c !== 0x5c) {
      out.push(c);
      continue;
    }
    c = r[++i];
    if (c >= 0x30 && c <= 0x37) {
      let v = c - 0x30;
      for (let k = 0; k < 2 && r[i + 1] >= 0x30 && r[i + 1] <= 0x37; k++) v = v * 8 + r[++i] - 0x30;
      out.push(v & 255);
    } else if (c === 0x0d) {
      if (r[i + 1] === 0x0a) i++; // line continuation
    } else if (c !== 0x0a && i < end) {
      out.push({ 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }[c] ?? c);
    }
  }
  return Uint8Array.from(out);
}

/** PDFDocEncoding code points for 0x18-0x1f and 0x80-0xad (the rest is latin1). */
const PDFDOC_LOW = [0x2d8, 0x2c7, 0x2c6, 0x2d9, 0x2dd, 0x2db, 0x2da, 0x2dc];
const PDFDOC_HIGH = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018,
  0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x141, 0x152, 0x160, 0x178, 0x17d, 0x131, 0x142, 0x153, 0x161, 0x17e, 0xfffd, 0x20ac,
];

/** Decode text-string bytes: UTF-16BE or UTF-8 with a byte order mark, else PDFDocEncoding. */
export function decodeText(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  let s = '';
  for (const c of b) {
    s += String.fromCharCode(c >= 0x18 && c <= 0x1f ? PDFDOC_LOW[c - 0x18] : c >= 0x80 && c <= 0xa0 ? PDFDOC_HIGH[c - 0x80] : c);
  }
  return s;
}

/** A text string (or name) as a JS string, or undefined. */
export function textOf(o: PdfObj | undefined): string | undefined {
  if (o instanceof PdfString) return decodeText(stringBytes(o));
  if (o instanceof PdfName) return o.name;
  return undefined;
}

/** Serialize a JS string as a PDF text string: literal when plain ASCII, else hex UTF-16BE. */
export function encodeText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, '\\$&')})`;
  let hex = '<FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return hex + '>';
}
