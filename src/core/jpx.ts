/**
 * JPEG 2000 decoding (ITU-T T.800 / ISO 15444-1, Part 1) for JPXDecode images: JP2 files and bare
 * codestreams. Tiles are decoded one at a time straight into the 8-bit output, so working memory
 * is the output plus one tile's coefficients. `reduce` drops the highest resolution levels
 * without decoding their code-blocks.
 */
import { idwt } from './jpx/dwt.ts';
import { segment, T1 } from './jpx/t1.ts';

export interface JpxOptions {
  /** Skip this many of the highest resolution levels: each halves the output size (rounding up). Decoding at reduced resolution skips the work for the discarded levels entirely. */
  reduce?: number;
  /** Refuse (return null) when the output would exceed this many pixels. Default 1 << 28. */
  maxPixels?: number;
}

export interface JpxImage {
  /** Size of the output (after `reduce`). */
  width: number;
  height: number;
  /** Samples per pixel after palette expansion: 1, 3 or 4 (plus an alpha channel if present, see `alpha`). */
  components: number;
  /** Interleaved 8-bit samples, width * height * components. Higher bit depths are scaled to 8 bits; signed components are shifted to unsigned. */
  data: Uint8Array;
  /** The colour space from the JP2 header (colr box), when there is one. YCbCr/sYCC data is already converted to RGB, as is data using the multiple component transform (RCT/ICT). */
  colorSpace?: 'gray' | 'rgb' | 'cmyk';
  /** Index of an opacity channel (JP2 cdef box), if any; PDF's /SMaskInData uses it. */
  alpha?: number;
  /** Number of resolution levels available in the codestream (for choosing `reduce`). */
  levels: number;
}

export interface JpxInfo {
  width: number;
  height: number;
  components: number;
  levels: number;
  bitsPerComponent: number;
  colorSpace?: 'gray' | 'rgb' | 'cmyk';
}

// Limits against hostile input: they are far beyond anything real images use.
const MAX_COMPONENTS = 256;
const MAX_BLOCKS = 1 << 22; // code-blocks per tile
const MAX_PRECINCTS = 1 << 20; // per tile
const MAX_PACKETS = 1 << 24; // packet visits per tile, skipped ones included

// ---------------------------------------------------------------------------------------------
// Headers

/** COD/COC coding style of one component. */
interface Coc {
  levels: number;
  xcb: number;
  ycb: number;
  style: number;
  rev: boolean;
  /** PPx | PPy << 4 per resolution level; null: maximal (2^15) precincts. */
  pp: Uint8Array | null;
}

interface Cod extends Coc {
  sop: boolean;
  eph: boolean;
  order: number;
  layers: number;
  mct: number;
}

/** QCD/QCC: quantization style (0 none, 1 scalar derived, 2 scalar expounded), guard bits, and exponent << 11 | mantissa per subband. */
interface Qcd {
  kind: number;
  guard: number;
  v: number[];
}

/** Main or tile header settings; COC, QCC and RGN by component. */
interface Params {
  cod?: Cod;
  coc: Coc[];
  qcd?: Qcd;
  qcc: Qcd[];
  rgn: number[];
  /** RSpoc, CSpoc, LYEpoc, REpoc, CEpoc, Ppoc per progression order change. */
  poc: number[][];
  /** Zppt and contents of the PPT markers. */
  ppt: [number, Uint8Array][];
}

interface Component {
  prec: number;
  sgnd: boolean;
  dx: number;
  dy: number;
}

interface Siz {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tw: number;
  th: number;
  tx0: number;
  ty0: number;
  ntx: number;
  nty: number;
  comps: Component[];
}

/** A tile-part: tile index, its header markers [h0, h1) and data [d0, d1), and index in the codestream. */
interface Part {
  t: number;
  h0: number;
  h1: number;
  d0: number;
  d1: number;
  i: number;
}

interface Header {
  siz: Siz;
  main: Params;
  parts: Part[];
  /** Packet headers from PPM markers, by tile-part index. */
  ppm: Uint8Array[] | null;
}

const EMPTY = new Uint8Array(0);
const u16 = (d: Uint8Array, p: number) => (d[p] << 8) | d[p + 1];
const u32 = (d: Uint8Array, p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const params = (): Params => ({ coc: [], qcc: [], rgn: [], poc: [], ppt: [] });
const bad = (): never => {
  throw new Error('JPX');
};

function cat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let n = 0;
  for (const p of parts) out.set(p, n), (n += p.length);
  return out;
}

function spcod(d: Uint8Array, q: number, precincts: number): Coc {
  const levels = d[q], xcb = (d[q + 1] & 15) + 2, ycb = (d[q + 2] & 15) + 2;
  // Beyond Part 1: HTJ2K's block coder (style bit 6), Part 2 wavelet kernels (transform > 1).
  if (levels > 32 || xcb > 10 || ycb > 10 || xcb + ycb > 12 || d[q + 3] & 0x40 || d[q + 4] > 1) bad();
  return { levels, xcb, ycb, style: d[q + 3], rev: d[q + 4] === 1, pp: precincts & 1 ? d.slice(q + 5, q + 6 + levels) : null };
}

function sqcd(d: Uint8Array, q: number, e: number): Qcd {
  const kind = d[q] & 31, v: number[] = [];
  if (kind > 2) bad();
  for (let i = q + 1; i < e; i += kind ? 2 : 1) v.push(kind ? u16(d, i) : (d[i] >> 3) << 11);
  return { kind, guard: d[q] >> 5, v };
}

/** Read marker segments from `p` up to SOT, SOD or `end`; returns where it stopped. */
function segments(d: Uint8Array, p: number, end: number, prm: Params, nc: number, ppm: [number, Uint8Array][] | null): number {
  const w = nc > 256 ? 2 : 1; // bytes in a component index
  const comp = (i: number) => (w > 1 ? u16(d, i) : d[i]);
  while (p + 4 <= end) {
    const m = u16(d, p), q = p + 4, e = p + 2 + u16(d, p + 2);
    if (m === 0xff90 || m === 0xff93 || m < 0xff00 || e < q || e > end) break;
    if (m === 0xff52) {
      prm.cod = { sop: !!(d[q] & 2), eph: !!(d[q] & 4), order: d[q + 1], layers: u16(d, q + 2), mct: d[q + 4], ...spcod(d, q + 5, d[q]) };
    } else if (m === 0xff53) prm.coc[comp(q)] = spcod(d, q + w + 1, d[q + w]);
    else if (m === 0xff5c) prm.qcd = sqcd(d, q, e);
    else if (m === 0xff5d) prm.qcc[comp(q)] = sqcd(d, q + w, e);
    else if (m === 0xff5e) prm.rgn[comp(q)] = d[q + w + 1];
    else if (m === 0xff5f) {
      for (let i = q; i + 5 + 2 * w <= e; i += 5 + 2 * w) {
        prm.poc.push([d[i], comp(i + 1), u16(d, i + 1 + w), d[i + 3 + w], comp(i + 4 + w) || (w > 1 ? 16384 : 256), d[i + 4 + 2 * w]]);
      }
    } else if (m === 0xff60) ppm?.push([d[q], d.subarray(q + 1, e)]);
    else if (m === 0xff61) prm.ppt.push([d[q], d.subarray(q + 1, e)]);
    p = e;
  }
  return p;
}

/** SIZ, the main header and (unless `headerOnly`) where each tile-part is. */
function readHeader(d: Uint8Array, s: number, end: number, headerOnly?: boolean): Header {
  if (u16(d, s) !== 0xff4f || u16(d, s + 2) !== 0xff51) bad();
  const lsiz = u16(d, s + 4), nc = u16(d, s + 40);
  const siz: Siz = {
    x1: u32(d, s + 8),
    y1: u32(d, s + 12),
    x0: u32(d, s + 16),
    y0: u32(d, s + 20),
    tw: u32(d, s + 24),
    th: u32(d, s + 28),
    tx0: u32(d, s + 32),
    ty0: u32(d, s + 36),
    ntx: 0,
    nty: 0,
    comps: [],
  };
  if (!nc || nc > MAX_COMPONENTS || lsiz < 38 + 3 * nc || s + 4 + lsiz > end) bad();
  for (let i = 0, q = s + 42; i < nc; i++, q += 3) {
    const prec = (d[q] & 0x7f) + 1;
    if (prec > 30 || !d[q + 1] || !d[q + 2]) bad();
    siz.comps.push({ prec, sgnd: d[q] > 127, dx: d[q + 1], dy: d[q + 2] });
  }
  const { x0, y0, x1, y1, tw, th, tx0, ty0 } = siz;
  if (x1 <= x0 || y1 <= y0 || !tw || !th || tx0 > x0 || ty0 > y0 || tx0 + tw <= x0 || ty0 + th <= y0) bad();
  siz.ntx = Math.ceil((x1 - tx0) / tw);
  siz.nty = Math.ceil((y1 - ty0) / th);
  if (siz.ntx * siz.nty > 65535) bad();
  const main = params(), ppmSegs: [number, Uint8Array][] = [];
  let p = segments(d, s + 4 + lsiz, end, main, nc, ppmSegs);
  const hd: Header = { siz, main, parts: [], ppm: null };
  if (headerOnly) return hd;
  if (ppmSegs.length) {
    // Nppm-prefixed packet headers of each tile-part in turn, possibly split across markers.
    const all = cat(ppmSegs.sort((a, b) => a[0] - b[0]).map((x) => x[1]));
    hd.ppm = [];
    for (let i = 0; i + 4 <= all.length; ) {
      const n = u32(all, i);
      hd.ppm.push(all.subarray(i + 4, i + 4 + n));
      i += 4 + n;
    }
  }
  for (let i = 0; p + 12 <= end && u16(d, p) === 0xff90; i++) {
    const psot = u32(d, p + 6), next = psot ? p + psot : end;
    if (psot && psot < 14) break;
    const h1 = segments(d, p + 12, Math.min(next, end), params(), nc, null);
    if (u16(d, h1) === 0xff93) {
      // Psot 0: the last tile-part, up to EOC.
      const d1 = Math.min(next, end) - (!psot && u16(d, end - 2) === 0xffd9 ? 2 : 0);
      hd.parts.push({ t: u16(d, p + 4), h0: p + 12, h1, d0: h1 + 2, d1: Math.max(d1, h1 + 2), i });
    }
    p = next;
  }
  return hd;
}

/** Colour and channel information from the JP2 boxes, and where the codestream is. */
interface Jp2 {
  s: number;
  e: number;
  /** colr: the enumerated colour space, -1 for an ICC profile. */
  cs?: number;
  /** pclr: bit depth (| 128 if signed) per column, then the entries column by column. */
  pal?: { bits: number[]; n: number; v: number[][] };
  /** cmap: component, mapping type (1: palette), palette column per channel. */
  cmap?: number[][];
  /** cdef: channel, type (0 colour, 1 opacity, 2 premultiplied opacity), association. */
  cdef?: number[][];
}

function readJp2(d: Uint8Array): Jp2 {
  if (u16(d, 0) === 0xff4f) return { s: 0, e: d.length };
  const j: Jp2 = { s: -1, e: 0 };
  const walk = (p: number, end: number) => {
    while (p + 8 <= end) {
      let len = u32(d, p), hl = 8;
      const type = u32(d, p + 4);
      if (len === 1) (len = u32(d, p + 8) * 2 ** 32 + u32(d, p + 12)), (hl = 16);
      else if (!len) len = end - p;
      if (len < hl) break;
      const q = p + hl, e = Math.min(p + len, end);
      if (type === 0x6a703268) walk(q, e); // jp2h
      else if (type === 0x636f6c72) j.cs ??= d[q] === 1 ? u32(d, q + 3) : -1;
      else if (type === 0x70636c72 && q + 3 <= e) {
        const cols = d[q + 2], bits: number[] = [], v: number[][] = [];
        let size = 0;
        for (let c = 0; c < cols; c++) bits.push(d[q + 3 + c]), v.push([]), (size += ((d[q + 3 + c] & 127) >> 3) + 1);
        // At most 1024 entries, and no more than the box holds.
        const n = Math.min(u16(d, q), 1024, Math.floor((e - q - 3 - cols) / size) || 0);
        for (let i = 0, at = q + 3 + cols; i < n; i++) {
          for (let c = 0; c < cols; c++) {
            let x = 0;
            for (let b = ((bits[c] & 127) >> 3) + 1; b--; ) x = x * 256 + d[at++];
            v[c].push(x);
          }
        }
        j.pal = { bits, n, v };
      } else if (type === 0x636d6170) {
        j.cmap = [];
        for (let i = q; i + 4 <= e; i += 4) j.cmap.push([u16(d, i), d[i + 2], d[i + 3]]);
      } else if (type === 0x63646566) {
        j.cdef = [];
        for (let i = 0, n = u16(d, q); i < n && q + 8 + 6 * i <= e; i++) j.cdef.push([u16(d, q + 2 + 6 * i), u16(d, q + 4 + 6 * i), u16(d, q + 6 + 6 * i)]);
      } else if (type === 0x6a703263 && j.s < 0) (j.s = q), (j.e = e); // jp2c
      p += len;
    }
  };
  walk(0, d.length);
  if (j.s < 0) {
    // Not a JP2 we understand: look for a codestream anywhere in the data.
    for (let i = d.indexOf(0xff); i >= 0 && i + 3 < d.length; i = d.indexOf(0xff, i + 1)) {
      if (d[i + 1] === 0x4f && d[i + 2] === 0xff && d[i + 3] === 0x51) return { ...j, s: i, e: d.length };
    }
    bad();
  }
  return j;
}

/** What each output channel is made of: codestream component, and palette column (8-bit) if any. */
interface Chan {
  c: number;
  pal: Uint8Array | null;
  bits: number;
}

interface Layout {
  chans: Chan[];
  alpha?: number;
  colorSpace?: 'gray' | 'rgb' | 'cmyk';
  /** 1: channels 0-2 are YCbCr; 2: YCCK (inverted afterwards). */
  ycc: number;
  levels: number;
}

function layout(j: Jp2, hd: Header): Layout {
  const { comps } = hd.siz, main = hd.main;
  let chans: Chan[] = comps.map((c, i) => ({ c: i, pal: null, bits: c.prec }));
  if (j.pal && j.cmap) {
    const { pal, cmap } = j;
    chans = cmap.map(([c, type, col]) => {
      if (c >= comps.length) bad();
      if (type !== 1 || col >= pal.bits.length) return { c, pal: null, bits: comps[c].prec };
      const bits = (pal.bits[col] & 127) + 1, max = 2 ** bits - 1, signed = pal.bits[col] > 127;
      return { c, pal: Uint8Array.from(pal.v[col], (x) => Math.round(((signed ? (x + 2 ** (bits - 1)) % 2 ** bits : x) * 255) / max)), bits };
    });
  }
  // cdef: colour channels in association order, then the rest (opacity) in channel order.
  let alpha: number | undefined;
  if (j.cdef) {
    const def = (i: number) => j.cdef!.find((x) => x[0] === i);
    const key = (i: number) => (def(i)?.[1] ? 2 ** 30 + i : (def(i)?.[2] || 65536) * 256 + i);
    const order = chans.map((_, i) => i).sort((a, b) => key(a) - key(b));
    const i = order.findIndex((c) => def(c)?.[1] === 1 || def(c)?.[1] === 2);
    if (i >= 0) alpha = i;
    chans = order.map((i) => chans[i]);
  }
  const n = chans.length - (alpha === undefined ? 0 : 1), e = j.cs;
  let colorSpace: Layout['colorSpace'], ycc = 0;
  if (e === 16 || e === 20 || e === 21) colorSpace = 'rgb';
  else if (e === 17) colorSpace = 'gray';
  else if (e === 12) colorSpace = 'cmyk';
  else if ((e === 18 || e === 1 || e === 3 || e === 4 || e === 24) && n >= 3) (colorSpace = 'rgb'), (ycc = 1);
  else if (e === 13 && n >= 4) (colorSpace = 'cmyk'), (ycc = 2);
  else if (e === -1) colorSpace = n === 1 ? 'gray' : n === 3 ? 'rgb' : n === 4 ? 'cmyk' : undefined;
  let levels = 33;
  for (let c = 0; c < comps.length; c++) levels = Math.min(levels, (main.coc[c] ?? main.cod ?? bad()).levels + 1);
  return { chans, alpha, colorSpace, ycc, levels };
}

// ---------------------------------------------------------------------------------------------
// Tier 2: packets

/** Packet header bits: a 0xFF byte is followed by one holding only 7 bits. */
class Bits {
  d: Uint8Array;
  e: number;
  p = 0;
  b = 0;
  n = 0;
  constructor(d: Uint8Array) {
    this.d = d;
    this.e = d.length;
  }
  /**
   * Ones past the end (they end tag tree and length loops soonest), where `p` keeps counting:
   * `p > e` means the data ran out.
   */
  bit(): number {
    if (!this.n) {
      this.n = this.b === 0xff ? 7 : 8;
      this.b = this.p < this.e ? this.d[this.p] : 0x7f;
      this.p++;
    }
    return (this.b >> --this.n) & 1;
  }
  bits(k: number): number {
    let v = 0;
    while (k--) v = v * 2 + this.bit();
    return v;
  }
  /** End of a packet header: skip the stuffed byte after a final 0xFF. */
  align(): void {
    if (this.b === 0xff) this.p++;
    this.b = this.n = 0;
  }
}

const STACK = /* @__PURE__ */ new Int32Array(64);

/** Tag tree (B.10.2) over a grid of code-blocks: each node's value is the minimum of its children's. */
class TagTree {
  v: Int32Array;
  lo: Int32Array;
  up: Int32Array;
  constructor(w: number, h: number) {
    const dims: number[] = [];
    let n = 0;
    for (let lw = w, lh = h; ; lw = (lw + 1) >> 1, lh = (lh + 1) >> 1) {
      dims.push(n, lw, lh);
      n += lw * lh;
      if (lw * lh === 1) break;
    }
    this.up = new Int32Array(n).fill(-1);
    for (let l = 0; l + 3 < dims.length; l += 3) {
      const [o, lw, lh] = dims.slice(l, l + 3), [po, pw] = dims.slice(l + 3, l + 5);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) this.up[o + y * lw + x] = po + (y >> 1) * pw + (x >> 1);
    }
    this.v = new Int32Array(n).fill(0x7fffffff);
    this.lo = new Int32Array(n);
  }
  /** Read toward leaf `i`'s value until it is known or reaches `thr`; 1 if it is below `thr`. */
  decode(b: Bits, i: number, thr: number): number {
    const { v, lo } = this;
    let n = 0;
    for (let j = i; j >= 0; j = this.up[j]) STACK[n++] = j;
    for (let low = 0; n--; ) {
      const j = STACK[n];
      if (low > lo[j]) lo[j] = low;
      else low = lo[j];
      while (low < thr && low < v[j]) {
        if (b.bit()) v[j] = low;
        else low++;
      }
      lo[j] = low;
    }
    return v[i] < thr ? 1 : 0;
  }
}

/** A code-block: zero bit-planes, Lblock, coding passes so far, and [offset, length, segment] per contribution. */
interface Blk {
  z: number;
  lb: number;
  n: number;
  ch: number[];
}

interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Tier-1 orientation: 0 LL and LH, 1 HL, 2 HH. */
  o: number;
  /** Position in the component's coefficient buffer. */
  ox: number;
  oy: number;
  xcb: number;
  ycb: number;
  /** Code-block grid: first index and count across and down. */
  bx0: number;
  by0: number;
  nbx: number;
  nby: number;
  blocks: (Blk | undefined)[];
  /** Magnitude bit-planes, ROI shift included. */
  mb: number;
  /** Half the quantization step (coefficients carry one fractional bit); 0 if reversible. */
  step: number;
}

/** The code-blocks of a precinct in one band, and its tag trees. */
interface PrecBand {
  x0: number;
  y0: number;
  w: number;
  h: number;
  inc: TagTree | null;
  zb: TagTree | null;
}

interface Res {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ppx: number;
  ppy: number;
  px0: number;
  py0: number;
  npx: number;
  npy: number;
  bands: Band[];
  prec: PrecBand[][];
  /** Next layer per precinct. */
  nl: Uint16Array;
}

interface TileComp {
  dx: number;
  dy: number;
  prec: number;
  levels: number;
  /** Resolution levels skipped for `reduce`, and the highest one decoded. */
  red: number;
  R: number;
  rev: boolean;
  style: number;
  roi: number;
  res: Res[];
}

function makePrec(res: Res, k: number, r: number): PrecBand[] {
  const px = res.px0 + (k % res.npx), py = res.py0 + ((k / res.npx) | 0);
  const pw = 2 ** (res.ppx - (r ? 1 : 0)), ph = 2 ** (res.ppy - (r ? 1 : 0));
  return res.bands.map((b) => {
    const xs = Math.max(px * pw, b.x0), xe = Math.min((px + 1) * pw, b.x1), ys = Math.max(py * ph, b.y0), ye = Math.min((py + 1) * ph, b.y1);
    if (xe <= xs || ye <= ys) return { x0: 0, y0: 0, w: 0, h: 0, inc: null, zb: null };
    const x0 = Math.floor(xs / 2 ** b.xcb), y0 = Math.floor(ys / 2 ** b.ycb);
    const w = Math.ceil(xe / 2 ** b.xcb) - x0, h = Math.ceil(ye / 2 ** b.ycb) - y0;
    return { x0, y0, w, h, inc: new TagTree(w, h), zb: new TagTree(w, h) };
  });
}

/**
 * Visit the packets of one progression (B.12.1) in order; `emit` returns false to stop. The
 * position-driven orders visit precincts by where they start on the reference grid.
 */
function progress(comps: TileComp[], tx0: number, ty0: number, poc: number[], emit: (c: number, r: number, k: number, l: number) => boolean): boolean {
  const [rs, cs, le, re, ce, order] = poc;
  if (order < 2) {
    const n1 = order ? re : le, n2 = order ? le : re;
    for (let a = order ? rs : 0; a < n1; a++) {
      for (let b = order ? 0 : rs; b < n2; b++) {
        for (let c = cs; c < ce; c++) {
          const r = order ? a : b, res = comps[c].res[r];
          if (res) for (let k = 0; k < res.npx * res.npy; k++) if (!emit(c, r, k, order ? b : a)) return false;
        }
      }
    }
    return true;
  }
  if (order > 4) return false;
  // Sort keys: RPCL by r, y, x, c; PCRL by y, x, c, r; CPRL by c, y, x, r. Coordinates are below
  // 2^33, components below 2^8 and resolutions below 2^6, so two exact doubles hold them.
  let n = 0;
  for (let c = cs; c < ce; c++) for (let r = rs; r < re && r < comps[c].res.length; r++) n += comps[c].res[r].npx * comps[c].res[r].npy;
  const k1 = new Float64Array(n), k2 = new Float64Array(n), id = new Int32Array(3 * n);
  n = 0;
  for (let c = cs; c < ce; c++) {
    const comp = comps[c];
    for (let r = rs; r < re && r < comp.res.length; r++) {
      const res = comp.res[r], sx = comp.dx * 2 ** (res.ppx + comp.levels - r), sy = comp.dy * 2 ** (res.ppy + comp.levels - r);
      for (let k = 0; k < res.npx * res.npy; k++, n++) {
        const x = Math.max(tx0, (res.px0 + (k % res.npx)) * sx), y = Math.max(ty0, (res.py0 + ((k / res.npx) | 0)) * sy);
        k1[n] = order === 2 ? r * 2 ** 33 + y : order === 3 ? y : c * 2 ** 33 + y;
        k2[n] = order === 2 ? x * 256 + c : order === 3 ? (x * 256 + c) * 64 + r : x * 64 + r;
        (id[3 * n] = c), (id[3 * n + 1] = r), (id[3 * n + 2] = k);
      }
    }
  }
  const ord = new Uint32Array(n).map((_, i) => i).sort((a, b) => k1[a] - k1[b] || k2[a] - k2[b]);
  for (const i of ord) for (let l = 0; l < le; l++) if (!emit(id[3 * i], id[3 * i + 1], id[3 * i + 2], l)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Tiles

interface Img {
  d: Uint8Array;
  hd: Header;
  lay: Layout;
  reduce: number;
  /** Output origin, size and channel count. */
  ox: number;
  oy: number;
  w: number;
  h: number;
  nch: number;
  out: Uint8Array;
  outc: Uint8ClampedArray;
  t1: T1;
  bufs: Float32Array[];
}

function decodeTile(img: Img, t: number, parts: Part[]): void {
  const { d, hd, reduce } = img, { siz, main } = hd, nc = siz.comps.length;
  const tx = t % siz.ntx, ty = (t / siz.ntx) | 0;
  const tx0 = Math.max(siz.tx0 + tx * siz.tw, siz.x0), tx1 = Math.min(siz.tx0 + (tx + 1) * siz.tw, siz.x1);
  const ty0 = Math.max(siz.ty0 + ty * siz.th, siz.y0), ty1 = Math.min(siz.ty0 + (ty + 1) * siz.th, siz.y1);
  const tp = params();
  for (const p of parts) segments(d, p.h0, p.h1, tp, nc, null);
  const cod = tp.cod ?? main.cod ?? bad();
  let blocks = 0, precincts = 0;
  const comps = siz.comps.map((sc, c): TileComp => {
    const cc = tp.coc[c] ?? tp.cod ?? main.coc[c] ?? cod, qc = tp.qcc[c] ?? tp.qcd ?? main.qcc[c] ?? main.qcd ?? bad();
    const roi = Math.min(tp.rgn[c] ?? main.rgn[c] ?? 0, 30), L = cc.levels, red = Math.min(reduce, L);
    const tcx0 = Math.ceil(tx0 / sc.dx), tcx1 = Math.ceil(tx1 / sc.dx), tcy0 = Math.ceil(ty0 / sc.dy), tcy1 = Math.ceil(ty1 / sc.dy);
    const res: Res[] = [];
    for (let r = 0; r <= L; r++) {
      const s = 2 ** (L - r), x0 = Math.ceil(tcx0 / s), x1 = Math.ceil(tcx1 / s), y0 = Math.ceil(tcy0 / s), y1 = Math.ceil(tcy1 / s);
      const pp = cc.pp && r < cc.pp.length ? cc.pp[r] : 0xff, lift = r ? 1 : 0;
      const ppx = Math.max(pp & 15, lift), ppy = Math.max(pp >> 4, lift);
      const px0 = Math.floor(x0 / 2 ** ppx), py0 = Math.floor(y0 / 2 ** ppy);
      const npx = x1 > x0 ? Math.ceil(x1 / 2 ** ppx) - px0 : 0, npy = y1 > y0 ? Math.ceil(y1 / 2 ** ppy) - py0 : 0;
      const xcb = Math.min(cc.xcb, ppx - lift), ycb = Math.min(cc.ycb, ppy - lift), lo = res[r - 1];
      if ((precincts += npx * npy) > MAX_PRECINCTS) bad();
      const bands = (r ? [1, 2, 3] : [0]).map((b): Band => {
        const xo = b & 1, yo = b >> 1, sb = 2 ** (r ? L - r + 1 : L);
        const bx0 = Math.ceil((tcx0 - (xo * sb) / 2) / sb), bx1 = Math.ceil((tcx1 - (xo * sb) / 2) / sb);
        const by0 = Math.ceil((tcy0 - (yo * sb) / 2) / sb), by1 = Math.ceil((tcy1 - (yo * sb) / 2) / sb);
        const gx = Math.floor(bx0 / 2 ** xcb), gy = Math.floor(by0 / 2 ** ycb);
        const nbx = bx1 > bx0 ? Math.ceil(bx1 / 2 ** xcb) - gx : 0, nby = by1 > by0 ? Math.ceil(by1 / 2 ** ycb) - gy : 0;
        if ((blocks += nbx * nby) > MAX_BLOCKS) bad();
        // Quantization of subband b of resolution r; the derived style scales the LL's step (E.1.1.1).
        const i = r ? 3 * r - 3 + b : 0, q = qc.kind === 1 ? qc.v[0] - ((r ? r - 1 : 0) << 11) : (qc.v[i] ?? qc.v[qc.v.length - 1] ?? 0);
        const eps = q >> 11, gain = b === 3 ? 2 : b ? 1 : 0;
        return {
          x0: bx0,
          y0: by0,
          x1: bx1,
          y1: by1,
          o: b === 1 ? 1 : b === 3 ? 2 : 0,
          ox: xo ? lo.x1 - lo.x0 : 0,
          oy: yo ? lo.y1 - lo.y0 : 0,
          xcb,
          ycb,
          bx0: gx,
          by0: gy,
          nbx,
          nby,
          blocks: new Array(nbx * nby),
          mb: qc.guard + eps - 1 + roi,
          step: cc.rev ? 0 : (2 ** (sc.prec + gain - eps) * (1 + (q & 2047) / 2048)) / 2,
        };
      });
      res.push({ x0, y0, x1, y1, ppx, ppy, px0, py0, npx, npy, bands, prec: [], nl: new Uint16Array(npx * npy) });
    }
    return { dx: sc.dx, dy: sc.dy, prec: sc.prec, levels: L, red, R: L - red, rev: cc.rev, style: cc.style, roi, res };
  });

  // Packet data, and packet headers when they were moved to PPM or PPT markers.
  const body = cat(parts.map((p) => d.subarray(p.d0, p.d1)));
  const ppm = hd.ppm;
  const hdr = ppm ? cat(parts.map((p) => ppm[p.i] ?? EMPTY)) : tp.ppt.length ? cat(tp.ppt.sort((a, b) => a[0] - b[0]).map((x) => x[1])) : null;
  const bits = new Bits(hdr ?? body);
  const pBlk: Blk[] = [], pLen: number[] = [], pSeg: number[] = [];
  let bp = 0, visits = 0;
  const emit = (c: number, r: number, k: number, l: number): boolean => {
    const comp = comps[c], res = comp.res[r];
    if (++visits > MAX_PACKETS) return false;
    if (res.nl[k] !== l) return true;
    res.nl[k]++;
    if (hdr ? bits.p >= bits.e : bp >= body.length) return false;
    if (cod.sop && body[bp] === 0xff && body[bp + 1] === 0x91) bp += 6;
    if (!hdr) bits.p = bp;
    let np = 0;
    if (bits.bit()) {
      const prec = (res.prec[k] ??= makePrec(res, k, r));
      for (let b = 0; b < prec.length; b++) {
        const pb = prec[b], band = res.bands[b];
        for (let i = 0; i < pb.w * pb.h; i++) {
          const bi = (pb.y0 + ((i / pb.w) | 0) - band.by0) * band.nbx + pb.x0 + (i % pb.w) - band.bx0;
          let blk = band.blocks[bi];
          if (!blk) {
            // First inclusion: the inclusion tag tree says in which layer, then the zero bit-planes.
            if (!pb.inc!.decode(bits, i, l + 1)) continue;
            pb.zb!.decode(bits, i, 99);
            blk = band.blocks[bi] = { z: pb.zb!.v[i], lb: 3, n: 0, ch: [] };
          } else if (!bits.bit()) continue;
          // Number of new coding passes (Table B.4).
          let n = 1 + bits.bit();
          if (n > 1 && (n += bits.bit()) > 2 && (n += bits.bits(2)) === 6 && (n += bits.bits(5)) === 37) n += bits.bits(7);
          while (bits.bit()) if (++blk.lb > 32) return false;
          // One length per codeword segment the new passes touch.
          for (let kk = blk.n, e = kk + n; kk < e; ) {
            const s = segment(kk, comp.style);
            let m = 0;
            do m++;
            while (++kk < e && segment(kk, comp.style) === s);
            pBlk[np] = blk;
            pSeg[np] = s;
            pLen[np++] = bits.bits(blk.lb + 31 - Math.clz32(m));
          }
          blk.n += n;
        }
      }
    }
    bits.align();
    if (cod.eph && bits.d[bits.p] === 0xff && bits.d[bits.p + 1] === 0x92) bits.p += 2;
    if (bits.p > bits.e) return false;
    if (!hdr) bp = bits.p;
    for (let i = 0; i < np; i++) {
      const len = Math.min(pLen[i], body.length - bp);
      if (r <= comp.R) pBlk[i].ch.push(bp, len, pSeg[i]);
      bp += len;
    }
    return true;
  };
  try {
    const top = Math.max(...comps.map((c) => c.levels)) + 1;
    const pocs = (tp.poc.length ? tp.poc : main.poc).map((p) => [p[0], p[1], Math.min(p[2], cod.layers), Math.min(p[3], top), Math.min(p[4], nc), p[5]]);
    for (const poc of pocs.length ? pocs : [[0, 0, cod.layers, top, nc, cod.order]]) if (!progress(comps, tx0, ty0, poc, emit)) break;
  } catch {
    // Damaged packet headers: decode what arrived before.
  }

  // Tier 1, dequantization and the inverse wavelet transform, component by component.
  const bufs = comps.map((comp, c) => {
    const top = comp.res[comp.R], W = top.x1 - top.x0, n = W * (top.y1 - top.y0);
    // Reused from the previous tile (zeroed), or new (zero already).
    const buf = img.bufs[c]?.length >= n ? img.bufs[c].subarray(0, n).fill(0) : (img.bufs[c] = new Float32Array(n));
    for (let r = 0; r <= comp.R; r++) {
      for (const band of comp.res[r].bands) {
        const { blocks, xcb, ycb } = band;
        for (let i = 0; i < blocks.length; i++) {
          const blk = blocks[i];
          if (!blk?.ch.length) continue;
          const bx = band.bx0 + (i % band.nbx), by = band.by0 + ((i / band.nbx) | 0);
          const x0 = Math.max(bx * 2 ** xcb, band.x0), x1 = Math.min((bx + 1) * 2 ** xcb, band.x1);
          const y0 = Math.max(by * 2 ** ycb, band.y0), y1 = Math.min((by + 1) * 2 ** ycb, band.y1);
          const planes = Math.min(band.mb - blk.z, 29), w = x1 - x0, h = y1 - y0;
          if (planes < 1 || w < 1 || h < 1) continue;
          const v = img.t1.decode(body, blk.ch, blk.n, w, h, band.o, comp.style, planes);
          place(buf, (band.oy + y0 - band.y0) * W + band.ox + x0 - band.x0, W, v, w, h, band.step, comp.roi);
        }
      }
    }
    idwt(buf, W, comp.res.slice(0, comp.R + 1), comp.rev);
    return buf;
  });

  // Multiple component transform (Annex G) on the first three components, which must match.
  const [a0, a1, a2] = bufs, same = (c: TileComp) => c.dx === comps[0].dx && c.dy === comps[0].dy && c.red === comps[0].red;
  if (cod.mct === 1 && nc >= 3 && same(comps[1]) && same(comps[2])) {
    if (comps[0].rev) {
      for (let i = 0; i < a0.length; i++) {
        const y = a0[i], u = a1[i], v = a2[i], g = y - ((u + v) >> 2);
        (a0[i] = v + g), (a1[i] = g), (a2[i] = u + g);
      }
    } else {
      for (let i = 0; i < a0.length; i++) {
        const y = a0[i], u = a1[i], v = a2[i];
        (a0[i] = y + 1.402 * v), (a1[i] = y - 0.34413 * u - 0.71414 * v), (a2[i] = y + 1.772 * u);
      }
    }
  }
  writeTile(img, comps, bufs, tx0, ty0, tx1, ty1);
}

/**
 * Dequantize a decoded block into the coefficients at `o` (row stride `W`): `step` is half the
 * quantization step, 0 for reversible blocks, whose values just lose their fractional bit.
 */
function place(buf: Float32Array, o: number, W: number, v: Int32Array, w: number, h: number, step: number, roi: number): void {
  if (roi) {
    // Max-shift ROI: coefficients above the background range were scaled up (Annex H).
    const thr = 2 ** (roi + 1);
    for (let j = 0; j < w * h; j++) {
      const q = v[j];
      if ((q < 0 ? -q : q) >= thr) v[j] = q < 0 ? -(-q >> roi) : q >> roi;
    }
  }
  for (let y = 0, j = 0; y < h; y++, o += W - w) {
    if (step) for (let e = j + w; j < e; ) buf[o++] = v[j++] * step;
    else for (let e = j + w; j < e; j++) buf[o++] = (v[j] + (v[j] >>> 31)) >> 1;
  }
}

/** Level-shift, scale to 8 bits and interleave a decoded tile into the output. */
function writeTile(img: Img, comps: TileComp[], bufs: Float32Array[], tx0: number, ty0: number, tx1: number, ty1: number): void {
  const { out, outc, nch, lay } = img, f = 2 ** img.reduce;
  const X0 = Math.ceil(tx0 / f), X1 = Math.ceil(tx1 / f), Y0 = Math.ceil(ty0 / f), Y1 = Math.ceil(ty1 / f), tw = X1 - X0;
  if (tw < 1 || Y1 <= Y0) return;
  // Output pixel -> sample of each channel's component as decoded (subsampled, maybe less reduced).
  const chans = lay.chans.map(({ c, pal }) => {
    const comp = comps[c], top = comp.res[comp.R], W = top.x1 - top.x0, H = top.y1 - top.y0, s = 2 ** (img.reduce - comp.red);
    const map = new Int32Array(tw);
    for (let x = 0; x < tw; x++) map[x] = Math.min(Math.max(Math.floor(((X0 + x) * s) / comp.dx) - top.x0, 0), W - 1);
    return { a: bufs[c], pal, map, W, H, y0: top.y0, sy: s / comp.dy, shift: 2 ** (comp.prec - 1), scale: 255 / (2 ** comp.prec - 1) };
  });
  // Row by row, all channels, so each output row is written while it is in cache.
  for (let y = Y0; y < Y1; y++) {
    const o0 = ((y - img.oy) * img.w + X0 - img.ox) * nch;
    for (let ch = 0; ch < nch; ch++) {
      const { a, pal, map, W, H, y0, sy, shift, scale } = chans[ch];
      if (!W || !H) continue;
      const row = Math.min(Math.max(Math.floor(y * sy) - y0, 0), H - 1) * W;
      if (pal) {
        for (let x = 0, o = o0 + ch; x < tw; x++, o += nch) {
          const v = Math.round(a[row + map[x]] + shift);
          out[o] = pal[v < 0 ? 0 : v >= pal.length ? pal.length - 1 : v];
        }
      } else if (scale === 1) for (let x = 0, o = o0 + ch; x < tw; x++, o += nch) outc[o] = a[row + map[x]] + shift;
      // Other precisions: round to the component's own, then scale.
      else for (let x = 0, o = o0 + ch; x < tw; x++, o += nch) outc[o] = Math.round(a[row + map[x]] + shift) * scale;
    }
    if (lay.ycc) {
      // sYCC to RGB; YCCK to CMY (inverted RGB) and K.
      const inv = lay.ycc === 2 ? 255 : 0, sign = inv ? -1 : 1;
      for (let o = o0, e = o + tw * nch; o < e; o += nch) {
        const Y = out[o], cb = out[o + 1] - 128, cr = out[o + 2] - 128;
        outc[o] = inv + sign * (Y + 1.402 * cr);
        outc[o + 1] = inv + sign * (Y - 0.344136 * cb - 0.714136 * cr);
        outc[o + 2] = inv + sign * (Y + 1.772 * cb);
      }
    }
  }
}

/**
 * Decode a JPEG 2000 codestream (J2K) or JP2 file. Null when the data can't be decoded. Never
 * throws on bad data; damaged or truncated data gives what could be decoded before the damage.
 */
export function decodeJpx(data: Uint8Array, opts: JpxOptions = {}): JpxImage | null {
  try {
    const j = readJp2(data), hd = readHeader(data, j.s, j.e), lay = layout(j, hd), { siz } = hd;
    const reduce = Math.min(Math.max(opts.reduce ?? 0, 0), lay.levels - 1) | 0, f = 2 ** reduce;
    const ox = Math.ceil(siz.x0 / f), oy = Math.ceil(siz.y0 / f), w = Math.ceil(siz.x1 / f) - ox, h = Math.ceil(siz.y1 / f) - oy;
    const nch = lay.chans.length;
    if (w * h > (opts.maxPixels ?? 1 << 28) || !hd.parts.length) return null;
    const out = new Uint8Array(w * h * nch);
    const img: Img = { d: data, hd, lay, reduce, ox, oy, w, h, nch, out, outc: new Uint8ClampedArray(out.buffer), t1: new T1(), bufs: [] };
    const tiles: Part[][] = [];
    for (const p of hd.parts) if (p.t < siz.ntx * siz.nty) (tiles[p.t] ??= []).push(p);
    let done = 0;
    tiles.forEach((parts, t) => {
      try {
        decodeTile(img, t, parts);
        done++;
      } catch {
        // A tile we can't make sense of stays blank.
      }
    });
    return done ? { width: w, height: h, components: nch, data: out, colorSpace: lay.colorSpace, alpha: lay.alpha, levels: lay.levels } : null;
  } catch {
    return null;
  }
}

/** Header only (size, components, levels, colour space) without decoding: cheap, for choosing `reduce`. */
export function jpxInfo(data: Uint8Array): JpxInfo | null {
  try {
    const j = readJp2(data), hd = readHeader(data, j.s, j.e, true), lay = layout(j, hd), { siz } = hd;
    return {
      width: siz.x1 - siz.x0,
      height: siz.y1 - siz.y0,
      components: lay.chans.length,
      levels: lay.levels,
      bitsPerComponent: Math.max(...lay.chans.map((c) => c.bits)),
      colorSpace: lay.colorSpace,
    };
  } catch {
    return null;
  }
}
