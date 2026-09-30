/**
 * JPEG 2000 tier-1 (ITU-T T.800 Annexes C and D): the MQ arithmetic decoder and the significance
 * propagation, magnitude refinement and cleanup passes that rebuild a code-block's quantized
 * coefficients one bit-plane at a time.
 */

/** Code-block style flags (COD/COC SPcod). Predictable termination (16) needs nothing to decode. */
const BYPASS = 1;
const RESET = 2;
const TERMALL = 4;
const VCAUSAL = 8;
const SEGSYM = 32;

// Qe and the next state after an LPS for the 47 MQ states (Table C.2). After an MPS the next state
// is the following one, except where NMPS below says otherwise; states 0, 6 and 14 switch the MPS.
const QE = [
  0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521, 0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601, 0x5601, 0x5401, 0x5101,
  0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801, 0x1601, 0x1401, 0x1201, 0x1101, 0x0ac1, 0x09c1, 0x08a1, 0x0521,
  0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049, 0x0025, 0x0015, 0x0009, 0x0005, 0x0001, 0x5601,
];
const NLPS = [
  1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46,
];

// Per-sample flags: significance of the 8 neighbours, the sign of the 4 direct ones when they are
// significant and negative (bits 8-11: N S W E), then the sample's own state.
const N = 1, S = 2, W = 4, E = 8, NW = 16, NE = 32, SW = 64, SE = 128, NB = 255;
const SIG = 0x1000, VISIT = 0x2000, REF = 0x4000;
/** Vertically causal mode: the stripe below counts as insignificant for a stripe's last row. */
const CAUSAL = 0xffff & ~(S | SW | SE | (S << 8));

/**
 * Lookup tables, built once. Contexts are (state << 1) | MPS; qe, nm and nl index by that: Qe,
 * next context after an MPS, after an LPS. zc: zero-coding context per orientation (LL/LH, HL,
 * HH) and neighbour bits (Table D.1). sc: sign context | XOR bit << 5 per the N S W E
 * significance and sign bits (Table D.3).
 */
function tables() {
  const qe = new Uint16Array(94), nm = new Uint8Array(94), nl = new Uint8Array(94);
  for (let s = 0; s < 94; s++) {
    const i = s >> 1, m = s & 1;
    qe[s] = QE[i];
    nm[s] = ((i === 5 ? 38 : i === 13 ? 29 : i > 44 ? i : i + 1) << 1) | m;
    nl[s] = (NLPS[i] << 1) | (i === 0 || i === 6 || i === 14 ? m ^ 1 : m);
  }
  const zc = new Uint8Array(768);
  for (let f = 0; f < 256; f++) {
    const h = ((f >> 2) & 1) + ((f >> 3) & 1), v = (f & 1) + ((f >> 1) & 1);
    const d = ((f >> 4) & 1) + ((f >> 5) & 1) + ((f >> 6) & 1) + ((f >> 7) & 1);
    for (let o = 0; o < 2; o++) {
      // HL swaps the roles of the horizontal and vertical neighbours.
      const a = o ? v : h, b = o ? h : v;
      zc[(o << 8) | f] = a === 2 ? 8 : a ? (b ? 7 : d ? 6 : 5) : b ? b + 2 : d > 1 ? 2 : d;
    }
    const hv = h + v;
    zc[512 | f] = d > 2 ? 8 : d === 2 ? (hv ? 7 : 6) : d ? (hv > 1 ? 5 : hv + 3) : hv > 1 ? 2 : hv;
  }
  const sc = new Uint8Array(256);
  const sgn = (f: number, bit: number) => (f & bit ? (f & (bit << 4) ? -1 : 1) : 0);
  for (let f = 0; f < 256; f++) {
    let v = Math.sign(sgn(f, N) + sgn(f, S)), h = Math.sign(sgn(f, W) + sgn(f, E)), x = 0;
    if (h < 0 || (!h && v < 0)) (h = -h), (v = -v), (x = 32);
    sc[f] = (h ? 12 + v : 9 + v) | x;
  }
  return { qe, nm, nl, zc, sc };
}

const { qe: QE2, nm: NM, nl: NL, zc: ZC, sc: SC } = /* @__PURE__ */ tables();

/**
 * Codeword segment of coding pass `k` (0 = the first cleanup pass). Every pass ends one with
 * termination on each pass; in bypass mode the first 10 passes form one, then each raw
 * SP+MR pair and each cleanup pass.
 */
export function segment(k: number, style: number): number {
  return style & TERMALL ? k : style & BYPASS && k >= 10 ? 1 + ((((k - 10) * 2) / 3) | 0) : 0;
}

/** Decodes code-blocks one at a time, reusing its buffers. */
export class T1 {
  /** The codeword segment being decoded, followed by 0xFF 0xFF (reads as a marker: end of data). */
  private d = new Uint8Array(8192);
  private p = 0;
  private a = 0;
  private c = 0;
  private ct = 0;
  private cx = new Uint8Array(19);
  private fl = new Uint16Array(6156);
  /** Coefficients of the last block, row by row, signed, with one fractional bit (twice the value). */
  out = new Int32Array(4096);
  private w = 0;
  private h = 0;
  private sw = 0;
  private zo = 0;
  private vm = 0;

  /**
   * Decode a `w` x `h` block (at most 4096 samples) from `chunks` (offset in `src`, length and
   * codeword segment, per contribution) with `passes` coding passes over `planes` bit-planes.
   * `orient` is 0 for LL and LH subbands, 1 for HL, 2 for HH. Returns `out`.
   */
  decode(src: Uint8Array, chunks: number[], passes: number, w: number, h: number, orient: number, style: number, planes: number): Int32Array {
    const o = this.out, sw = w + 2;
    o.fill(0, 0, w * h);
    this.fl.fill(0, 0, sw * (h + 2));
    this.w = w;
    this.h = h;
    this.sw = sw;
    this.zo = orient << 8;
    this.vm = style & VCAUSAL ? CAUSAL : 0xffff;
    this.reset();
    passes = Math.min(passes, 3 * planes - 2);
    for (let k = 0, ci = 0; k < passes; ) {
      const seg = segment(k, style);
      let n = 0;
      for (; ci < chunks.length && chunks[ci + 2] <= seg; ci += 3) {
        if (chunks[ci + 2] < seg) continue;
        const part = src.subarray(chunks[ci], chunks[ci] + chunks[ci + 1]);
        if (this.d.length < n + part.length + 2) {
          const d = new Uint8Array((n + part.length) * 2 + 2);
          d.set(this.d.subarray(0, n));
          this.d = d;
        }
        this.d.set(part, n);
        n += part.length;
      }
      this.d[n] = this.d[n + 1] = 0xff;
      const raw = style & BYPASS && k >= 10 && k % 3 ? 1 : 0;
      this.p = this.c = this.ct = 0;
      if (!raw) {
        // INITDEC (C.3.5)
        this.c = this.d[0] << 16;
        this.byteIn();
        this.c <<= 7;
        this.ct -= 7;
        this.a = 0x8000;
      }
      do {
        const bp = planes - 1 - (((k + 2) / 3) | 0), t = k % 3;
        if (!t) {
          this.cleanup(bp);
          if (style & SEGSYM) for (let i = 0; i < 4; i++) this.mq(18);
        } else if (t === 1) this.sigProp(bp, raw);
        else this.refine(bp, raw);
        if (style & RESET) this.reset();
      } while (++k < passes && segment(k, style) === seg);
    }
    return o;
  }

  private reset(): void {
    const cx = this.cx;
    cx.fill(0);
    cx[0] = 8; // state 4
    cx[17] = 6; // run-length: state 3
    cx[18] = 92; // uniform: state 46
  }

  private byteIn(): void {
    const d = this.d, p = this.p;
    if (d[p] !== 0xff) {
      this.p = p + 1;
      this.c = (this.c + (d[p + 1] << 8)) | 0;
      this.ct = 8;
    } else if (d[p + 1] > 0x8f) {
      this.c = (this.c + 0xff00) | 0;
      this.ct = 8;
    } else {
      this.p = p + 1;
      this.c = (this.c + (d[p + 1] << 9)) | 0;
      this.ct = 7;
    }
  }

  /** DECODE (C.3.2) in context `i`. C is kept as an int32 holding the unsigned register. */
  private mq(i: number): number {
    const cx = this.cx, s = cx[i], qe = QE2[s];
    let a = this.a - qe, d = s & 1;
    if (this.c >>> 16 < qe) {
      if (a < qe) cx[i] = NM[s];
      else (d ^= 1), (cx[i] = NL[s]);
      a = qe;
    } else {
      this.c = (this.c - (qe << 16)) | 0;
      if (a & 0x8000) {
        this.a = a;
        return d;
      }
      if (a < qe) (d ^= 1), (cx[i] = NL[s]);
      else cx[i] = NM[s];
    }
    do {
      if (!this.ct) this.byteIn();
      a <<= 1;
      this.c <<= 1;
      this.ct--;
    } while (!(a & 0x8000));
    this.a = a;
    return d;
  }

  /** One bit of a raw (bypass) segment, with the bit stuffed after 0xFF skipped. */
  private raw(): number {
    if (!this.ct) {
      const b = this.d[this.p];
      if (this.c !== 0xff) (this.c = b), this.p++, (this.ct = 8);
      else if (b <= 0x8f) (this.c = b), this.p++, (this.ct = 7);
      else this.ct = 8;
    }
    return (this.c >> --this.ct) & 1;
  }

  private sign(f: number): number {
    const t = SC[(f & 15) | ((f >> 4) & 0xf0)];
    return this.mq(t & 31) ^ (t >> 5);
  }

  /** Mark flag index `i` significant and tell its neighbours. */
  private set(i: number, neg: number): void {
    const fl = this.fl, sw = this.sw;
    fl[i] |= SIG;
    fl[i - sw] |= S | (neg << 9);
    fl[i + sw] |= N | (neg << 8);
    fl[i - 1] |= E | (neg << 11);
    fl[i + 1] |= W | (neg << 10);
    fl[i - sw - 1] |= SE;
    fl[i - sw + 1] |= SW;
    fl[i + sw - 1] |= NE;
    fl[i + sw + 1] |= NW;
  }

  private sigProp(bp: number, raw: number): void {
    const { fl, out, w, h, sw, zo, vm } = this, one = 3 << bp;
    for (let y = 0; y < h; y += 4) {
      const rows = h - y < 4 ? h - y : 4;
      for (let x = 0, i0 = (y + 1) * sw + 1, j0 = y * w; x < w; x++) {
        // Nothing to do in a column where no sample has a significant neighbour.
        if (rows === 4 && !((fl[i0 + x] | fl[i0 + x + sw] | fl[i0 + x + 2 * sw] | fl[i0 + x + 3 * sw]) & NB)) continue;
        for (let r = 0, i = i0 + x, j = j0 + x; r < rows; r++, i += sw, j += w) {
          const f = fl[i] & (r < 3 ? 0xffff : vm);
          if (f & SIG || !(f & NB)) continue;
          if (raw ? this.raw() : this.mq(ZC[zo | (f & NB)])) {
            const neg = raw ? this.raw() : this.sign(f);
            out[j] = neg ? -one : one;
            this.set(i, neg);
          }
          fl[i] |= VISIT;
        }
      }
    }
  }

  private refine(bp: number, raw: number): void {
    const { fl, out, w, h, sw, vm } = this, half = 1 << bp;
    for (let y = 0; y < h; y += 4) {
      const rows = h - y < 4 ? h - y : 4;
      for (let x = 0, i0 = (y + 1) * sw + 1, j0 = y * w; x < w; x++) {
        if (rows === 4 && !((fl[i0 + x] | fl[i0 + x + sw] | fl[i0 + x + 2 * sw] | fl[i0 + x + 3 * sw]) & SIG)) continue;
        for (let r = 0, i = i0 + x, j = j0 + x; r < rows; r++, i += sw, j += w) {
          const f = fl[i] & (r < 3 ? 0xffff : vm);
          if ((f & (SIG | VISIT)) !== SIG) continue;
          const v = out[j];
          out[j] = (raw ? this.raw() : this.mq(f & REF ? 16 : f & NB ? 15 : 14)) ^ (v >>> 31) ? v + half : v - half;
          fl[i] |= REF;
        }
      }
    }
  }

  private cleanup(bp: number): void {
    const { fl, out, w, h, sw, zo, vm } = this, one = 3 << bp;
    for (let y = 0; y < h; y += 4) {
      const rows = h - y < 4 ? h - y : 4;
      for (let x = 0, i0 = (y + 1) * sw + 1, j0 = y * w; x < w; x++) {
        let r = 0, i = i0 + x, j = j0 + x;
        // Run-length mode: a full column of four with nothing significant or visited around it.
        if (rows === 4 && !(fl[i] | fl[i + sw] | fl[i + 2 * sw] | (fl[i + 3 * sw] & vm))) {
          if (!this.mq(17)) continue;
          r = (this.mq(18) << 1) | this.mq(18);
          i += r * sw;
          j += r * w;
          const neg = this.sign(fl[i] & (r < 3 ? 0xffff : vm));
          out[j] = neg ? -one : one;
          this.set(i, neg);
          r++, (i += sw), (j += w);
        }
        for (; r < rows; r++, i += sw, j += w) {
          const f = fl[i] & (r < 3 ? 0xffff : vm);
          if (!(f & (SIG | VISIT)) && this.mq(ZC[zo | (f & NB)])) {
            const neg = this.sign(f);
            out[j] = neg ? -one : one;
            this.set(i, neg);
          }
          fl[i] &= ~VISIT;
        }
      }
    }
  }
}
