/**
 * Test-side font tooling: a scanline rasterizer for outlines, writers for CFF, Type 1 and sfnt
 * fonts (to build fonts that exercise rare features), eexec encryption, and PDFs that embed a font
 * so MuPDF can render it for comparison.
 */
import { existsSync, readFileSync } from 'node:fs';
import { CLOSE, CUBIC, LINE, MOVE, QUAD, type Matrix, type Outline } from '../../src/render/fonts/program.ts';
import { bytes, concatBytes, PdfBuilder } from '../support/pdfgen.ts';
import { renderPdf } from '../support/render.ts';

export const read = (path: string): Uint8Array | undefined => (existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined);

// ---------------------------------------------------------------------------------------------
// Outlines

export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Every point of an outline (on- and off-curve), as [x, y] pairs. */
export function points(o: Outline): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < o.length; ) {
    const op = o[i++];
    for (let n = op === CLOSE ? 0 : op === CUBIC ? 3 : op === QUAD ? 2 : 1; n--; i += 2) out.push([o[i], o[i + 1]]);
  }
  return out;
}

/** Control box [xMin, yMin, xMax, yMax] of an outline, or undefined when empty. */
export function controlBox(o: Outline): [number, number, number, number] | undefined {
  const p = points(o);
  if (!p.length) return undefined;
  return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
}

/** Check the command structure: known commands with their coordinate counts, finite numbers. */
export function wellFormed(o: Outline): boolean {
  for (let i = 0; i < o.length; ) {
    const op = o[i++];
    if (!(op >= MOVE && op <= CLOSE)) return false;
    const n = op === CLOSE ? 0 : op === CUBIC ? 6 : op === QUAD ? 4 : 2;
    if (i + n > o.length) return false;
    for (let k = 0; k < n; k++) if (!Number.isFinite(o[i + k])) return false;
    i += n;
  }
  return true;
}

/**
 * Nonzero-winding fill of `o` into a `w` x `h` mask, sampling pixel centers. `m` maps glyph units
 * to pixels (y down). Curves are flattened into 16 segments.
 */
export function rasterize(o: Outline, m: Matrix, w: number, h: number, mask = new Uint8Array(w * h)): Uint8Array {
  const edges: number[] = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const tx = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const lineTo = (x: number, y: number): void => {
    edges.push(cx, cy, x, y);
    cx = x;
    cy = y;
  };
  for (let i = 0; i < o.length; ) {
    const op = o[i++];
    if (op === MOVE || op === CLOSE) {
      if (cx !== sx || cy !== sy) lineTo(sx, sy);
      if (op === MOVE) [sx, sy] = [cx, cy] = tx(o[i++], o[i++]);
    } else if (op === LINE) lineTo(...tx(o[i++], o[i++]));
    else {
      const pts = [[cx, cy], ...Array.from({ length: op === QUAD ? 2 : 3 }, () => tx(o[i++], o[i++]))];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        const c = op === QUAD ? [u * u, 2 * u * t, t * t] : [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        lineTo(
          c.reduce((s, v, j) => s + v * pts[j][0], 0),
          c.reduce((s, v, j) => s + v * pts[j][1], 0),
        );
      }
    }
  }
  if (cx !== sx || cy !== sy) lineTo(sx, sy);
  for (let row = 0; row < h; row++) {
    const yc = row + 0.5;
    const xs: [number, number][] = [];
    for (let e = 0; e < edges.length; e += 4) {
      const [x0, y0, x1, y1] = edges.slice(e, e + 4);
      if (y0 <= yc !== y1 <= yc) xs.push([x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0), y1 > y0 ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    for (let k = 0, wind = 0; k < xs.length; k++) {
      const before = wind;
      wind += xs[k][1];
      if (before !== 0 && k > 0) {
        for (let px = Math.max(0, Math.ceil(xs[k - 1][0] - 0.5)); px < Math.min(w, Math.ceil(xs[k][0] - 0.5)); px++) mask[row * w + px] = 1;
      }
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------------------------
// Rendering fonts through MuPDF

export interface Placed {
  /** Hex of the content-stream string that shows the glyph (1 byte for simple fonts, 2 for Type0). */
  code: string;
  /** The glyph outline in glyph units. */
  outline: Outline;
}

/**
 * Show each glyph in its own cell with MuPDF (font F1 set up by `addFont`) and rasterize the
 * outlines the same way. Per glyph cell: the share of ink pixels (of either rendering) that the
 * other rendering doesn't have within one pixel, so antialiasing and hinting differences along
 * edges don't count but missing or misplaced parts do.
 */
export function compareWithMupdf(addFont: (b: PdfBuilder) => number, glyphs: Placed[], fontMatrix: Matrix, size = 64): { mismatch: number[]; messages: string[] } {
  const cols = 8;
  const cell = Math.round(size * 1.6);
  const W = cols * cell;
  const H = Math.ceil(glyphs.length / cols) * cell;
  const b = new PdfBuilder();
  const catalog = b.alloc();
  const pages = b.alloc();
  const font = addFont(b);
  let content = '';
  const ours = new Uint8Array(W * H);
  glyphs.forEach((g, i) => {
    const x = (i % cols) * cell + size * 0.3;
    const y = H - Math.floor(i / cols) * cell - size * 1.2;
    content += `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm <${g.code}> Tj ET\n`;
    rasterize(g.outline, mul(mul(fontMatrix, [size, 0, 0, size, x, y]), [1, 0, 0, -1, 0, H]), W, H, ours);
  });
  const contents = b.stream('', bytes(content));
  const page = b.obj(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`);
  b.setObj(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  b.setObj(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  b.trailer('Root', `${catalog} 0 R`);
  const r = renderPdf(b.build().bytes, 1, 72);
  const px = r.pages[0];
  if (!px || px.width !== W || px.height !== H) throw new Error(`MuPDF rendering failed: ${r.messages.join('; ')}`);
  const theirs = new Uint8Array(W * H).map((_, o) => +(px.rgb[3 * o] + px.rgb[3 * o + 1] + px.rgb[3 * o + 2] < 3 * 128));
  const near = (m: Uint8Array, x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (m[(y + dy) * W + x + dx]) return true;
    return false;
  };
  const mismatch = glyphs.map((_, i) => {
    let ink = 0;
    let bad = 0;
    const x0 = (i % cols) * cell;
    const y0 = Math.floor(i / cols) * cell;
    for (let y = y0 + 1; y < y0 + cell - 1; y++) {
      for (let x = x0 + 1; x < x0 + cell - 1; x++) {
        const o = y * W + x;
        if (!ours[o] && !theirs[o]) continue;
        ink++;
        if ((ours[o] && !near(theirs, x, y)) || (theirs[o] && !near(ours, x, y))) bad++;
      }
    }
    return ink ? bad / ink : 0;
  });
  return { mismatch, messages: r.messages };
}

const descriptor = (b: PdfBuilder, fontFile: string, flags = 4): number =>
  b.obj(`<< /Type /FontDescriptor /FontName /Test /Flags ${flags} /FontBBox [-500 -500 1500 1500] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 ${fontFile} >>`);

/** A Type0 font with Identity-H over a CIDFontType2 (TrueType, CID = GID) or CIDFontType0 (CFF) font. */
export function type0Font(b: PdfBuilder, data: Uint8Array, kind: 'FontFile2' | 'CIDFontType0C' | 'OpenType'): number {
  const ff = kind === 'FontFile2' ? b.stream(`/Length1 ${data.length}`, data) : b.stream(`/Subtype /${kind}`, data);
  const desc = descriptor(b, `/${kind === 'FontFile2' ? 'FontFile2' : 'FontFile3'} ${ff} 0 R`);
  const sub = kind === 'FontFile2' ? '/CIDFontType2 /CIDToGIDMap /Identity' : '/CIDFontType0';
  const cid = b.obj(
    `<< /Type /Font /Subtype ${sub} /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 >>`,
  );
  return b.obj(`<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [${cid} 0 R] >>`);
}

/** A simple Type 1 font (FontFile, or FontFile3 /Type1C) whose codes 1..n show `names`. */
export function simpleFont(b: PdfBuilder, data: Uint8Array, kind: 'FontFile' | 'Type1C', names: string[], lengths?: [number, number, number]): number {
  const ff =
    kind === 'FontFile'
      ? b.stream(`/Length1 ${lengths?.[0] ?? data.length} /Length2 ${lengths?.[1] ?? 0} /Length3 ${lengths?.[2] ?? 0}`, data)
      : b.stream('/Subtype /Type1C', data);
  const desc = descriptor(b, `/${kind === 'FontFile' ? 'FontFile' : 'FontFile3'} ${ff} 0 R`, 32);
  return b.obj(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Test /FirstChar 1 /LastChar ${names.length} /Widths [${names.map(() => 500).join(' ')}] ` +
      `/Encoding << /Type /Encoding /Differences [1 ${names.map((n) => `/${n}`).join(' ')}] >> /FontDescriptor ${desc} 0 R >>`,
  );
}

export const hex = (n: number, bytes = 1): string => n.toString(16).padStart(2 * bytes, '0');

// ---------------------------------------------------------------------------------------------
// sfnt

/** A table of an sfnt font, or undefined. */
export function sfntTable(d: Uint8Array, tag: string): Uint8Array | undefined {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const r = 12 + 16 * i;
    if (String.fromCharCode(...d.subarray(r, r + 4)) === tag) return d.subarray(dv.getUint32(r + 8), dv.getUint32(r + 8) + dv.getUint32(r + 12));
  }
  return undefined;
}

/** Build an sfnt from tables (tags of 4 characters). */
export function sfnt(tables: Record<string, Uint8Array>, version = 0x00010000): Uint8Array {
  const tags = Object.keys(tables).sort();
  const head = new Uint8Array(12 + 16 * tags.length);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, version);
  dv.setUint16(4, tags.length);
  let off = head.length;
  const parts: Uint8Array[] = [head];
  tags.forEach((t, i) => {
    const r = 12 + 16 * i;
    for (let k = 0; k < 4; k++) head[r + k] = t.charCodeAt(k);
    dv.setUint32(r + 8, off);
    dv.setUint32(r + 12, tables[t].length);
    const padded = new Uint8Array((tables[t].length + 3) & ~3);
    padded.set(tables[t]);
    parts.push(padded);
    off += padded.length;
  });
  return concatBytes(parts);
}

/** Big-endian integers: [value, byte count] pairs (negative values in two's complement). */
export function be(...fields: [number, number][]): Uint8Array {
  const out: number[] = [];
  for (const [v, n] of fields) for (let k = n - 1; k >= 0; k--) out.push(Math.floor(v / 2 ** (8 * k)) & 255);
  return new Uint8Array(out);
}

export type Point = [x: number, y: number, on: boolean];

/** A simple glyf glyph: contours of points, with repeated flags and short/long coordinates. */
export function simpleGlyph(contours: Point[][]): Uint8Array {
  const pts = contours.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const out: number[] = [...be([contours.length, 2], [Math.min(...xs), 2], [Math.min(...ys), 2], [Math.max(...xs), 2], [Math.max(...ys), 2])];
  let end = -1;
  for (const c of contours) out.push(...be([(end += c.length), 2]));
  out.push(0, 0);
  const flags: number[] = [];
  const coords: number[][] = [[], []];
  let px = 0;
  let py = 0;
  for (const [x, y, on] of pts) {
    let f = on ? 1 : 0;
    [x - px, y - py].forEach((dv, a) => {
      if (dv === 0) f |= 16 << a;
      else if (Math.abs(dv) < 256) {
        f |= (2 << a) | (dv > 0 ? 16 << a : 0);
        coords[a].push(Math.abs(dv));
      } else coords[a].push(...be([dv & 0xffff, 2]));
    });
    flags.push(f);
    px = x;
    py = y;
  }
  for (let i = 0; i < flags.length; ) {
    let n = 1;
    while (i + n < flags.length && flags[i + n] === flags[i] && n < 255) n++;
    if (n > 1) out.push(flags[i] | 8, n - 1);
    else out.push(flags[i]);
    i += n;
  }
  out.push(...coords[0], ...coords[1]);
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------------------------
// Charstrings

const T2_OPS: Record<string, number> = {
  hstem: 1, vstem: 3, vmoveto: 4, rlineto: 5, hlineto: 6, vlineto: 7, rrcurveto: 8, callsubr: 10, return: 11, endchar: 14,
  hstemhm: 18, hintmask: 19, cntrmask: 20, rmoveto: 21, hmoveto: 22, vstemhm: 23, rcurveline: 24, rlinecurve: 25,
  vvcurveto: 26, hhcurveto: 27, callgsubr: 29, vhcurveto: 30, hvcurveto: 31,
  dotsection: 1200, and: 1203, or: 1204, not: 1205, abs: 1209, add: 1210, sub: 1211, div: 1212, neg: 1214, eq: 1215,
  drop: 1218, put: 1220, get: 1221, ifelse: 1222, random: 1223, mul: 1224, sqrt: 1226, dup: 1227, exch: 1228, index: 1229,
  roll: 1230, hflex: 1234, flex: 1235, hflex1: 1236, flex1: 1237,
};
const T1_OPS: Record<string, number> = {
  hstem: 1, vstem: 3, vmoveto: 4, rlineto: 5, hlineto: 6, vlineto: 7, rrcurveto: 8, closepath: 9, callsubr: 10, return: 11,
  hsbw: 13, endchar: 14, rmoveto: 21, hmoveto: 22, vhcurveto: 30, hvcurveto: 31, dotsection: 1200, vstem3: 1201, hstem3: 1202,
  seac: 1206, sbw: 1207, div: 1212, callothersubr: 1216, pop: 1217, setcurrentpoint: 1233,
};

/**
 * Encode a charstring: numbers and operator names; `mask:<hex>` inserts raw bytes (hintmask
 * data). Type 2 encodes fractions as 16.16 and large integers with 28; Type 1 uses 255 + int32.
 */
export function charstring(type: 1 | 2, ...tokens: (number | string)[]): Uint8Array {
  const out: number[] = [];
  for (const t of tokens) {
    if (typeof t === 'string') {
      if (t.startsWith('mask:')) out.push(...(t.slice(5).match(/../g) ?? []).map((h) => parseInt(h, 16)));
      else {
        const op = (type === 1 ? T1_OPS : T2_OPS)[t];
        if (op === undefined) throw new Error(`unknown operator ${t}`);
        out.push(...(op >= 1200 ? [12, op - 1200] : [op]));
      }
    } else if (Number.isInteger(t) && t >= -107 && t <= 107) out.push(t + 139);
    else if (Number.isInteger(t) && t >= 108 && t <= 1131) out.push(((t - 108) >> 8) + 247, (t - 108) & 255);
    else if (Number.isInteger(t) && t <= -108 && t >= -1131) out.push(((-t - 108) >> 8) + 251, (-t - 108) & 255);
    else if (type === 2 && Number.isInteger(t) && t >= -32768 && t <= 32767) out.push(28, (t >> 8) & 255, t & 255);
    else if (type === 2) out.push(255, ...be([Math.round(t * 65536) >>> 0, 4]));
    else out.push(255, ...be([t >>> 0, 4]));
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------------------------
// CFF writer

/** An INDEX with 4-byte offsets. */
function cffIndex(items: Uint8Array[]): Uint8Array {
  if (!items.length) return new Uint8Array(2);
  let off = 1;
  const offs = [off, ...items.map((i) => (off += i.length))];
  return concatBytes([be([items.length, 2], [4, 1]), ...offs.map((o) => be([o, 4])), ...items]);
}

type DictEntries = [op: number, operands: number[]][];

/** A DICT; integers as 5-byte (so sizes don't depend on values), others as reals. */
function cffDict(entries: DictEntries): Uint8Array {
  const out: number[] = [];
  for (const [op, operands] of entries) {
    for (const v of operands) {
      if (Number.isInteger(v)) out.push(29, ...be([v >>> 0, 4]));
      else {
        const nibs = [...String(v).toUpperCase().replace('E-', 'c').replace('E+', 'b').replace('E', 'b')].map((c) =>
          c === '.' ? 10 : c === 'b' ? 11 : c === 'c' ? 12 : c === '-' ? 14 : +c,
        );
        nibs.push(15);
        if (nibs.length & 1) nibs.push(15);
        out.push(30);
        for (let i = 0; i < nibs.length; i += 2) out.push((nibs[i] << 4) | nibs[i + 1]);
      }
    }
    out.push(...(op >= 1200 ? [12, op - 1200] : [op]));
  }
  return new Uint8Array(out);
}

export interface CffPrivate {
  subrs?: Uint8Array[];
  defaultWidthX?: number;
  nominalWidthX?: number;
}

export interface CffSpec {
  charstrings: Uint8Array[];
  gsubrs?: Uint8Array[];
  /** Extra strings (SIDs from 391). */
  strings?: string[];
  fontMatrix?: number[];
  private?: CffPrivate;
  /** Name-keyed: a predefined charset id (0-2), or SIDs for glyphs 1.. with the format to write. */
  charset?: number | { format: 0 | 1 | 2; ids: number[] };
  /** Name-keyed: a predefined encoding id (0-1), or raw encoding bytes (format byte first). */
  encoding?: number | Uint8Array;
  /** CID-keyed: FDs, FDSelect (FD by glyph) and its format; `charset` then holds CIDs. */
  cid?: { fds: { private?: CffPrivate; fontMatrix?: number[] }[]; fdSelect: number[]; format: 0 | 3 };
  charstringType?: number;
}

/** Write a CFF font from its parts. */
export function writeCff(s: CffSpec): Uint8Array {
  const n = s.charstrings.length;
  let charset: Uint8Array | undefined;
  if (typeof s.charset === 'object') {
    const { format, ids } = s.charset;
    const parts: number[][] = [[format]];
    if (format === 0) for (const id of ids) parts.push([...be([id, 2])]);
    else {
      for (let i = 0; i < ids.length; ) {
        let k = 1;
        while (i + k < ids.length && ids[i + k] === ids[i] + k && k < (format === 1 ? 256 : 65536)) k++;
        parts.push([...be([ids[i], 2], [k - 1, format])]);
        i += k;
      }
    }
    charset = new Uint8Array(parts.flat());
  }
  const encoding = typeof s.encoding === 'object' ? s.encoding : undefined;
  const fdSelect = s.cid
    ? s.cid.format === 0
      ? new Uint8Array([0, ...s.cid.fdSelect])
      : (() => {
          const ranges: number[] = [];
          s.cid!.fdSelect.forEach((fd, g) => {
            if (!g || fd !== s.cid!.fdSelect[g - 1]) ranges.push(...be([g, 2], [fd, 1]));
          });
          return concatBytes([be([3, 1], [ranges.length / 3, 2]), new Uint8Array(ranges), be([n, 2])]);
        })()
    : undefined;
  const privDict = (p: CffPrivate | undefined, subrsAt: number): DictEntries => [
    ...(p?.defaultWidthX !== undefined ? [[20, [p.defaultWidthX]] as [number, number[]]] : []),
    ...(p?.nominalWidthX !== undefined ? [[21, [p.nominalWidthX]] as [number, number[]]] : []),
    ...(p?.subrs ? [[19, [subrsAt]] as [number, number[]]] : []),
  ];
  const privates = s.cid ? s.cid.fds.map((f) => f.private) : [s.private];
  // Layout pass 1 with zero offsets gives the sizes (every integer takes 5 bytes).
  const build = (offs: Record<string, number>): Uint8Array => {
    const o = (k: string): number => offs[k] ?? 0;
    const top: DictEntries = [];
    if (s.cid) top.push([1230, [391, 392, 0]]);
    if (s.fontMatrix) top.push([1207, s.fontMatrix]);
    if (s.charstringType !== undefined) top.push([1206, [s.charstringType]]);
    if (charset) top.push([15, [o('charset')]]);
    else if (typeof s.charset === 'number') top.push([15, [s.charset]]);
    if (encoding) top.push([16, [o('encoding')]]);
    else if (typeof s.encoding === 'number') top.push([16, [s.encoding]]);
    top.push([17, [o('charstrings')]]);
    if (s.cid) top.push([1236, [o('fdArray')]], [1237, [o('fdSelect')]]);
    else top.push([18, [o('privSize0'), o('priv0')]]);
    const strings = [...(s.cid ? ['Adobe', 'Identity'] : []), ...(s.strings ?? [])].map(bytes);
    const head = concatBytes([new Uint8Array([1, 0, 4, 4]), cffIndex([bytes('Test')]), cffIndex([cffDict(top)]), cffIndex(strings), cffIndex(s.gsubrs ?? [])]);
    const parts: Uint8Array[] = [head];
    let pos = head.length;
    const put = (name: string, b: Uint8Array): void => {
      offs[name] = pos;
      parts.push(b);
      pos += b.length;
    };
    if (charset) put('charset', charset);
    if (encoding) put('encoding', encoding);
    if (fdSelect) put('fdSelect', fdSelect);
    put('charstrings', cffIndex(s.charstrings));
    if (s.cid) {
      const fds = s.cid.fds.map((f, i) =>
        cffDict([...(f.fontMatrix ? [[1207, f.fontMatrix] as [number, number[]]] : []), [18, [o(`privSize${i}`), o(`priv${i}`)]]]),
      );
      put('fdArray', cffIndex(fds));
    }
    privates.forEach((p, i) => {
      const size = cffDict(privDict(p, 0)).length;
      const dict = cffDict(privDict(p, size));
      offs[`privSize${i}`] = dict.length;
      put(`priv${i}`, dict);
      if (p?.subrs) put(`subrs${i}`, cffIndex(p.subrs));
    });
    return concatBytes(parts);
  };
  const offs: Record<string, number> = {};
  build(offs);
  return build(offs);
}

/** Minimal CFF reading for tests: the charstrings, global and local subrs and widths of a name-keyed font. */
export function readCff(d: Uint8Array): { charstrings: Uint8Array[]; gsubrs: Uint8Array[]; private: CffPrivate; sids: number[] } {
  const index = (p: number): { items: Uint8Array[]; end: number } => {
    const n = (d[p] << 8) | d[p + 1];
    if (!n) return { items: [], end: p + 2 };
    const size = d[p + 2];
    const off = (i: number): number => {
      let v = 0;
      for (let k = 0; k < size; k++) v = v * 256 + d[p + 3 + i * size + k];
      return p + 2 + (n + 1) * size + v;
    };
    return { items: Array.from({ length: n }, (_, i) => d.subarray(off(i), off(i + 1))), end: off(n) };
  };
  const dict = (b: Uint8Array): Map<number, number[]> => {
    const m = new Map<number, number[]>();
    let ops: number[] = [];
    for (let p = 0; p < b.length; ) {
      const v = b[p++];
      if (v < 22) {
        m.set(v === 12 ? 1200 + b[p++] : v, ops);
        ops = [];
      } else if (v === 28) (ops.push(((b[p] << 24) | (b[p + 1] << 16)) >> 16), (p += 2));
      else if (v === 29) (ops.push((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]), (p += 4));
      else if (v === 30) {
        while ((b[p++] & 15) !== 15 && (b[p - 1] >> 4) !== 15);
        ops.push(0);
      } else ops.push(v < 247 ? v - 139 : v < 251 ? (v - 247) * 256 + b[p++] + 108 : -(v - 251) * 256 - b[p++] - 108);
    }
    return m;
  };
  const names = index(d[2]);
  const tops = index(names.end);
  const strings = index(tops.end);
  const gsubrs = index(strings.end);
  const top = dict(tops.items[0]);
  const charstrings = index(top.get(17)![0]).items;
  const [size, off] = top.get(18)!;
  const pd = dict(d.subarray(off, off + size));
  const subrs = pd.get(19) ? index(off + pd.get(19)![0]).items : undefined;
  // charset (format 0-2) as SIDs
  const sids = [0];
  const co = top.get(15)?.[0] ?? 0;
  for (let p = co + 1, f = d[co]; sids.length < charstrings.length; ) {
    if (f === 0) (sids.push((d[p] << 8) | d[p + 1]), (p += 2));
    else {
      const first = (d[p] << 8) | d[p + 1];
      const left = f === 1 ? d[p + 2] : (d[p + 2] << 8) | d[p + 3];
      for (let k = 0; k <= left; k++) sids.push(first + k);
      p += f === 1 ? 3 : 4;
    }
  }
  return { charstrings, gsubrs: gsubrs.items, private: { subrs, defaultWidthX: pd.get(20)?.[0], nominalWidthX: pd.get(21)?.[0] }, sids };
}

// ---------------------------------------------------------------------------------------------
// Type 1 writer

/** Type 1 encryption (eexec r = 55665, charstrings r = 4330) with `lead` leading bytes. */
export function encrypt(plain: Uint8Array, r: number, lead = 4): Uint8Array {
  const src = concatBytes([new Uint8Array(lead).map((_, i) => 0x31 + i), plain]);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = (out[i] = src[i] ^ (r >> 8));
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

export function decrypt(cipher: Uint8Array, r: number): Uint8Array {
  const out = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    const c = cipher[i];
    out[i] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out.subarray(4);
}

export interface Type1Spec {
  glyphs: Record<string, Uint8Array>;
  subrs?: Uint8Array[];
  /** Codes to names; StandardEncoding when absent. */
  encoding?: Record<number, string>;
  fontMatrix?: string;
  lenIV?: number;
  /** Spellings of RD, ND and NP. */
  tokens?: [string, string, string];
  hex?: boolean;
}

/** Write a Type 1 font: [cleartext, encrypted part, trailer]. */
export function writeType1(s: Type1Spec): [Uint8Array, Uint8Array, Uint8Array] {
  const [RD, ND, NP] = s.tokens ?? ['RD', 'ND', 'NP'];
  const lenIV = s.lenIV ?? 4;
  const cs = (b: Uint8Array): Uint8Array => (lenIV < 0 ? b : encrypt(b, 4330, lenIV));
  const enc = s.encoding
    ? `/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n${Object.entries(s.encoding)
        .map(([c, n]) => `dup ${c} /${n} put`)
        .join('\n')}\nreadonly def\n`
    : '/Encoding StandardEncoding def\n';
  const clear = bytes(
    `%!PS-AdobeFont-1.0: Test 001\n12 dict begin\n/FontName /Test def\n/PaintType 0 def\n/FontType 1 def\n` +
      `/FontMatrix ${s.fontMatrix ?? '[0.001 0 0 0.001 0 0]'} readonly def\n${enc}/FontBBox {0 0 1000 1000} readonly def\n` +
      `currentdict end\ncurrentfile eexec\n`,
  );
  const parts: (string | Uint8Array)[] = [
    `dup /Private 8 dict dup begin\n/${RD}{string currentfile exch readstring pop}executeonly def\n/${ND}{noaccess def}executeonly def\n` +
      `/${NP}{noaccess put}executeonly def\n/BlueValues [] def\n/lenIV ${lenIV} def\n/MinFeature {16 16} def\n/password 5839 def\n`,
  ];
  if (s.subrs) {
    parts.push(`/Subrs ${s.subrs.length} array\n`);
    s.subrs.forEach((b, i) => {
      const e = cs(b);
      parts.push(`dup ${i} ${e.length} ${RD} `, e, ` ${NP}\n`);
    });
    parts.push(`${ND}\n`);
  }
  const names = Object.keys(s.glyphs);
  parts.push(`2 index /CharStrings ${names.length} dict dup begin\n`);
  for (const n of names) {
    const e = cs(s.glyphs[n]);
    parts.push(`/${n} ${e.length} ${RD} `, e, ` ${ND}\n`);
  }
  parts.push('end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n');
  let secret = encrypt(concatBytes(parts), 55665);
  if (s.hex) secret = bytes(Array.from(secret, (b, i) => b.toString(16).padStart(2, '0') + (i % 32 === 31 ? '\n' : '')).join(''));
  return [clear, secret, bytes(`\n${'0'.repeat(64)}\n`.repeat(8) + 'cleartomark\n')];
}

/** Wrap Type 1 parts as PFB segments. */
export function pfb(clear: Uint8Array, secret: Uint8Array, trailer: Uint8Array): Uint8Array {
  const seg = (type: number, b: Uint8Array): Uint8Array => concatBytes([new Uint8Array([0x80, type, b.length & 255, (b.length >> 8) & 255, (b.length >> 16) & 255, b.length >>> 24]), b]);
  return concatBytes([seg(1, clear), seg(2, secret), seg(1, trailer), new Uint8Array([0x80, 3])]);
}

/** AFM character metrics: name -> [code, width, bbox]. */
export function readAfm(path: string): Map<string, { code: number; wx: number; bbox: number[] }> | undefined {
  if (!existsSync(path)) return undefined;
  const m = new Map<string, { code: number; wx: number; bbox: number[] }>();
  for (const x of readFileSync(path, 'latin1').matchAll(/^C (-?\d+) ; WX (-?\d+) ; N (\S+) ; B (-?\d+) (-?\d+) (-?\d+) (-?\d+)/gm)) {
    m.set(x[3], { code: +x[1], wx: +x[2], bbox: [+x[4], +x[5], +x[6], +x[7]] });
  }
  return m;
}
