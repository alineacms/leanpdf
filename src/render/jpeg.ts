/**
 * A JPEG decoder (baseline, extended and progressive Huffman-coded, 8 or 12 bits) for the images
 * browsers get wrong in PDFs: CMYK, which browsers always read as Adobe-inverted while PDF leaves
 * that to /Decode, and JPEGs they refuse. Decodes at 1/1, 1/2, 1/4 or 1/8 scale straight from
 * the DCT coefficients, so a large image drawn small costs little more than its entropy decoding.
 */

export interface Jpeg {
  /** Size at the scale decoded. */
  width: number;
  height: number;
  /** Components per pixel: 1 gray, 3 RGB, 4 CMYK (YCbCr and YCCK are converted). */
  components: number;
  /** Interleaved 8-bit samples, as stored (CMYK is not inverted). */
  data: Uint8Array;
}

/** Zigzag position to natural (row-major) position. */
const ZZ = /* @__PURE__ */ Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43,
  36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** Coefficients kept for progressive images (2 bytes each). */
const MAX_COEFFICIENTS = 1 << 26;
const MAX_PIXELS = 1 << 28;

interface Huffman {
  /** Codes of up to 9 bits by their next 9 bits: length << 8 | value, 0 when longer. */
  fast: Uint16Array;
  maxcode: Int32Array;
  offset: Int32Array;
  values: Uint8Array;
}

function huffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const fast = new Uint16Array(512);
  const maxcode = new Int32Array(17).fill(-1);
  const offset = new Int32Array(17);
  for (let len = 1, code = 0, k = 0; len <= 16; len++, code <<= 1) {
    offset[len] = k - code;
    for (let i = 0; i < counts[len - 1]; i++, k++, code++) {
      if (len <= 9) fast.fill((len << 8) | values[k], code << (9 - len), (code + 1) << (9 - len));
    }
    if (counts[len - 1]) maxcode[len] = code - 1;
  }
  return { fast, maxcode, offset, values };
}

/** Entropy-coded data: bits past the end or a marker read as zeros. */
class Bits {
  private readonly d: Uint8Array;
  pos: number;
  private buf = 0;
  private n = 0;
  /** Position of the marker that ended the data, or -1. */
  marker = -1;

  constructor(d: Uint8Array, pos: number) {
    this.d = d;
    this.pos = pos;
  }

  private fill(): void {
    const d = this.d;
    while (this.n <= 24) {
      let b = 0;
      if (this.marker < 0 && this.pos < d.length) {
        b = d[this.pos];
        if (b !== 0xff) this.pos++;
        else if (d[this.pos + 1] === 0) this.pos += 2;
        else {
          this.marker = this.pos;
          b = 0;
        }
      }
      this.buf = ((this.buf << 8) | b) >>> 0;
      this.n += 8;
    }
  }

  bits(k: number): number {
    if (this.n < k) this.fill();
    this.n -= k;
    return (this.buf >>> this.n) & ((1 << k) - 1);
  }

  /** A k-bit magnitude category value as a signed number (JPEG F.2.2.1 EXTEND). */
  extend(k: number): number {
    if (!k) return 0;
    const v = this.bits(k);
    return v < 1 << (k - 1) ? v - (1 << k) + 1 : v;
  }

  huff(h: Huffman): number {
    if (this.n < 16) this.fill();
    const f = h.fast[(this.buf >>> (this.n - 9)) & 511];
    if (f) {
      this.n -= f >> 8;
      return f & 255;
    }
    let code = this.bits(9);
    for (let len = 10; len <= 16; len++) {
      code = (code << 1) | this.bits(1);
      if (code <= h.maxcode[len]) return h.values[h.offset[len] + code];
    }
    // Not a code: corrupt data reads as an end of block.
    return 0;
  }

  /** Skip to just past the next restart marker. */
  restart(): void {
    const d = this.d;
    let p = this.marker >= 0 ? this.marker : this.pos;
    while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7)) p++;
    this.pos = p + 2;
    this.marker = -1;
    this.buf = this.n = 0;
  }

  /** Position of the marker after the scan. */
  next(): number {
    const d = this.d;
    let p = this.marker >= 0 ? this.marker : this.pos;
    while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] !== 0 && d[p + 1] !== 0xff && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7))) p++;
    return p;
  }
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks per line and column holding data, and as padded to whole MCUs (the storage). */
  bw: number;
  bh: number;
  bpl: number;
  bpc: number;
  /** Progressive only: coefficients of every block, 64 per block. */
  coefs?: Int16Array;
  /** Samples per block, across and down: subsampled components are decoded larger when reduced. */
  nx: number;
  ny: number;
  /** The samples, bpl * nx wide. */
  plane: Uint8ClampedArray;
  pred: number;
  dc?: Huffman;
  ac?: Huffman;
}

interface Frame {
  width: number;
  height: number;
  precision: number;
  progressive: boolean;
  comps: Component[];
  mcusX: number;
  mcusY: number;
  hmax: number;
  vmax: number;
}

const C1 = Math.cos(Math.PI / 16) / 2;
const C2 = Math.cos((2 * Math.PI) / 16) / 2;
const C3 = Math.cos((3 * Math.PI) / 16) / 2;
const C4 = Math.cos((4 * Math.PI) / 16) / 2;
const C5 = Math.cos((5 * Math.PI) / 16) / 2;
const C6 = Math.cos((6 * Math.PI) / 16) / 2;
const C7 = Math.cos((7 * Math.PI) / 16) / 2;
const A0 = Math.SQRT1_2 / 2;

/** 8-point inverse DCT of s[o + k * st], k = 0..7, into d[q + x * dt] (even/odd decomposition). */
function idct8(s: Float32Array, o: number, st: number, d: Float32Array, q: number, dt: number): void {
  const f0 = s[o];
  const f1 = s[o + st];
  const f2 = s[o + 2 * st];
  const f3 = s[o + 3 * st];
  const f4 = s[o + 4 * st];
  const f5 = s[o + 5 * st];
  const f6 = s[o + 6 * st];
  const f7 = s[o + 7 * st];
  const ee0 = A0 * f0 + C4 * f4;
  const ee1 = A0 * f0 - C4 * f4;
  const eo0 = C2 * f2 + C6 * f6;
  const eo1 = C6 * f2 - C2 * f6;
  const e0 = ee0 + eo0;
  const e3 = ee0 - eo0;
  const e1 = ee1 + eo1;
  const e2 = ee1 - eo1;
  const o0 = C1 * f1 + C3 * f3 + C5 * f5 + C7 * f7;
  const o1 = C3 * f1 - C7 * f3 - C1 * f5 - C5 * f7;
  const o2 = C5 * f1 - C1 * f3 + C7 * f5 + C3 * f7;
  const o3 = C7 * f1 - C5 * f3 + C3 * f5 - C1 * f7;
  d[q] = e0 + o0;
  d[q + 7 * dt] = e0 - o0;
  d[q + dt] = e1 + o1;
  d[q + 6 * dt] = e1 - o1;
  d[q + 2 * dt] = e2 + o2;
  d[q + 5 * dt] = e2 - o2;
  d[q + 3 * dt] = e3 + o3;
  d[q + 4 * dt] = e3 - o3;
}

const F = /* @__PURE__ */ new Float32Array(64);
const T = /* @__PURE__ */ new Float32Array(64);

/**
 * Dequantize and inverse-transform one block into `c.plane` at block (bx, by), as nx x ny samples:
 * averages of the full 8 x 8, so a reduced decode matches decoding in full and box-filtering.
 */
function idctBlock(co: Int16Array, off: number, q: Int32Array, c: Component, bx: number, by: number, precision: number, ac?: boolean): void {
  const { plane, nx, ny } = c;
  const pw = c.bpl * nx;
  let p = by * ny * pw + bx * nx;
  // 12-bit samples are scaled down to 8.
  const shift = precision === 12 ? 2048 : 128;
  const out = precision === 12 ? 1 / 16 : 1;
  if (ac === undefined) {
    let any = 0;
    for (let k = 1; k < 64; k++) any |= co[off + k];
    ac = any !== 0;
  }
  if (!ac || nx * ny === 1) {
    // Flat, or reduced to one sample: the AC terms average out.
    const val = ((co[off] * q[0]) / 8 + shift) * out;
    for (let y = 0; y < ny; y++, p += pw) for (let x = 0; x < nx; x++) plane[p + x] = val;
    return;
  }
  for (let k = 0; k < 64; k++) F[k] = co[off + k] * q[k];
  for (let v = 0; v < 8; v++) idct8(F, v * 8, 1, T, v * 8, 1);
  for (let x = 0; x < 8; x++) idct8(T, x, 8, F, x, 8);
  const sx = 8 / nx;
  const sy = 8 / ny;
  const scale = out / (sx * sy);
  for (let y = 0; y < ny; y++, p += pw) {
    for (let x = 0; x < nx; x++) {
      let sum = 0;
      for (let j = y * sy; j < y * sy + sy; j++) for (let i = x * sx; i < x * sx + sx; i++) sum += F[j * 8 + i];
      plane[p + x] = sum * scale + shift * out;
    }
  }
}

/** Decode one scan starting at `pos`; returns the position of the marker after it. */
function decodeScan(d: Uint8Array, pos: number, fr: Frame, comps: Component[], ss: number, se: number, ah: number, al: number, restart: number, qt: Int32Array[]): number {
  const r = new Bits(d, pos);
  const single = comps.length === 1;
  const mcus = single ? comps[0].bw * comps[0].bh : fr.mcusX * fr.mcusY;
  let eobrun = 0;
  // Decodes a block's coefficients; sequential ones say whether there are AC coefficients.
  let block: (c: Component, co: Int16Array, off: number) => boolean | void;
  const p1 = 1 << al;
  const m1 = -1 << al;
  const refine = (co: Int16Array, z: number) => {
    if (r.bits(1) && (co[z] & p1) === 0) co[z] += co[z] >= 0 ? p1 : m1;
  };
  if (!fr.progressive) {
    block = (c, co, off) => {
      c.pred += r.extend(r.huff(c.dc!));
      co[off] = c.pred;
      let ac = false;
      for (let k = 1; k < 64; ) {
        const rs = r.huff(c.ac!);
        const s = rs & 15;
        if (!s) {
          if (rs >> 4 < 15) break;
          k += 16;
          continue;
        }
        k += rs >> 4;
        if (k > 63) break;
        co[off + ZZ[k]] = r.extend(s);
        ac = true;
        k++;
      }
      return ac;
    };
  } else if (ss === 0) {
    block = ah
      ? (_, co, off) => {
          if (r.bits(1)) co[off] |= p1;
        }
      : (c, co, off) => {
          c.pred += r.extend(r.huff(c.dc!));
          co[off] = c.pred * p1;
        };
  } else if (!ah) {
    block = (c, co, off) => {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      for (let k = ss; k <= se; ) {
        const rs = r.huff(c.ac!);
        const s = rs & 15;
        const rr = rs >> 4;
        if (!s) {
          if (rr < 15) {
            eobrun = (1 << rr) - 1 + (rr ? r.bits(rr) : 0);
            break;
          }
          k += 16;
          continue;
        }
        k += rr;
        if (k > 63) break;
        co[off + ZZ[k]] = r.extend(s) * p1;
        k++;
      }
    };
  } else {
    // Successive approximation of AC coefficients (G.1.2.3), as libjpeg's decode_mcu_AC_refine.
    block = (c, co, off) => {
      let k = ss;
      if (eobrun === 0) {
        for (; k <= se; k++) {
          const rs = r.huff(c.ac!);
          let rr = rs >> 4;
          let s = rs & 15;
          if (s) s = r.bits(1) ? p1 : m1;
          else if (rr !== 15) {
            eobrun = (1 << rr) + (rr ? r.bits(rr) : 0);
            break;
          }
          do {
            const z = off + ZZ[k];
            if (co[z] !== 0) refine(co, z);
            else if (--rr < 0) break;
            k++;
          } while (k <= se);
          if (s && k <= se) co[off + ZZ[k]] = s;
        }
      }
      if (eobrun > 0) {
        for (; k <= se; k++) if (co[off + ZZ[k]] !== 0) refine(co, off + ZZ[k]);
        eobrun--;
      }
    };
  }
  const scratch = fr.progressive ? undefined : new Int16Array(64);
  const doBlock = (c: Component, bx: number, by: number) => {
    if (scratch) {
      const ac = block(c, scratch, 0) === true;
      idctBlock(scratch, 0, qt[c.tq], c, bx, by, fr.precision, ac);
      if (ac) scratch.fill(0);
    } else block(c, c.coefs!, (by * c.bpl + bx) * 64);
  };
  for (const c of comps) c.pred = 0;
  for (let mcu = 0, left = restart || mcus; mcu < mcus; mcu++) {
    if (left-- === 0) {
      r.restart();
      eobrun = 0;
      for (const c of comps) c.pred = 0;
      left = restart - 1;
    }
    if (single) {
      const c = comps[0];
      doBlock(c, mcu % c.bw, Math.floor(mcu / c.bw));
    } else {
      const mx = mcu % fr.mcusX;
      const my = Math.floor(mcu / fr.mcusX);
      for (const c of comps) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) doBlock(c, mx * c.h + h, my * c.v + v);
    }
  }
  return r.next();
}

/**
 * Decode a JPEG at 1 / 2^reduce of its size (reduce 0-3). `colorTransform` is PDF's DCTDecode
 * /ColorTransform, which an Adobe marker overrides. Null for what isn't supported (arithmetic
 * coding, lossless, hierarchical, a height given only by DNL) or broken data.
 */
export function decodeJpeg(d: Uint8Array, reduce = 0, colorTransform?: number): Jpeg | null {
  const n = 8 >> Math.min(3, Math.max(0, reduce | 0));
  if (d[0] !== 0xff || d[1] !== 0xd8) return null;
  const qt: Int32Array[] = [];
  const dc: Huffman[] = [];
  const ac: Huffman[] = [];
  let fr: Frame | undefined;
  let adobe = -1;
  let restart = 0;
  let pos = 2;
  try {
    while (pos + 1 < d.length) {
      if (d[pos] !== 0xff || d[pos + 1] === 0xff) {
        pos++;
        continue;
      }
      const m = d[pos + 1];
      pos += 2;
      if (m === 0xd9) break;
      if ((m >= 0xd0 && m <= 0xd8) || m === 0x01 || m === 0) continue;
      const len = (d[pos] << 8) | d[pos + 1];
      const seg = d.subarray(pos + 2, pos + len);
      pos += len;
      if (m === 0xdb) {
        for (let i = 0; i < seg.length; ) {
          const wide = seg[i] >> 4;
          const t = (qt[seg[i++] & 3] = new Int32Array(64));
          for (let k = 0; k < 64; k++, i += wide ? 2 : 1) t[ZZ[k]] = wide ? (seg[i] << 8) | seg[i + 1] : seg[i];
        }
      } else if (m === 0xc4) {
        for (let i = 0; i + 17 <= seg.length; ) {
          const counts = seg.subarray(i + 1, i + 17);
          let total = 0;
          for (const c of counts) total += c;
          (seg[i] >> 4 ? ac : dc)[seg[i] & 3] = huffman(counts, seg.subarray(i + 17, i + 17 + total));
          i += 17 + total;
        }
      } else if (m === 0xdd) restart = (seg[0] << 8) | seg[1];
      else if (m === 0xee && seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') adobe = seg[11];
      else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        const precision = seg[0];
        const height = (seg[1] << 8) | seg[2];
        const width = (seg[3] << 8) | seg[4];
        const nc = seg[5];
        if (fr || (precision !== 8 && precision !== 12) || !height || !width || width * height > MAX_PIXELS || ![1, 3, 4].includes(nc)) return null;
        const raw = Array.from({ length: nc }, (_, i) => ({ id: seg[6 + 3 * i], h: seg[7 + 3 * i] >> 4, v: seg[7 + 3 * i] & 15, tq: seg[8 + 3 * i] & 3 }));
        if (raw.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4)) return null;
        const hmax = Math.max(...raw.map((c) => c.h));
        const vmax = Math.max(...raw.map((c) => c.v));
        const mcusX = Math.ceil(width / (8 * hmax));
        const mcusY = Math.ceil(height / (8 * vmax));
        const progressive = m === 0xc2;
        let coefficients = 0;
        const comps = raw.map((c): Component => {
          const bpl = mcusX * c.h;
          const bpc = mcusY * c.v;
          coefficients += bpl * bpc * 64;
          // Reduced, a subsampled component is decoded less reduced instead of upsampled.
          const nx = Math.min(8, (n * hmax) / c.h);
          const ny = Math.min(8, (n * vmax) / c.v);
          return {
            ...c,
            nx: 8 % nx ? n : nx,
            ny: 8 % ny ? n : ny,
            bw: Math.ceil(Math.ceil((width * c.h) / hmax) / 8),
            bh: Math.ceil(Math.ceil((height * c.v) / vmax) / 8),
            bpl,
            bpc,
            plane: new Uint8ClampedArray(0),
            pred: 0,
          };
        });
        for (const c of comps) c.plane = new Uint8ClampedArray(c.bpl * c.nx * c.bpc * c.ny);
        if (progressive) {
          if (coefficients > MAX_COEFFICIENTS) return null;
          for (const c of comps) c.coefs = new Int16Array(c.bpl * c.bpc * 64);
        }
        fr = { width, height, precision, progressive, comps, mcusX, mcusY, hmax, vmax };
      } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null;
      else if (m === 0xda) {
        if (!fr) return null;
        const ns = seg[0];
        const comps: Component[] = [];
        for (let i = 0; i < ns; i++) {
          const c = fr.comps.find((x) => x.id === seg[1 + 2 * i]);
          if (!c) return null;
          c.dc = dc[seg[2 + 2 * i] >> 4];
          c.ac = ac[seg[2 + 2 * i] & 3];
          comps.push(c);
        }
        const k = 1 + 2 * ns;
        const ss = seg[k];
        const se = Math.min(63, seg[k + 1]);
        pos = decodeScan(d, pos, fr, comps, ss, se, seg[k + 2] >> 4, seg[k + 2] & 15, restart, qt);
      }
    }
    if (!fr) return null;
    if (fr.progressive) {
      for (const c of fr.comps) {
        const q = qt[c.tq];
        if (!q) return null;
        for (let by = 0; by < c.bpc; by++) for (let bx = 0; bx < c.bpl; bx++) idctBlock(c.coefs!, (by * c.bpl + bx) * 64, q, c, bx, by, fr.precision);
        c.coefs = undefined;
      }
    }
  } catch {
    return null;
  }
  return output(fr, n, adobe >= 0 ? adobe : colorTransform);
}

/** Sample positions and weights for upsampling a component by `ratio` (< 1), centered like libjpeg's fancy upsampling. */
function taps(count: number, ratio: number, size: number): [Int32Array, Int32Array, Float32Array] {
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const w = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = Math.min(size - 1, Math.max(0, (i + 0.5) * ratio - 0.5));
    a[i] = Math.floor(t);
    b[i] = Math.min(size - 1, a[i] + 1);
    w[i] = t - a[i];
  }
  return [a, b, w];
}

/** Interleave the planes at the output size, upsampling components and converting color. */
function output(fr: Frame, n: number, transform: number | undefined): Jpeg {
  const ow = Math.ceil((fr.width * n) / 8);
  const oh = Math.ceil((fr.height * n) / 8);
  const nc = fr.comps.length;
  const out = new Uint8ClampedArray(ow * oh * nc);
  fr.comps.forEach((c, i) => {
    const pw = c.bpl * c.nx;
    const p = c.plane;
    // Plane samples per output sample.
    const rx = (c.h * c.nx) / (fr.hmax * n);
    const ry = (c.v * c.ny) / (fr.vmax * n);
    if (rx === 1 && ry === 1) {
      for (let y = 0, j = i; y < oh; y++) for (let x = 0, k = y * pw; x < ow; x++, j += nc) out[j] = p[k + x];
      return;
    }
    // Subsampled: interpolated between the nearest samples.
    const [xa, xb, xw] = taps(ow, rx, pw);
    const [ya, yb, yw] = taps(oh, ry, c.bpc * c.ny);
    for (let y = 0, j = i; y < oh; y++) {
      const ra = ya[y] * pw;
      const rb = yb[y] * pw;
      const wy = yw[y];
      for (let x = 0; x < ow; x++, j += nc) {
        const top = p[ra + xa[x]] + (p[ra + xb[x]] - p[ra + xa[x]]) * xw[x];
        const bottom = p[rb + xa[x]] + (p[rb + xb[x]] - p[rb + xa[x]]) * xw[x];
        out[j] = top + (bottom - top) * wy;
      }
    }
  });
  // Without an Adobe marker or /ColorTransform: YCbCr for three components not named R, G, B.
  transform ??= nc === 3 && fr.comps.map((c) => c.id).join() !== '82,71,66' ? 1 : 0;
  if ((nc === 3 && transform === 1) || (nc === 4 && transform === 2)) {
    for (let i = 0; i < out.length; i += nc) {
      const y = out[i];
      const cb = out[i + 1] - 128;
      const cr = out[i + 2] - 128;
      const r = y + 1.402 * cr;
      const g = y - 0.344136 * cb - 0.714136 * cr;
      const b = y + 1.772 * cb;
      // YCCK holds the inverse of C, M, Y as YCbCr.
      out[i] = nc === 4 ? 255 - r : r;
      out[i + 1] = nc === 4 ? 255 - g : g;
      out[i + 2] = nc === 4 ? 255 - b : b;
    }
  }
  return { width: ow, height: oh, components: nc, data: new Uint8Array(out.buffer) };
}
