/**
 * Fonts for rendering: which glyph each character code draws, as a browser Path2D built from the
 * embedded font program; Type 3 glyph procedures; and, for fonts that aren't embedded, a CSS font
 * the browser draws the code's text with. Code lengths and widths come from the text-extraction
 * font model (../features/fonts.ts), so both agree on spacing.
 */
import { decodeStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { isFatal } from '../core/errors.ts';
import { intOf, nameOf, numOf, PdfDict, PdfName, PdfRef, type PdfObj } from '../core/objects.ts';
import { lookup, parseCMap, type CMap } from '../features/cmap.ts';
import { loadFont, type Font } from '../features/fonts.ts';
import { baseEncoding, glyphName, glyphText, numericGlyph } from '../features/text-glyphs.ts';
import { parseCFF } from './fonts/cff.ts';
import { CLOSE, CUBIC, LINE, MOVE, QUAD, type FontProgram } from './fonts/program.ts';
import { parseTrueType } from './fonts/truetype.ts';
import { parseType1 } from './fonts/type1.ts';
import { asMatrix, type Matrix } from './util.ts';

export interface RenderFont extends Font {
  /** Maps glyph space to text space. */
  matrix: Matrix;
  /** Outline fonts: the glyph a code draws, in glyph space; null when blank or missing. */
  path?(code: number): Path2D | null;
  /** Type 3 fonts: the glyph procedure of a code, and the font's resources. */
  proc?(code: number): PdfRef | undefined;
  resources?: PdfDict;
  /**
   * Fonts that aren't embedded (or couldn't be read): a CSS font at `size` px, a code's text, and
   * the measured advances of codes' text (per px of font size).
   */
  system?: { css(size: number): string; text(code: number, n: number): string; widths: Map<number, number> };
}

const MAX_PROGRAM = 32 << 20;
const MAX_PATHS = 8192;

/** Build a Path2D from an outline. */
function toPath(o: number[]): Path2D | null {
  if (!o.length) return null;
  const p = new Path2D();
  for (let i = 0; i < o.length; ) {
    switch (o[i++]) {
      case MOVE:
        p.moveTo(o[i++], o[i++]);
        break;
      case LINE:
        p.lineTo(o[i++], o[i++]);
        break;
      case QUAD:
        p.quadraticCurveTo(o[i++], o[i++], o[i++], o[i++]);
        break;
      case CUBIC:
        p.bezierCurveTo(o[i++], o[i++], o[i++], o[i++], o[i++], o[i++]);
        break;
      case CLOSE:
        p.closePath();
        break;
      default:
        return p;
    }
  }
  return p;
}

/** CSS for a font that isn't embedded, from its name and descriptor flags. */
function systemFont(base: string, flags: number, weight: number | undefined): (size: number) => string {
  const n = base.toLowerCase();
  const family = /courier|mono|consol/.test(n)
    ? '"Courier New",Courier,monospace'
    : /symbol/.test(n)
      ? 'Symbol,serif'
      : /dingbat/.test(n)
        ? '"Zapf Dingbats",serif'
        : (/times|roman|serif|georgia|garamond|minion|book|mincho|song|ming/.test(n) && !/sans/.test(n)) || (flags & 2 && !/sans|arial|helv/.test(n))
          ? '"Times New Roman",Times,serif'
          : 'Helvetica,Arial,sans-serif';
  const bold = /bold|black|heavy|semibold|demi/.test(n) || flags & 0x40000 || (weight ?? 0) >= 600;
  const italic = /italic|oblique/.test(n) || flags & 0x40;
  return (size) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
}

/** Names of the codes of a simple font: base encoding, else the program's own, then /Differences. */
async function encodingNames(doc: PdfDocument, d: PdfDict, program: FontProgram | undefined, symbolic: boolean): Promise<(string | undefined)[]> {
  const enc = await doc.resolve(d.get('Encoding'));
  let base = nameOf(enc);
  let diffs: PdfObj | undefined;
  if (enc instanceof PdfDict) {
    base = nameOf(await doc.resolve(enc.get('BaseEncoding')));
    diffs = await doc.resolve(enc.get('Differences'));
  }
  let names: (string | undefined)[];
  if (base && /^(Standard|WinAnsi|MacRoman|MacExpert)Encoding$/.test(base)) names = baseEncoding(base).map((t) => (t ? glyphName(t) : undefined));
  else if (program?.encoding && (symbolic || !base)) names = program.encoding.slice();
  else names = baseEncoding('StandardEncoding').map((t) => (t ? glyphName(t) : undefined));
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const x of diffs) {
      const v = await doc.resolve(x);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName && code >= 0 && code < 256) names[code++] = v.name;
    }
  }
  return names;
}

/** Alternative names fonts use for the same glyph. */
const ALT: Record<string, string> = { nbspace: 'space', sfthyphen: 'hyphen', minus: 'hyphen', mu: 'uni00B5', Omega: 'uni2126', Delta: 'uni2206' };

/** Read and parse the embedded font program of a descriptor. */
async function program(doc: PdfDocument, desc: PdfDict | undefined): Promise<FontProgram | undefined> {
  if (!desc) return undefined;
  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    const ref = desc.get(key);
    if (!(ref instanceof PdfRef)) continue;
    const hdr = await doc.header(ref.num);
    const sd = hdr?.value;
    if (!hdr?.stream || !(sd instanceof PdfDict)) continue;
    const dec = await decodeStream(doc, hdr, MAX_PROGRAM);
    if (!dec || dec.codec) continue;
    const sub = nameOf(await doc.resolve(sd.get('Subtype')));
    try {
      if (key === 'FontFile') return parseType1(dec.data, intOf(await doc.resolve(sd.get('Length1'))), intOf(await doc.resolve(sd.get('Length2'))));
      if (key === 'FontFile2' || sub === 'OpenType') return parseTrueType(dec.data);
      return parseCFF(dec.data);
    } catch (e) {
      if (isFatal(e)) throw e;
    }
  }
  return undefined;
}

/** Code to CID for a composite font's /Encoding: Identity, an embedded CMap, or (for Uni* CMaps) the Unicode value itself. */
async function cidMapper(doc: PdfDocument, encObj: PdfObj | undefined): Promise<{ cid(code: number): number; unicode: boolean }> {
  const name = nameOf(await doc.resolve(encObj)) ?? '';
  let cm: CMap | undefined;
  if (encObj instanceof PdfRef) {
    const dec = await decodeStream(doc, encObj, 8 << 20);
    if (dec && !dec.codec) cm = parseCMap(dec.data);
  }
  if (cm && (cm.map.size || cm.ranges.length)) {
    const m = cm;
    return {
      unicode: false,
      cid(code) {
        const v = lookup(m, code);
        return typeof v === 'number' ? v : 0;
      },
    };
  }
  return { unicode: /^Uni.*-(UCS2|UTF16)-[HV]$/.test(name), cid: (code) => code };
}

/** Glyph index of a code in a TrueType program of a simple font (PDF 9.6.6.4, with the usual fallbacks). */
function trueTypeGid(p: FontProgram, names: (string | undefined)[], symbolic: boolean, explicitEncoding: boolean): (code: number) => number {
  const cmap = (pl: number, en: number) => p.cmaps?.find((c) => c.platform === pl && c.encoding === en);
  const unicode = cmap(3, 1) ?? cmap(0, 3) ?? cmap(0, 4) ?? cmap(0, 1);
  const sym = cmap(3, 0);
  const mac = cmap(1, 0);
  return (code) => {
    const name = names[code];
    let g = -1;
    if (unicode && name && (explicitEncoding || !symbolic || !sym)) {
      const t = glyphText(name);
      if (t && t.length <= 2) g = unicode.lookup(t.codePointAt(0)!);
    }
    if (g <= 0 && sym) for (const base of [0, 0xf000, 0xf100, 0xf200]) if ((g = sym.lookup(base + code)) > 0) break;
    if (g <= 0 && mac) g = mac.lookup(code);
    if (g <= 0 && unicode && !name) g = unicode.lookup(code);
    if (g <= 0 && name) g = p.gidForName(name);
    if (g <= 0 && name) {
      const n = numericGlyph(name);
      if (n !== undefined) g = n;
    }
    if (g <= 0 && !p.cmaps?.length) g = code;
    return g;
  };
}

/** Load a font for rendering. Never throws on damage: falls back to a system font. */
export async function loadRenderFont(doc: PdfDocument, o: PdfObj | undefined): Promise<RenderFont> {
  const base = await loadFont(doc, o);
  const d = await doc.resolve(o);
  const fallback = (name = '', flags = 0, weight?: number): RenderFont => ({
    ...base,
    matrix: [0.001, 0, 0, 0.001, 0, 0],
    system: { css: systemFont(name, flags, weight), text: base.text, widths: new Map() },
  });
  if (!(d instanceof PdfDict)) return fallback();
  try {
    const r = (x: PdfObj | undefined) => doc.resolve(x);
    const sub = nameOf(await r(d.get('Subtype')));
    if (sub === 'Type3') {
      const procs = await r(d.get('CharProcs'));
      const res = await r(d.get('Resources'));
      const names = await encodingNames(doc, d, undefined, false);
      const fm = await r(d.get('FontMatrix'));
      return {
        ...base,
        matrix: (Array.isArray(fm) && asMatrix(await Promise.all(fm.map(r)))) || [0.001, 0, 0, 0.001, 0, 0],
        resources: res instanceof PdfDict ? res : undefined,
        proc(code) {
          const n = names[code];
          const ref = n && procs instanceof PdfDict ? procs.get(n) : undefined;
          return ref instanceof PdfRef ? ref : undefined;
        },
      };
    }
    let fd: PdfDict = d;
    let cidSub: string | undefined;
    if (sub === 'Type0') {
      const df = await r(d.get('DescendantFonts'));
      const cf = await r(Array.isArray(df) ? df[0] : df);
      if (!(cf instanceof PdfDict)) return fallback(nameOf(await r(d.get('BaseFont'))));
      fd = cf;
      cidSub = nameOf(await r(cf.get('Subtype')));
    }
    const baseFont = (nameOf(await r(d.get('BaseFont'))) ?? '').replace(/^[A-Z]{6}\+/, '');
    const descObj = await r(fd.get('FontDescriptor'));
    const desc = descObj instanceof PdfDict ? descObj : undefined;
    const flags = intOf(await r(desc?.get('Flags'))) ?? 0;
    const prog = await program(doc, desc);
    if (!prog) return fallback(baseFont, flags, numOf(await r(desc?.get('FontWeight'))));

    let gid: (code: number) => number;
    if (sub === 'Type0') {
      const enc = await cidMapper(doc, d.get('Encoding'));
      let cidToGid: Uint8Array | undefined;
      const c2g = fd.get('CIDToGIDMap');
      if (c2g instanceof PdfRef) {
        const dec = await decodeStream(doc, c2g, 1 << 22);
        if (dec && !dec.codec) cidToGid = dec.data;
      }
      const uni = enc.unicode ? (prog.cmaps?.find((c) => c.platform === 3 && c.encoding === 1) ?? prog.cmaps?.find((c) => c.platform === 0)) : undefined;
      gid = (code) => {
        if (uni) return uni.lookup(code);
        const cid = enc.cid(code);
        if (cidSub === 'CIDFontType2' || prog.kind === 'truetype') {
          if (cidToGid && 2 * cid + 1 < cidToGid.length) return (cidToGid[2 * cid] << 8) | cidToGid[2 * cid + 1];
          return cid;
        }
        return prog.gidForCid ? prog.gidForCid(cid) : cid;
      };
    } else {
      const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
      const names = await encodingNames(doc, d, prog, symbolic);
      if (prog.kind === 'truetype') gid = trueTypeGid(prog, names, symbolic, d.get('Encoding') !== undefined);
      else {
        gid = (code) => {
          const n = names[code];
          let g = n ? prog.gidForName(n) : -1;
          if (g < 0 && n && ALT[n]) g = prog.gidForName(ALT[n]);
          if (g < 0 && prog.encoding?.[code]) g = prog.gidForName(prog.encoding[code]!);
          return g;
        };
      }
    }
    const paths = new Map<number, Path2D | null>();
    return {
      ...base,
      matrix: prog.matrix,
      path(code) {
        const g = gid(code);
        if (g < 0 || g >= prog.glyphCount) return null;
        let p = paths.get(g);
        if (p === undefined) {
          p = toPath(prog.outline(g));
          if (paths.size >= MAX_PATHS) paths.clear();
          paths.set(g, p);
        }
        return p;
      },
    };
  } catch (e) {
    if (isFatal(e)) throw e;
    return fallback();
  }
}
