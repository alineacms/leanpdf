/**
 * Plain-text extraction for search indexing: one page at a time, words and lines in content
 * stream order. Not a layout engine: spaces are inserted where glyphs are visibly apart, newlines
 * where the baseline moves.
 */
import { pageContent, readArray, readDict, readInlineImage, type Operand } from '../core/content.ts';
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { isFatal, PdfEncryptedError } from '../core/errors.ts';
import { Lexer, T_AOPEN, T_DOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR } from '../core/lexer.ts';
import { nameOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import { walkPages, type PageNode } from '../core/pages.ts';
import { stringBytes, textOf } from '../core/strings.ts';
import { clean, fallbackFont, loadFont, type Font } from './fonts.ts';

export interface PageText {
  /** 0-based page index. */
  pageIndex: number;
  /** The page's text: words separated by single spaces, lines by newlines. */
  text: string;
}

export interface TextOptions {
  /** 0-based indexes of the pages to extract (yielded in document order). Default: all pages. */
  pages?: number[];
  signal?: AbortSignal;
}

/** Decoded content bytes per page, Form XObjects included. */
const MAX_CONTENT = 64 << 20;
/** Tokens interpreted per page (a glyph counts as one too, a Form XObject invocation as 64). */
const MAX_TOKENS = 10_000_000;
/** Characters of text per page. */
const MAX_TEXT = 4 << 20;
const MAX_FORM_DEPTH = 12;
const FORM_CACHE_BYTES = 8 << 20;
const FONT_CACHE = 64;

type Matrix = number[];
type FontCache = Map<number, Promise<Font>>;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Six finite numbers, or undefined. */
const matrix = (a: unknown[]): Matrix | undefined =>
  a.length === 6 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (a as Matrix) : undefined;

interface GState {
  ctm: Matrix;
  font: Font;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

/** Text state operators and the GState field they set. */
const TEXT_STATE: Record<string, keyof GState> = { Tc: 'tc', Tw: 'tw', Tz: 'th', TL: 'tl', Ts: 'rise' };

interface Form {
  hdr: ObjHeader;
  data?: Uint8Array;
  matrix?: Matrix;
  res?: PdfDict;
}

/** An open marked-content sequence carrying /ActualText. */
interface Marked {
  text: string;
  done: boolean;
}

/**
 * Extract plain text for search indexing, one page at a time: only one page's content streams
 * (plus a bounded cache of fonts) are held in memory. Words are separated by single spaces and
 * lines by newlines, in content stream order: spaces come from space glyphs or visible gaps between
 * glyphs (TJ offsets, separate placements), newlines from baseline changes. Glyphs without a known
 * Unicode mapping are left out rather than guessed. /ActualText replaces the glyphs it covers.
 * Form XObjects are followed; annotations are not.
 *
 * Throws PdfEncryptedError for encrypted documents. Damaged content yields whatever text could be
 * read around the damage; the work per page is bounded.
 */
export async function* extractText(doc: PdfDocument, opts: TextOptions = {}): AsyncGenerator<PageText> {
  if (doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
  const want = opts.pages && new Set(opts.pages);
  let last = -1;
  for (const p of want ?? []) last = Math.max(last, p);
  const fonts: FontCache = new Map();
  for await (const page of walkPages(doc)) {
    if (want && page.index > last) break;
    if (want && !want.has(page.index)) continue;
    opts.signal?.throwIfAborted();
    yield { pageIndex: page.index, text: await pageText(doc, page, fonts, opts.signal) };
  }
}

/** The text of the whole document (or of `opts.pages`), pages separated by form feeds. */
export async function extractAllText(doc: PdfDocument, opts: TextOptions = {}): Promise<string> {
  const pages: string[] = [];
  for await (const p of extractText(doc, opts)) pages.push(p.text);
  return pages.join('\f');
}

/** Interpret one page's content and return its text. */
async function pageText(doc: PdfDocument, page: PageNode, fonts: FontCache, signal: AbortSignal | undefined): Promise<string> {
  let out = '';
  /** Last character written ('\n' at the start). */
  let tail = '\n';
  /** Separator owed before the next text: 0 none, 1 space, 2 newline. */
  let pending = 0;
  // End of the previous glyph in user space, the unit writing direction there, and em sizes.
  let has = false;
  let px = 0;
  let py = 0;
  let ux = 1;
  let uy = 0;
  let alongEm = 0;
  // Origin and text of the previous glyph, to drop glyphs overprinted for a fake bold effect.
  let ox = 0;
  let oy = 0;
  let prev = '';
  let gs: GState = { ctm: IDENTITY, font: fallbackFont(), fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let stack: GState[] = [];
  let skippedQ = 0;
  let tm = IDENTITY.slice();
  let tlm = IDENTITY.slice();
  let budget = MAX_CONTENT;
  let tokens = 0;
  let check = 0;
  let formBytes = 0;
  const forms = new Map<number, Form | null>();
  const scopes = new Map<PdfDict | undefined, Map<string, Font>>();
  const xobjects = new Map<PdfDict | undefined, PdfObj | undefined>();
  const active = new Set<number>();
  const marked: (Marked | null)[] = [];
  let actual: Marked | null = null;

  const sep = (k: number): void => {
    if (k > pending) pending = k;
  };

  /** Write text, honouring the pending separator; whitespace only requests a separator. */
  const put = (t: string): void => {
    if (actual) {
      if (actual.done) return;
      actual.done = true;
      t = actual.text;
    }
    if (t[0] === ' ') sep(1);
    const body = t.trim();
    if (body) {
      const s = (pending === 2 && tail !== '\n' ? '\n' : pending && tail !== '\n' && tail !== ' ' ? ' ' : '') + body.replace(/ +/g, ' ');
      pending = 0;
      out += s;
      tail = s[s.length - 1];
    }
    if (t.length > 1 && t[t.length - 1] === ' ') sep(1);
  };

  /** Td: translate the line matrix. */
  const move = (tx: number, ty: number): void => {
    tlm[4] += tx * tlm[0] + ty * tlm[2];
    tlm[5] += tx * tlm[1] + ty * tlm[3];
    tm = tlm.slice();
  };

  /** Displace the text matrix along the writing direction (glyph advance, TJ adjustment). */
  const shift = (d: number): void => {
    const v = gs.font.vertical;
    tm[4] += d * (v ? tm[2] : tm[0]);
    tm[5] += d * (v ? tm[3] : tm[1]);
  };

  /** Place one glyph: decide on a separator from its position, then write its text. */
  const glyph = (t: string, adv: number): void => {
    const c = gs.ctm;
    const vert = gs.font.vertical;
    const a = tm[0] * c[0] + tm[1] * c[2];
    const b = tm[0] * c[1] + tm[1] * c[3];
    const cc = tm[2] * c[0] + tm[3] * c[2];
    const d = tm[2] * c[1] + tm[3] * c[3];
    const x = tm[4] * c[0] + tm[5] * c[2] + c[4] + gs.rise * cc;
    const y = tm[4] * c[1] + tm[5] * c[3] + c[5] + gs.rise * d;
    const fs = Math.abs(gs.fs);
    const h = Math.hypot(a, b) * fs * Math.abs(gs.th);
    const v = Math.hypot(cc, d) * fs;
    const s = Math.sign(gs.fs * (vert ? -1 : gs.th)) || 1;
    const dx = (vert ? cc : a) * s;
    const dy = (vert ? d : b) * s;
    const len = Math.hypot(dx, dy);
    if (!(len > 0) || !Number.isFinite(x + y + h + v)) {
      has = false;
      sep(1);
      put(t);
      return;
    }
    const along = vert ? v : h;
    const perp = vert ? h : v;
    // The same glyph drawn again at (nearly) the same place, not where the previous one ended: an
    // overprint for a fake bold effect. Keep one.
    const near = (u: number, w: number) => Math.abs(x - u) + Math.abs(y - w) <= 0.1 * along;
    if (!has || t !== prev || !near(ox, oy) || near(px, py)) {
      if (has) {
        const ex = x - px;
        const ey = y - py;
        // A new line when the direction turns or the baseline moves (superscripts stay on the line).
        if ((dx * ux + dy * uy) / len < 0.9 || Math.abs(ey * ux - ex * uy) > 0.8 * perp) sep(2);
        else if (Math.abs(ex * ux + ey * uy) > 0.15 * Math.min(along, alongEm)) sep(1);
      }
      put(t);
    }
    has = true;
    ox = x;
    oy = y;
    prev = t;
    px = x + (vert ? cc : a) * adv;
    py = y + (vert ? d : b) * adv;
    ux = dx / len;
    uy = dy / len;
    alongEm = along;
  };

  const show = (raw: Uint8Array): void => {
    const b = stringBytes(new PdfString(raw));
    const f = gs.font;
    for (let i = 0; i < b.length && ++tokens < MAX_TOKENS && out.length < MAX_TEXT; ) {
      const n = Math.max(1, Math.min(f.len(b, i), b.length - i));
      let code = 0;
      for (let k = 0; k < n; k++) code = code * 256 + b[i + k];
      i += n;
      const w = f.width(code) * gs.fs + gs.tc + (n === 1 && code === 32 ? gs.tw : 0);
      const adv = f.vertical ? w : w * gs.th;
      glyph(f.text(code, n), adv);
      shift(adv);
    }
  };

  const setFont = async (name: string, res: PdfDict | undefined, scope: Map<string, Font>): Promise<void> => {
    const dict = await doc.resolve(res?.get('Font'));
    const ref = dict instanceof PdfDict ? dict.get(name) : undefined;
    // Fonts are shared across pages by object number; direct ones are cached per resource scope.
    const num = ref instanceof PdfRef ? ref.num : -1;
    let p = fonts.get(num);
    if (!p) {
      p = loadFont(doc, ref);
      if (num >= 0) {
        if (fonts.size >= FONT_CACHE) fonts.delete(fonts.keys().next().value!);
        fonts.set(num, p);
      }
    }
    const f = await p;
    scope.set(name, f);
    gs.font = f;
  };

  /** BMC/BDC: an /ActualText (inline or from /Properties) replaces the glyphs up to EMC. */
  const beginMarked = async (props: Operand, res: PdfDict | undefined): Promise<void> => {
    let entry: Marked | null = null;
    if (!actual && props) {
      let d: PdfObj | undefined = props instanceof PdfDict ? props : undefined;
      if (props instanceof PdfName) {
        const all = await doc.resolve(res?.get('Properties'));
        d = all instanceof PdfDict ? await doc.resolve(all.get(props.name)) : undefined;
      }
      const text = d instanceof PdfDict ? textOf(await doc.resolve(d.get('ActualText'))) : undefined;
      if (text !== undefined) actual = entry = { text: clean(text), done: false };
    }
    if (marked.length < 4096) marked.push(entry);
  };

  /** Do: recurse into a Form XObject with its own matrix and resources. */
  const xobject = async (name: string, res: PdfDict | undefined, depth: number): Promise<void> => {
    tokens += 64;
    if (depth >= MAX_FORM_DEPTH) return;
    let all = xobjects.get(res);
    if (!xobjects.has(res)) xobjects.set(res, (all = await doc.resolve(res?.get('XObject'))));
    const ref = all instanceof PdfDict ? all.get(name) : undefined;
    if (!(ref instanceof PdfRef) || active.has(ref.num)) return;
    let f = forms.get(ref.num);
    if (f === undefined) {
      f = null;
      const hdr = await doc.header(ref.num);
      const d = hdr?.value;
      if (hdr?.stream && d instanceof PdfDict && nameOf(await doc.resolve(d.get('Subtype'))) === 'Form') {
        const m = await doc.resolve(d.get('Matrix'));
        const r = await doc.resolve(d.get('Resources'));
        f = {
          hdr,
          matrix: Array.isArray(m) ? matrix(await Promise.all(m.map((x) => doc.resolve(x)))) : undefined,
          res: r instanceof PdfDict ? r : undefined,
        };
      }
      forms.set(ref.num, f);
    }
    if (!f) return;
    const data = f.data ?? (await readStream(doc, f.hdr, budget));
    if (!data) return;
    if (!f.data) {
      budget -= data.length;
      if (formBytes + data.length <= FORM_CACHE_BYTES) {
        f.data = data;
        formBytes += data.length;
      }
    }
    const saved = [gs, tm, tlm, stack] as const;
    gs = { ...gs, ctm: f.matrix ? mul(f.matrix, gs.ctm) : gs.ctm };
    stack = [];
    active.add(ref.num);
    try {
      await run(data, f.res ?? res, depth + 1);
    } finally {
      active.delete(ref.num);
      [gs, tm, tlm, stack] = saved;
    }
  };

  /** Interpret a content stream with the given resources. */
  const run = async (data: Uint8Array, res: PdfDict | undefined, depth: number): Promise<void> => {
    const lex = new Lexer(data, 0, true);
    const ops: Operand[] = [];
    let scope = scopes.get(res);
    if (!scope) scopes.set(res, (scope = new Map()));
    for (;;) {
      if (++tokens > MAX_TOKENS || out.length > MAX_TEXT) return;
      if (tokens > check) {
        check = tokens + 0xffff;
        signal?.throwIfAborted();
      }
      const t = lex.next();
      if (t.t === T_EOF) return;
      if (t.t !== T_KW) {
        if (ops.length >= 64) ops.shift();
        if (t.t === T_NUM || t.t === T_STR) ops.push(t.v as number | Uint8Array);
        else if (t.t === T_NAME) ops.push(new PdfName(t.v as string));
        else if (t.t === T_AOPEN) {
          const arr = readArray(lex, 0);
          tokens += arr.length;
          ops.push(arr);
        } else if (t.t === T_DOPEN) ops.push(readDict(lex, t.s));
        continue;
      }
      const k = t.v as string;
      const n = ops.length;
      const num = (i: number): number => {
        const v = ops[n - i];
        return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
      };
      const last = ops[n - 1];
      const str = last instanceof Uint8Array ? last : undefined;
      switch (k) {
        case 'BT':
          tm = IDENTITY.slice();
          tlm = IDENTITY.slice();
          break;
        case 'Tf': {
          const name = ops[n - 2];
          if (!Number.isNaN(num(1))) gs.fs = num(1);
          if (name instanceof PdfName) {
            const f = scope.get(name.name);
            if (f) gs.font = f;
            else await setFont(name.name, res, scope);
          }
          break;
        }
        case 'TD':
        case 'Td':
          if (Number.isNaN(num(1) + num(2))) break;
          if (k === 'TD') gs.tl = -num(1);
          move(num(2), num(1));
          break;
        case 'Tm': {
          const m = matrix(ops.slice(-6));
          if (m) tm = (tlm = m).slice();
          break;
        }
        case '"':
        case "'":
        case 'T*':
          if (k === '"' && !Number.isNaN(num(3) + num(2))) {
            gs.tw = num(3);
            gs.tc = num(2);
          }
          move(0, -gs.tl);
          if (k !== 'T*' && str) show(str);
          break;
        case 'Tj':
          if (str) show(str);
          break;
        case 'TJ':
          if (Array.isArray(last)) {
            for (const x of last) {
              if (x instanceof Uint8Array) show(x);
              else if (typeof x === 'number' && Number.isFinite(x)) shift((-x / 1000) * gs.fs * (gs.font.vertical ? 1 : gs.th));
            }
          }
          break;
        case 'q':
          if (stack.length < 1024) stack.push({ ...gs });
          else skippedQ++;
          break;
        case 'Q':
          if (skippedQ) skippedQ--;
          else gs = stack.pop() ?? gs;
          break;
        case 'cm': {
          const m = matrix(ops.slice(-6));
          if (m) gs.ctm = mul(m, gs.ctm);
          break;
        }
        case 'Do':
          if (last instanceof PdfName) await xobject(last.name, res, depth);
          break;
        case 'BI':
          readInlineImage(lex);
          break;
        case 'BMC':
        case 'BDC':
          await beginMarked(k === 'BDC' ? last : null, res);
          break;
        case 'EMC': {
          const m = marked.pop();
          if (m && m === actual) {
            actual = null;
            if (!m.done) {
              sep(1);
              put(m.text);
              sep(1);
            }
          }
          break;
        }
        default: {
          const key = k.length === 2 && TEXT_STATE[k];
          if (key && !Number.isNaN(num(1))) (gs[key] as number) = k === 'Tz' ? num(1) / 100 : num(1);
        }
      }
      ops.length = 0;
    }
  };

  try {
    await run(await pageContent(doc, page.dict.get('Contents'), MAX_CONTENT), page.resources, 0);
  } catch (e) {
    if (isFatal(e)) throw e;
  }
  return out;
}
