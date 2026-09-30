import type { PdfDocument } from '../core/document.ts';
import { intOf, nameOf, numOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { walkPages } from '../core/pages.ts';
import { arrayOf, catalogOf, dictOf, textAt, walkTree } from './names.ts';
import { walkFields } from './forms.ts';

/** Document-level facts. Text fields come from the Info dictionary, else from XMP metadata. */
export interface DocumentInfo {
  /** PDF version: the header's, or the catalog's /Version when that is later. */
  version: string;
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modDate?: Date;
  /** Other text entries of the Info dictionary (custom properties, /Trapped), by key. */
  custom: Record<string, string>;
  /** Natural language of the document (/Lang), e.g. 'en-US'. */
  language?: string;
  /** Raw XMP metadata packet: the catalog's /Metadata stream (unfiltered or Flate) as text. */
  metadata?: string;
  /**
   * The document is encrypted. Text fields and metadata are then left out (they are encrypted
   * too); structural facts are still reported.
   */
  encrypted: boolean;
  /** Tagged PDF (/MarkInfo /Marked true). */
  tagged: boolean;
  /** Has an interactive form (AcroForm fields or XFA). */
  hasForms: boolean;
  /** Has document-level JavaScript (/Names /JavaScript, or a JavaScript open or catalog action). */
  hasJavaScript: boolean;
  /** Carries a digital signature (/SigFlags, or a signed signature field). */
  signed: boolean;
  /** Number of document-level attachments (/Names /EmbeddedFiles entries). */
  attachments: number;
  /** The cross-reference data was damaged and had to be rebuilt. */
  repaired: boolean;
  /** Notes about anything unusual found while opening. */
  warnings: string[];
}

/** Size and orientation of one page. */
export interface PageInfo {
  /** Width of the visible area (crop box within the media box), unrotated, in points. */
  width: number;
  height: number;
  /** Clockwise rotation when displayed: 0, 90, 180 or 270. */
  rotate: number;
  /** Page label (/PageLabels), e.g. 'iv' or 'A-3'. Absent without labels or when encrypted. */
  label?: string;
}

/**
 * Parse a PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`). Truncated forms default the missing fields
 * (month and day to 1, the rest to 0, no offset to UTC); ISO 8601 (as in XMP) is accepted too.
 * Returns undefined for anything that isn't a valid date.
 */
export function parsePdfDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const iso = /^\s*\d{4}-\d\d(?:-\d\d)?(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?\s*$/.test(s);
  if (iso) {
    const t = Date.parse(s.trim().replace(' ', 'T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  const m = /^\s*(?:D\s*:)?\s*(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?\s*(?:([Zz+-])\s*(\d\d?)?\s*'?\s*(\d\d)?)?/.exec(s);
  if (!m) return undefined;
  const f = m.slice(1, 7).map((x, i) => (x === undefined ? (i === 1 || i === 2 ? 1 : 0) : +x));
  const [y, mo, d, h, mi, se] = f;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return undefined;
  const offset = m[7] === '+' || m[7] === '-' ? (m[7] === '-' ? -1 : 1) * ((+(m[8] ?? 0)) * 60 + +(m[9] ?? 0)) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, se) - offset * 60000;
  const date = new Date(t);
  // Reject day overflow such as February 30th.
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d ? date : undefined;
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e] ?? all;
    const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1);
    return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : all;
  });

/**
 * One property from an XMP packet, found by its qualified name (e.g. 'dc:title') either as an
 * element or as an attribute. rdf:Alt yields its first item, rdf:Seq and rdf:Bag their items
 * joined with ', '. Plain string matching; no XML parser.
 */
export function xmpProperty(xmp: string, qname: string): string | undefined {
  const q = qname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const el = new RegExp(`<${q}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${q}\\s*>)`).exec(xmp);
  let v: string | undefined;
  if (el) {
    const body = el[1] ?? '';
    const items = [...body.matchAll(/<rdf:li(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/rdf:li\s*>)/g)].map((x) => x[1] ?? '');
    const alt = /<rdf:Alt[\s>]/.test(body);
    v = items.length ? (alt ? [items[0]] : items).map((x) => x.replace(/<[^>]*>/g, '')).join(', ') : body.replace(/<[^>]*>/g, '');
  } else {
    const at = new RegExp(`\\s${q}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xmp);
    if (at) v = at[1] ?? at[2];
  }
  v = v === undefined ? undefined : unescapeXml(v).trim();
  return v || undefined;
}

/** Info key -> [DocumentInfo field, XMP property]. */
const FIELDS: [string, keyof DocumentInfo, string][] = [
  ['Title', 'title', 'dc:title'],
  ['Author', 'author', 'dc:creator'],
  ['Subject', 'subject', 'dc:description'],
  ['Keywords', 'keywords', 'pdf:Keywords'],
  ['Creator', 'creator', 'xmp:CreatorTool'],
  ['Producer', 'producer', 'pdf:Producer'],
  ['CreationDate', 'creationDate', 'xmp:CreateDate'],
  ['ModDate', 'modDate', 'xmp:ModifyDate'],
];

const MAX_XMP = 16 << 20;

/** Is this action (or one chained after it with /Next) JavaScript? */
async function isJsAction(doc: PdfDocument, o: PdfObj | undefined, depth = 0): Promise<boolean> {
  const a = await doc.resolve(o);
  if (depth > 8) return false;
  if (Array.isArray(a)) {
    for (const x of a) if (await isJsAction(doc, x, depth + 1)) return true;
    return false;
  }
  if (!(a instanceof PdfDict)) return false;
  return nameOf(await doc.resolve(a.get('S'))) === 'JavaScript' || isJsAction(doc, a.get('Next'), depth + 1);
}

/**
 * Document information: version, page count, Info dictionary and XMP metadata, and flags
 * (encrypted, tagged, forms, JavaScript, signatures, attachments, repaired). Unlike the other
 * read functions this one does not throw on encrypted documents; it reports them.
 */
export async function getInfo(doc: PdfDocument): Promise<DocumentInfo> {
  const encrypted = doc.trailer.get('Encrypt') !== undefined;
  const cat = (await catalogOf(doc)) ?? new PdfDict();
  let pageCount = 0;
  for await (const _ of walkPages(doc)) pageCount++;
  let version = doc.version;
  const cv = nameOf(await doc.resolve(cat.get('Version')));
  if (cv && /^\d+\.\d+$/.test(cv) && +cv > +version) version = cv;

  const info: DocumentInfo = {
    version, pageCount, custom: {}, encrypted, tagged: false, hasForms: false, hasJavaScript: false, signed: false,
    attachments: 0, repaired: doc.repaired, warnings: [...doc.warnings],
  };
  const set = info as unknown as Record<string, unknown>;
  const put = (field: string, text: string): void => {
    const v = field.endsWith('Date') ? parsePdfDate(text) : text;
    if (v !== undefined && set[field] === undefined) set[field] = v;
  };
  if (!encrypted) {
    for (const [k, v] of (await dictOf(doc, doc.trailer.get('Info')))?.map ?? []) {
      const r = await doc.resolve(v);
      const text = r instanceof PdfString || (r instanceof PdfName && k === 'Trapped') ? await textAt(doc, r) : undefined;
      const f = FIELDS.find((x) => x[0] === k);
      if (text !== undefined) f ? put(f[1], text) : (info.custom[k] = text);
    }
    const lang = await textAt(doc, cat.get('Lang'));
    if (lang) info.language = lang;
    const md = cat.get('Metadata');
    const hdr = md instanceof PdfRef ? await doc.header(md.num) : null;
    // XMP is normally uncompressed or Flate: streamData covers both without the full decoder.
    const b = hdr?.stream ? await doc.streamData(hdr, MAX_XMP) : null;
    if (b) {
      const xmp = new TextDecoder(b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(b);
      info.metadata = xmp;
      for (const [, field, prop] of FIELDS) {
        const v = set[field] === undefined ? xmpProperty(xmp, prop) : undefined;
        if (v !== undefined) put(field, v);
      }
    }
  }

  const mark = await dictOf(doc, cat.get('MarkInfo'));
  info.tagged = !!mark && (await doc.resolve(mark.get('Marked'))) === true;

  const form = await dictOf(doc, cat.get('AcroForm'));
  if (form) {
    info.hasForms = !!(await arrayOf(doc, form.get('Fields')))?.length || form.get('XFA') !== undefined;
    info.signed = ((intOf(await doc.resolve(form.get('SigFlags'))) ?? 0) & 1) === 1;
    if (!info.signed) {
      await walkFields(doc, form, async (f) => {
        if (f.type === 'Sig' && (await doc.resolve(f.value)) instanceof PdfDict) return (info.signed = true);
      });
    }
  }

  const names = await dictOf(doc, cat.get('Names'));
  if (names) {
    await walkTree(doc, names.get('JavaScript'), 'Names', () => (info.hasJavaScript = true));
    await walkTree(doc, names.get('EmbeddedFiles'), 'Names', () => void info.attachments++);
  }
  if (!info.hasJavaScript) {
    info.hasJavaScript = await isJsAction(doc, cat.get('OpenAction'));
    const aa = await dictOf(doc, cat.get('AA'));
    for (const v of aa?.map.values() ?? []) if (!info.hasJavaScript) info.hasJavaScript = await isJsAction(doc, v);
  }
  return info;
}

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

/** Format a page number in a /PageLabels numbering style. */
function formatLabel(style: string | undefined, n: number): string {
  if (style === 'D' || ((style === 'R' || style === 'r' || style === 'A' || style === 'a') && n > 5000)) return String(n);
  if (style === 'R' || style === 'r') {
    let s = '';
    for (const [v, r] of ROMAN) for (; n >= v; n -= v) s += r;
    return style === 'R' ? s.toUpperCase() : s;
  }
  if (style === 'A' || style === 'a') {
    // A..Z, then AA..ZZ, AAA..: the letter repeated.
    const c = String.fromCharCode((style === 'A' ? 65 : 97) + ((n - 1) % 26));
    return c.repeat(Math.ceil(n / 26));
  }
  return '';
}

/**
 * Size, rotation and label of every page, in order. Works on encrypted documents too (page
 * geometry is not encrypted), but leaves labels out there.
 */
export async function getPages(doc: PdfDocument): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for await (const p of walkPages(doc)) {
    const [mx1, my1, mx2, my2] = norm(p.mediaBox);
    const [cx1, cy1, cx2, cy2] = norm(p.cropBox);
    const w = Math.min(mx2, cx2) - Math.max(mx1, cx1);
    const h = Math.min(my2, cy2) - Math.max(my1, cy1);
    // A crop box outside the media box is ignored.
    out.push(w > 0 && h > 0 ? { width: w, height: h, rotate: p.rotate } : { width: mx2 - mx1, height: my2 - my1, rotate: p.rotate });
  }
  const cat = await catalogOf(doc);
  if (!cat || doc.trailer.get('Encrypt') !== undefined || cat.get('PageLabels') === undefined) return out;
  const ranges: [number, PdfDict][] = [];
  await walkTree(doc, cat.get('PageLabels'), 'Nums', async (k, v) => {
    const d = await dictOf(doc, v);
    if (typeof k === 'number' && Number.isInteger(k) && k >= 0 && d) ranges.push([k, d]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let r = 0; r < ranges.length; r++) {
    const [start, d] = ranges[r];
    const end = Math.min(out.length, r + 1 < ranges.length ? ranges[r + 1][0] : out.length);
    const style = nameOf(await doc.resolve(d.get('S')));
    const prefix = (await textAt(doc, d.get('P'))) ?? '';
    const first = numOf(await doc.resolve(d.get('St'))) ?? 1;
    for (let i = start; i < end; i++) out[i].label = prefix + formatLabel(style, Math.max(1, Math.floor(first)) + i - start);
  }
  return out;
}

function norm(b: number[]): number[] {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}
