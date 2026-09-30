/**
 * Fonts as text extraction sees them: how to split a shown string into character codes, the
 * Unicode text of each code, and each code's advance width. Simple fonts (Type1, TrueType,
 * MMType1, Type3) and composite Type0 fonts; no font programs are parsed, except the cleartext
 * encoding vector of embedded Type1 fonts.
 */
import { latin1 } from '../core/bytes.ts';
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { isFatal } from '../core/errors.ts';
import { intOf, nameOf, numOf, PdfDict, PdfName, PdfRef, type PdfObj } from '../core/objects.ts';
import { codeLength, lookup, parseCMap, type CMap } from './cmap.ts';
import { baseEncoding, glyphText, numericGlyph, standardWidths } from './text-glyphs.ts';

export interface Font {
  /** Byte length of the character code starting at b[i] (at least 1). */
  len(b: Uint8Array, i: number): number;
  /** Text of a code of `n` bytes, cleaned for indexing ('' when unknown). */
  text(code: number, n: number): string;
  /** Advance per unit of font size: w0 for horizontal fonts, w1 (negative is downwards) for vertical ones. */
  width(code: number): number;
  vertical: boolean;
}

const BASES = ['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding', 'MacExpertEncoding'];
const MAX_CMAP = 8 << 20;

/**
 * Text cleanup for indexing: whitespace becomes a plain space; controls, private-use and
 * replacement characters are dropped; fi/fl/ff... ligatures are expanded.
 */
export const clean = (s: string): string =>
  s
    .replace(/\s/g, ' ')
    .replace(/[\0-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufffd\ue000-\uf8ff]|[\udb80-\udbff][\udc00-\udfff]/g, '')
    .replace(/[\ufb00-\ufb06]/g, (c) => c.normalize('NFKC'));

let fallback: Font | undefined;

/** Font used when Tf names no usable font: StandardEncoding with Helvetica metrics. */
export function fallbackFont(): Font {
  if (!fallback) {
    const uni = baseEncoding('StandardEncoding');
    const w = standardWidths('Helvetica');
    fallback = simple(uni.map(clean), uni.map((u) => w(u) / 1000));
  }
  return fallback;
}

function simple(uni: string[], widths: number[]): Font {
  return { len: () => 1, text: (c) => uni[c] ?? '', width: (c) => widths[c] ?? 0, vertical: false };
}

/** Load a font dictionary. Never throws on damage: falls back to what can be salvaged. */
export async function loadFont(doc: PdfDocument, o: PdfObj | undefined): Promise<Font> {
  try {
    const d = await doc.resolve(o);
    if (!(d instanceof PdfDict)) return fallbackFont();
    return nameOf(await doc.resolve(d.get('Subtype'))) === 'Type0' ? await compositeFont(doc, d) : await simpleFont(doc, d);
  } catch (e) {
    if (isFatal(e)) throw e;
    return fallbackFont();
  }
}

/** ToUnicode: a parsed CMap, 'identity' for /Identity-H (code = UTF-16 unit), or undefined. */
async function toUnicode(doc: PdfDocument, o: PdfObj | undefined): Promise<CMap | 'identity' | undefined> {
  const data = o instanceof PdfRef ? await readStream(doc, o, MAX_CMAP) : null;
  if (!data) return /^Identity/.test(nameOf(await doc.resolve(o)) ?? '') ? 'identity' : undefined;
  const cm = parseCMap(data);
  return cm.map.size || cm.ranges.length ? cm : undefined;
}

const unicodeOf = (tu: CMap | 'identity' | undefined, code: number): string | undefined => {
  if (tu === 'identity') return String.fromCharCode(code);
  const t = tu && lookup(tu, code);
  return typeof t === 'string' ? t : undefined;
};

/** Glyph names of the built-in encoding of an embedded Type1 font program (cleartext part). */
async function type1Encoding(doc: PdfDocument, ff: PdfObj | undefined): Promise<string[] | undefined> {
  if (!(ff instanceof PdfRef)) return undefined;
  const hdr = await doc.header(ff.num);
  if (!hdr?.stream) return undefined;
  const len1 = intOf(await doc.resolve((hdr.value as PdfDict).get('Length1')));
  const data = await readStream(doc, hdr, 4 << 20);
  if (!data) return undefined;
  const s = latin1(data, 0, Math.min(data.length, len1 && len1 > 0 ? len1 : 1 << 16, 1 << 17));
  const names: string[] = [];
  for (const m of s.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>%]+)\s+put/g)) if (+m[1] < 256) names[+m[1]] = m[2];
  return names.length ? names : undefined;
}

async function simpleFont(doc: PdfDocument, d: PdfDict): Promise<Font> {
  const r = (o: PdfObj | undefined) => doc.resolve(o);
  const sub = nameOf(await r(d.get('Subtype')));
  const baseFont = (nameOf(await r(d.get('BaseFont'))) ?? '').replace(/^[A-Z]{6}\+/, '');
  const fd = await r(d.get('FontDescriptor'));
  const desc = fd instanceof PdfDict ? fd : undefined;
  const enc = await r(d.get('Encoding'));
  let base = nameOf(enc);
  let diffs: PdfObj | undefined;
  if (enc instanceof PdfDict) {
    base = nameOf(await r(enc.get('BaseEncoding')));
    diffs = await r(enc.get('Differences'));
  }
  const tu = await toUnicode(doc, d.get('ToUnicode'));
  const lname = baseFont.toLowerCase();
  let uni: string[];
  if (base && BASES.includes(base)) uni = baseEncoding(base);
  else {
    // The font's built-in encoding.
    const builtin = /symbol/.test(lname) ? 'Symbol' : /dingbat|wingding|webding|marlett/.test(lname) ? 'ZapfDingbats' : '';
    const names = !builtin && !tu && sub !== 'TrueType' && desc ? await type1Encoding(doc, desc.get('FontFile')) : undefined;
    uni = baseEncoding(builtin || 'StandardEncoding');
    if (names) uni = Array.from({ length: 256 }, (_, c) => (names[c] ? (glyphText(names[c]) ?? '') : ''));
  }
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const x of diffs) {
      const v = await doc.resolve(x);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName) {
        if (code >= 0 && code < 256) uni[code] = glyphText(v.name) ?? (numericGlyph(v.name) === code ? uni[code] : '');
        code++;
      }
    }
  }
  if (tu) {
    for (let c = 0; c < 256; c++) {
      const t = unicodeOf(tu, c);
      if (t !== undefined) uni[c] = t;
    }
  }
  uni = uni.map(clean);
  // Widths, in text space units per unit of font size.
  let scale = 0.001;
  if (sub === 'Type3') {
    const fm = await r(d.get('FontMatrix'));
    const a = Array.isArray(fm) ? numOf(await doc.resolve(fm[0])) : undefined;
    if (a) scale = a;
  }
  const first = intOf(await r(d.get('FirstChar'))) ?? 0;
  const wa = await r(d.get('Widths'));
  const missing = numOf(await r(desc?.get('MissingWidth'))) ?? 0;
  const std = Array.isArray(wa) ? undefined : standardWidths(baseFont);
  const widths: number[] = [];
  for (let c = 0; c < 256; c++) {
    const i = c - first;
    const w = std ? std(uni[c]) : Array.isArray(wa) && i >= 0 && i < wa.length ? numOf(await doc.resolve(wa[i])) : missing;
    widths.push((w ?? missing) * scale);
  }
  return simple(uni, widths);
}

/** Legacy CJK CMaps: the text decoder label and the lead-byte test of their two-byte codes. */
function legacy(name: string): [string, (c: number) => boolean] | undefined {
  const lead = (c: number) => c >= 0x81 && c <= 0xfe;
  if (/RKSJ/.test(name)) return ['shift_jis', (c) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)];
  if (/^GB/.test(name)) return ['gbk', lead];
  if (/^(B5|ETen|HKscs)/.test(name)) return ['big5', lead];
  if (/^KSC/.test(name)) return ['euc-kr', lead];
  if (/^EUC/.test(name)) return ['euc-jp', (c) => c >= 0x8e && c <= 0xfe];
  return undefined;
}

async function compositeFont(doc: PdfDocument, d: PdfDict): Promise<Font> {
  const r = (o: PdfObj | undefined) => doc.resolve(o);
  const encObj = d.get('Encoding');
  let encName = nameOf(await r(encObj)) ?? '';
  let enc: CMap | undefined;
  if (encObj instanceof PdfRef) {
    const data = await readStream(doc, encObj, MAX_CMAP);
    if (data) {
      enc = parseCMap(data);
      const hdr = await doc.header(encObj.num);
      encName = enc.use ?? nameOf(await r((hdr?.value as PdfDict | undefined)?.get('UseCMap'))) ?? '';
      if (!enc.space.length && !enc.map.size && !enc.ranges.length) enc = undefined;
    }
  }
  const df = await r(d.get('DescendantFonts'));
  const cf = await r(Array.isArray(df) ? df[0] : df);
  const cid = cf instanceof PdfDict ? cf : new PdfDict();
  const dw = numOf(await r(cid.get('DW'))) ?? 1000;
  const dw2 = await r(cid.get('DW2'));
  const w1 = (Array.isArray(dw2) ? numOf(await doc.resolve(dw2[1])) : undefined) ?? -1000;
  const wmap = new Map<number, number>();
  const wranges: number[][] = [];
  const W = await r(cid.get('W'));
  if (Array.isArray(W)) {
    for (let i = 0; i + 1 < W.length; ) {
      const c = numOf(await doc.resolve(W[i]));
      const next = await doc.resolve(W[i + 1]);
      if (Array.isArray(next)) {
        if (c !== undefined) for (let k = 0; k < next.length; k++) wmap.set(c + k, numOf(await doc.resolve(next[k])) ?? dw);
        i += 2;
      } else {
        const c2 = numOf(next);
        const w = numOf(await doc.resolve(W[i + 2]));
        if (c !== undefined && c2 !== undefined && w !== undefined) wranges.push([c, c2, w]);
        i += 3;
      }
    }
  }
  const tu = await toUnicode(doc, d.get('ToUnicode'));
  const uniEnc = /^Uni\w+-(UCS2|UTF16|UTF32)-[HV]$/.exec(encName)?.[1];
  const identity = !enc && /^Identity-[HV]$/.test(encName);
  const old = enc || identity || uniEnc ? undefined : legacy(encName);
  let decoder: TextDecoder | undefined;
  try {
    if (old) decoder = new TextDecoder(old[0]);
  } catch {
    // Encoding not available in this runtime: no text, but codes still split correctly.
  }
  const space = enc?.space.length ? enc : typeof tu === 'object' && tu.space.length ? tu : undefined;
  const len = (b: Uint8Array, i: number): number => {
    if (enc?.space.length) return codeLength(enc, b, i) || enc.space[0].n;
    if (uniEnc === 'UTF32') return 4;
    if (uniEnc === 'UTF16' && b[i] >= 0xd8 && b[i] <= 0xdb) return 4;
    if (uniEnc || identity) return 2;
    if (old) return old[1](b[i]) ? 2 : 1;
    return space ? codeLength(space, b, i) || space.space[0].n : 2;
  };
  const cidOf = (code: number): number | undefined => {
    if (identity || (!enc && !uniEnc && !old)) return code;
    const v = enc && lookup(enc, code);
    return typeof v === 'number' ? v : undefined;
  };
  const memo = new Map<number, string>();
  const vertical = /-V$/.test(encName) || !!enc?.vertical;
  return {
    len,
    vertical,
    text(code, n) {
      const key = code * 8 + n;
      let t = memo.get(key);
      if (t !== undefined) return t;
      t = unicodeOf(tu, code);
      if (t === undefined && uniEnc) {
        t = uniEnc === 'UTF32' ? (code <= 0x10ffff ? String.fromCodePoint(code) : '') : n === 4 ? String.fromCharCode(code >>> 16, code & 0xffff) : String.fromCharCode(code);
      }
      if (t === undefined && decoder) t = decoder.decode(Uint8Array.from(n === 2 ? [code >> 8, code & 255] : [code]));
      t = clean(t ?? '');
      if (memo.size < 1 << 16) memo.set(key, t);
      return t;
    },
    width(code) {
      if (vertical) return w1 / 1000;
      const c = cidOf(code);
      let w = c === undefined ? undefined : wmap.get(c);
      if (w === undefined && c !== undefined) for (const [a, b, x] of wranges) if (c >= a && c <= b) w = x;
      return (w ?? dw) / 1000;
    },
  };
}
