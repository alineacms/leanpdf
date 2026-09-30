/**
 * Deterministic PDF builder for tests. Knows about classic xref tables, xref streams (PNG-Up
 * predicted), object streams, hybrid files (/XRefStm), incremental updates and a handful of
 * deliberate kinds of damage. Output depends only on the calls made, never on time or randomness.
 */
import { deflateSync } from 'node:zlib';

export type XrefKind = 'table' | 'stream' | 'hybrid';

export function bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

export function text(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 8192)));
  return s;
}

export function concatBytes(parts: (Uint8Array | string)[]): Uint8Array {
  const bs = parts.map((p) => (typeof p === 'string' ? bytes(p) : p));
  let n = 0;
  for (const p of bs) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of bs) {
    out.set(p, n);
    n += p.length;
  }
  return out;
}

export function flate(data: Uint8Array, level = 6): Uint8Array {
  return new Uint8Array(deflateSync(data, { level }));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Index of `needle` in `hay` at or after `from`, or -1. */
export function find(hay: Uint8Array, needle: string | Uint8Array, from = 0): number {
  const n = typeof needle === 'string' ? bytes(needle) : needle;
  outer: for (let i = hay.indexOf(n[0], from); i >= 0 && i <= hay.length - n.length; i = hay.indexOf(n[0], i + 1)) {
    for (let j = 1; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export interface ObjOptions {
  gen?: number;
  /**
   * Streams: the /Length written. A number writes that (possibly wrong) value; 'indirect' writes
   * a reference to a separate object holding the true length.
   */
  length?: number | 'indirect';
  /** Leave out `endobj`. */
  noEndobj?: boolean;
  /** Streams: leave out `endstream` (the data is followed directly by `endobj`). */
  noEndstream?: boolean;
  /** May be packed into an object stream when the section asks for it. Default true. */
  compressible?: boolean;
}

interface ObjDef {
  num: number;
  gen: number;
  /** Full value for plain objects; dictionary entries (no << >>, no /Length) for streams. */
  value: string;
  data?: Uint8Array;
  lengthRef?: number;
  opts: ObjOptions;
}

interface SectionDef {
  objects: ObjDef[];
  frees: { num: number; gen: number }[];
  trailer: Map<string, string>;
}

export interface BuildOptions {
  /** Cross-reference kind per section (a single value applies to all). Default 'table'. */
  xref?: XrefKind | XrefKind[];
  /** Pack plain gen-0 objects of the section into one object stream. Needs 'stream' or 'hybrid'. */
  objStm?: boolean | boolean[];
  version?: string;
  /** num -> delta added to the offset recorded in the last section that lists the object. */
  badOffsets?: Record<number, number>;
  /** Number the first classic subsection "1 N" while listing object 0 first (a common writer bug). */
  offByOne?: boolean;
  /**
   * Hybrid sections: list object-stream members in the table as free entries (as some writers
   * do) instead of leaving them out. Readers must then let /XRefStm override those free entries.
   */
  hybridFreeEntries?: boolean;
  /** Line ending of classic xref entries (both 2 bytes). Default '\r\n'. */
  xrefEol?: '\r\n' | ' \n';
}

export interface BuiltPdf {
  bytes: Uint8Array;
  /** Live uncompressed objects: where the definition starts and where its `endobj` ends. */
  objects: Map<number, { offset: number; end: number; gen: number }>;
  /** Live compressed objects: num -> [object stream, index]. */
  compressed: Map<number, [number, number]>;
  /** Object numbers the builder itself created (object streams, xref streams). */
  internal: Set<number>;
  /** Offset of each section's xref (the table for hybrid sections). */
  xrefOffsets: number[];
  size: number;
}

const pad = (v: number, w: number): string => String(v).padStart(w, '0');
const byteWidth = (v: number): number => {
  let n = 1;
  while (v >= 256 ** n) n++;
  return n;
};

/** Contiguous runs of sorted numbers as [start, count] pairs. */
function runs(nums: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === n) last[1]++;
    else out.push([n, 1]);
  }
  return out;
}

type Entry = [type: 0 | 1 | 2, a: number, b: number];

export class PdfBuilder {
  protected sections: SectionDef[] = [{ objects: [], frees: [], trailer: new Map() }];
  private nextNum = 1;

  /** Reserve an object number. */
  alloc(): number {
    return this.nextNum++;
  }

  private get cur(): SectionDef {
    return this.sections[this.sections.length - 1];
  }

  /** Add a plain object; returns its number. */
  obj(value: string, opts: ObjOptions = {}): number {
    const n = this.alloc();
    this.setObj(n, value, opts);
    return n;
  }

  /** Define (or, in an update, redefine) object `num`. */
  setObj(num: number, value: string, opts: ObjOptions = {}): void {
    if (num >= this.nextNum) this.nextNum = num + 1;
    this.cur.objects.push({ num, gen: opts.gen ?? 0, value, opts });
  }

  /** Add a stream; `dict` holds the dictionary entries without << >> and without /Length. */
  stream(dict: string, data: Uint8Array, opts: ObjOptions = {}): number {
    const n = this.alloc();
    this.setStream(n, dict, data, opts);
    return n;
  }

  setStream(num: number, dict: string, data: Uint8Array, opts: ObjOptions = {}): void {
    if (num >= this.nextNum) this.nextNum = num + 1;
    const def: ObjDef = { num, gen: opts.gen ?? 0, value: dict, data, opts };
    this.cur.objects.push(def);
    if (opts.length === 'indirect') def.lengthRef = this.obj(String(data.length));
  }

  /** Delete object `num` in the current section (free entry with the given next generation). */
  free(num: number, gen = 1): void {
    this.cur.frees.push({ num, gen });
  }

  /** Set a trailer entry for the current section (and, by inheritance, later ones). */
  trailer(key: string, value: string): void {
    this.cur.trailer.set(key, value);
  }

  /** Start an incremental update. */
  update(): this {
    this.sections.push({ objects: [], frees: [], trailer: new Map() });
    return this;
  }

  get sectionCount(): number {
    return this.sections.length;
  }

  build(options: BuildOptions = {}): BuiltPdf {
    const xrefKinds = options.xref ?? 'table';
    const objStms = options.objStm ?? false;
    const kindOf = (i: number): XrefKind => (Array.isArray(xrefKinds) ? (xrefKinds[i] ?? xrefKinds[xrefKinds.length - 1]) : xrefKinds);
    const packOf = (i: number): boolean => (Array.isArray(objStms) ? (objStms[i] ?? false) : objStms);
    const eol = options.xrefEol ?? '\r\n';
    const bad = options.badOffsets ?? {};

    // Which section lists each object last (bad offsets apply there).
    const lastSection = new Map<number, number>();
    this.sections.forEach((s, i) => {
      for (const o of s.objects) lastSection.set(o.num, i);
      for (const f of s.frees) lastSection.set(f.num, i);
    });

    const parts: Uint8Array[] = [];
    let pos = 0;
    const put = (p: Uint8Array | string): void => {
      const b = typeof p === 'string' ? bytes(p) : p;
      parts.push(b);
      pos += b.length;
    };
    put(`%PDF-${options.version ?? '1.7'}\n%\xe2\xe3\xcf\xd3\n`);

    let next = this.nextNum;
    let size = 1;
    let prev = -1;
    const trailer = new Map<string, string>();
    const objects = new Map<number, { offset: number; end: number; gen: number }>();
    const compressed = new Map<number, [number, number]>();
    const internal = new Set<number>();
    const xrefOffsets: number[] = [];

    const writeObj = (o: ObjDef): void => {
      const start = pos;
      put(`${o.num} ${o.gen} obj\n`);
      if (o.data) {
        const len = o.lengthRef !== undefined ? `${o.lengthRef} 0 R` : String(typeof o.opts.length === 'number' ? o.opts.length : o.data.length);
        put(`<< ${o.value} /Length ${len} >>\nstream\n`);
        put(o.data);
        put(o.opts.noEndstream ? '\n' : '\nendstream\n');
      } else {
        put(`${o.value}\n`);
      }
      if (!o.opts.noEndobj) put('endobj');
      objects.set(o.num, { offset: start, end: pos, gen: o.gen });
      compressed.delete(o.num);
      put('\n');
    };

    this.sections.forEach((sec, si) => {
      const kind = kindOf(si);
      const pack = packOf(si);
      if (pack && kind === 'table') throw new Error('object streams need an xref stream or a hybrid section');
      const entries = new Map<number, Entry>();

      const packed = pack
        ? sec.objects.filter((o) => !o.data && o.gen === 0 && o.opts.compressible !== false && !o.opts.noEndobj)
        : [];
      const packedSet = new Set(packed);
      for (const o of sec.objects) {
        if (packedSet.has(o)) continue;
        entries.set(o.num, [1, pos, o.gen]);
        writeObj(o);
      }
      if (packed.length) {
        const stm = next++;
        internal.add(stm);
        let head = '';
        let body = '';
        packed.forEach((o, i) => {
          head += `${o.num} ${body.length} `;
          body += `${o.value}\n`;
          entries.set(o.num, [2, stm, i]);
          objects.delete(o.num);
          compressed.set(o.num, [stm, i]);
        });
        head += '\n';
        const data = flate(bytes(head + body));
        entries.set(stm, [1, pos, 0]);
        writeObj({ num: stm, gen: 0, value: `/Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode`, data, opts: {} });
      }
      for (const f of sec.frees) {
        entries.set(f.num, [0, 0, f.gen]);
        objects.delete(f.num);
        compressed.delete(f.num);
      }
      for (const [k, v] of sec.trailer) trailer.set(k, v);

      for (const [num, e] of entries) {
        if (e[0] === 1 && bad[num] !== undefined && lastSection.get(num) === si) e[1] += bad[num];
      }

      const trailerText = (): string => {
        let s = '';
        for (const [k, v] of trailer) s += ` /${k} ${v}`;
        return s + (prev >= 0 ? ` /Prev ${prev}` : '');
      };

      /** Entries covering either everything below `size` (first section) or just `nums`. */
      const layout = (nums: number[], all: boolean): { index: [number, number][]; list: number[] } => {
        if (all) {
          const list = Array.from({ length: size }, (_, i) => i);
          return { index: [[0, size]], list };
        }
        const sorted = [...new Set(nums)].sort((a, b) => a - b);
        return { index: runs(sorted), list: sorted };
      };
      const entryOf = (n: number): Entry => entries.get(n) ?? (n === 0 ? [0, 0, 65535] : [0, 0, 0]);

      const xrefStream = (nums: number[], all: boolean, extra: string): number => {
        const xnum = next++;
        internal.add(xnum);
        const at = pos;
        entries.set(xnum, [1, at, 0]);
        size = Math.max(size, xnum + 1);
        const { index, list } = layout([...nums, xnum], all);
        let maxA = 0;
        let maxB = 0;
        for (const n of list) {
          const e = entryOf(n);
          maxA = Math.max(maxA, e[1]);
          maxB = Math.max(maxB, e[2]);
        }
        const w2 = byteWidth(maxA);
        const w3 = byteWidth(maxB);
        const row = 1 + w2 + w3;
        const raw = new Uint8Array(list.length * (row + 1));
        const prevRow = new Uint8Array(row);
        const curRow = new Uint8Array(row);
        list.forEach((n, i) => {
          let [t, a, b] = entryOf(n);
          curRow[0] = t;
          for (let k = w2; k >= 1; k--, a = Math.floor(a / 256)) curRow[k] = a % 256;
          for (let k = w2 + w3; k > w2; k--, b = Math.floor(b / 256)) curRow[k] = b % 256;
          const o = i * (row + 1);
          raw[o] = 2;
          for (let k = 0; k < row; k++) raw[o + 1 + k] = (curRow[k] - prevRow[k]) & 255;
          prevRow.set(curRow);
        });
        const data = flate(raw);
        const idx = index.map(([s, c]) => `${s} ${c}`).join(' ');
        const dict =
          `/Type /XRef /Size ${size} /Index [${idx}] /W [1 ${w2} ${w3}] /Filter /FlateDecode ` +
          `/DecodeParms << /Predictor 12 /Columns ${row} >>${extra}`;
        writeObj({ num: xnum, gen: 0, value: dict, data, opts: {} });
        return at;
      };

      const maxNum = Math.max(0, ...entries.keys());
      size = Math.max(size, maxNum + 1, si === 0 ? next : 0);
      if (kind === 'stream') {
        const at = xrefStream([...entries.keys()], si === 0, trailerText());
        put(`startxref\n${at}\n%%EOF\n`);
        xrefOffsets.push(at);
        prev = at;
        return;
      }
      let stmAt = -1;
      if (kind === 'hybrid') {
        const comp = [...entries].filter(([, e]) => e[0] === 2).map(([n]) => n);
        stmAt = xrefStream(comp, false, '');
      }
      const at = pos;
      let { index, list } = layout([...entries.keys()], si === 0);
      if (kind === 'hybrid' && !options.hybridFreeEntries) {
        // Leave object-stream members out of the table; they are found through /XRefStm only.
        list = list.filter((n) => entries.get(n)?.[0] !== 2);
        index = runs(list);
      }
      put('xref\n');
      let li = 0;
      index.forEach(([s, c], k) => {
        put(`${si === 0 && k === 0 && options.offByOne ? s + 1 : s} ${c}\n`);
        let block = '';
        for (let j = 0; j < c; j++) {
          const n = list[li++];
          const e = entryOf(n);
          // Compressed objects appear as free entries in the table part of a hybrid file.
          block += e[0] === 1 ? `${pad(e[1], 10)} ${pad(e[2], 5)} n${eol}` : `${pad(0, 10)} ${pad(e[0] === 2 ? 0 : e[2], 5)} f${eol}`;
        }
        put(block);
      });
      put(`trailer\n<< /Size ${size}${trailerText()}${stmAt >= 0 ? ` /XRefStm ${stmAt}` : ''} >>\nstartxref\n${at}\n%%EOF\n`);
      xrefOffsets.push(at);
      prev = at;
    });

    return { bytes: concatBytes(parts), objects, compressed, internal, xrefOffsets, size };
  }
}

// ---------------------------------------------------------------------------------------------
// Pages, images and content

export interface PageSpec {
  /** Media box size in points. Default A4. */
  width?: number;
  height?: number;
  content: string;
  /** Resource name (without slash) -> image/form object number. */
  xobjects?: Record<string, number>;
  /** Extra page dictionary entries. */
  extra?: string;
  /** Extra resource dictionary entries. */
  resources?: string;
}

export const A4 = { width: 595, height: 842 };

/** A PdfBuilder with a catalog, a flat page tree and Helvetica. */
export class DocBuilder extends PdfBuilder {
  readonly catalog: number;
  readonly pagesNum: number;
  readonly font: number;
  readonly pages: number[] = [];
  catalogExtra = '';

  constructor() {
    super();
    this.catalog = this.alloc();
    this.pagesNum = this.alloc();
    this.font = this.obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  }

  /** Page dictionary text for `spec` with content stream `contents`. */
  pageDict(spec: PageSpec, contents: number): string {
    const xo = Object.entries(spec.xobjects ?? {})
      .map(([k, v]) => `/${k} ${v} 0 R`)
      .join(' ');
    return (
      `<< /Type /Page /Parent ${this.pagesNum} 0 R /MediaBox [0 0 ${spec.width ?? A4.width} ${spec.height ?? A4.height}] ` +
      `/Resources << /Font << /F1 ${this.font} 0 R >>${xo ? ` /XObject << ${xo} >>` : ''}${spec.resources ?? ''} >> ` +
      `/Contents ${contents} 0 R${spec.extra ?? ''} >>`
    );
  }

  /** Add a page with a Flate-compressed content stream. Returns the page object number. */
  page(spec: PageSpec, contentOpts: ObjOptions & { raw?: boolean } = {}): number {
    const data = bytes(spec.content);
    const contents = contentOpts.raw ? this.stream('', data, contentOpts) : this.stream('/Filter /FlateDecode', flate(data), contentOpts);
    const p = this.obj(this.pageDict(spec, contents));
    this.pages.push(p);
    return p;
  }

  /** Page tree text for the current page list. */
  pagesDict(): string {
    return `<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`;
  }

  /**
   * Write the catalog and page tree at the start of the first section and set /Root (and a
   * deterministic /ID).
   */
  finish(id = 'pdfgen'): this {
    const first = this.sections[0];
    const saved = this.sections;
    this.sections = [{ objects: [], frees: [], trailer: new Map() }];
    this.setObj(this.catalog, `<< /Type /Catalog /Pages ${this.pagesNum} 0 R${this.catalogExtra} >>`);
    this.setObj(this.pagesNum, this.pagesDict());
    const head = this.sections[0].objects;
    this.sections = saved;
    first.objects.unshift(...head);
    const hex = Array.from(bytes(id.padEnd(16, '.').slice(0, 16)), (c) => c.toString(16).padStart(2, '0')).join('');
    first.trailer.set('Root', `${this.catalog} 0 R`);
    first.trailer.set('ID', `[<${hex}> <${hex}>]`);
    return this;
  }
}

export interface ImageSpec {
  width: number;
  height: number;
  /** PDF source text of the /ColorSpace value, e.g. '/DeviceRGB' or '[/ICCBased 7 0 R]'. */
  colorSpace?: string;
  bpc?: number;
  /** PDF source text of /Filter, e.g. '/DCTDecode' or '[/FlateDecode /DCTDecode]'. */
  filter?: string;
  decodeParms?: string;
  /** Extra dictionary entries, e.g. '/SMask 12 0 R' or '/Decode [1 0]'. */
  extra?: string;
}

/** Dictionary entries of an image XObject (for PdfBuilder.stream). */
export function imageDict(s: ImageSpec): string {
  let d = `/Type /XObject /Subtype /Image /Width ${s.width} /Height ${s.height}`;
  if (s.colorSpace) d += ` /ColorSpace ${s.colorSpace}`;
  d += ` /BitsPerComponent ${s.bpc ?? 8}`;
  if (s.filter) d += ` /Filter ${s.filter}`;
  if (s.decodeParms) d += ` /DecodeParms ${s.decodeParms}`;
  if (s.extra) d += ` ${s.extra}`;
  return d;
}

/** Content operators that paint image `name` into the rectangle (x, y, w, h). */
export const drawImage = (name: string, x: number, y: number, w: number, h: number): string =>
  `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q\n`;

/** Helvetica text (F1) at (x, y); `s` must be printable ASCII without backslashes. */
export const drawText = (s: string, x: number, y: number, size = 12, rgb = '0 0 0'): string =>
  `BT ${rgb} rg /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()]/g, '')}) Tj ET\n`;

/** Some deterministic vector art: filled and stroked shapes and a curve. */
export function vectorArt(x: number, y: number, w: number, h: number, seed = 1): string {
  let s = 'q\n';
  for (let i = 0; i < 6; i++) {
    const k = (seed * 7 + i * 13) % 17;
    s += `${(k % 5) / 5} ${(k % 3) / 3} ${(k % 7) / 7} rg ${x + (i * w) / 7} ${y + (k * h) / 34} ${w / 9} ${h / 2 - (k * h) / 40} re f\n`;
  }
  s += `0.2 0.3 0.8 RG 2 w ${x} ${y} m ${x + w / 3} ${y + h} ${x + (2 * w) / 3} ${y - h / 3} ${x + w} ${y + h / 2} c S\n`;
  s += `0.9 0.4 0.1 RG 1 w ${x} ${y} ${w} ${h} re S\nQ\n`;
  return s;
}

/** A paragraph of filler text lines. */
export function paragraph(x: number, y: number, lines: number, size = 10, seed = 0): string {
  const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor'];
  let s = '';
  for (let i = 0; i < lines; i++) {
    let line = '';
    for (let j = 0; j < 10; j++) line += words[(seed + i * 5 + j * 3 + ((i * j) % 7)) % words.length] + ' ';
    s += drawText(line.trim(), x, y - i * size * 1.3, size);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Damage applied to finished bytes

export const damage = {
  /** Keep only the first `n` bytes. */
  truncate: (b: Uint8Array, n: number): Uint8Array => b.slice(0, Math.max(0, Math.min(b.length, n))),
  /** Bytes before the header; offsets in the file are left relative to the header. */
  prefix: (b: Uint8Array, junk: Uint8Array | string): Uint8Array => concatBytes([junk, b]),
  /** Garbage after the final %%EOF. */
  suffix: (b: Uint8Array, junk: Uint8Array | string): Uint8Array => concatBytes([b, junk]),
  /** Replace the `startxref` value with `value` (same number of digits or not). */
  startxref(b: Uint8Array, value: number): Uint8Array {
    const s = text(b);
    const i = s.lastIndexOf('startxref');
    const m = /^startxref\s+(\d+)/.exec(s.slice(i));
    if (i < 0 || !m) throw new Error('no startxref');
    return concatBytes([b.subarray(0, i), `startxref\n${value}`, b.subarray(i + m[0].length)]);
  },
};
