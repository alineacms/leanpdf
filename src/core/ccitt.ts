/**
 * CCITTFaxDecode (ITU-T T.4 and T.6): Group 3 one-dimensional (MH), mixed one- and
 * two-dimensional (MR) and Group 4 (MMR) fax data. Rows are decoded as lists of changing elements
 * (positions where the color flips), which also serve as the reference line of the next row.
 */

export interface CcittParams {
  /** <0: pure 2-D (Group 4), 0: 1-D (Group 3), >0: mixed 1-D/2-D. */
  K: number;
  Columns: number;
  Rows: number;
  EndOfLine: boolean;
  EncodedByteAlign: boolean;
  EndOfBlock: boolean;
  BlackIs1: boolean;
  DamagedRowsBeforeError: number;
}

const MAX_COLUMNS = 1 << 20;
const MAX_OUTPUT = 1 << 27;

// Run-length codes as (1 << bits) | code: white and black terminating codes (runs 0-63) then
// make-up codes (64-1728), and the extended make-up codes both share (1792-2560).
const WHITE = [
  309, 71, 23, 24, 27, 28, 30, 31, 51, 52, 39, 40, 72, 67, 116, 117, 106, 107, 167, 140, 136, 151, 131, 132, 168, 171, 147, 164, 152, 258,
  259, 282, 283, 274, 275, 276, 277, 278, 279, 296, 297, 298, 299, 300, 301, 260, 261, 266, 267, 338, 339, 340, 341, 292, 293, 344, 345,
  346, 347, 330, 331, 306, 307, 308, 59, 50, 87, 183, 310, 311, 356, 357, 360, 359, 716, 717, 722, 723, 724, 725, 726, 727, 728, 729, 730,
  731, 664, 665, 666, 88, 667,
];
const BLACK = [
  1079, 10, 7, 6, 11, 19, 18, 35, 69, 68, 132, 133, 135, 260, 263, 536, 1047, 1048, 1032, 2151, 2152, 2156, 2103, 2088, 2071, 2072, 4298,
  4299, 4300, 4301, 4200, 4201, 4202, 4203, 4306, 4307, 4308, 4309, 4310, 4311, 4204, 4205, 4314, 4315, 4180, 4181, 4182, 4183, 4196,
  4197, 4178, 4179, 4132, 4151, 4152, 4135, 4136, 4184, 4185, 4139, 4140, 4186, 4198, 4199, 1039, 4296, 4297, 4187, 4147, 4148, 4149,
  8300, 8301, 8266, 8267, 8268, 8269, 8306, 8307, 8308, 8309, 8310, 8311, 8274, 8275, 8276, 8277, 8282, 8283, 8292, 8293,
];
const EXTENDED = [2056, 2060, 2061, 4114, 4115, 4116, 4117, 4118, 4119, 4124, 4125, 4126, 4127];

/** Lookup on the next 13 bits: run << 4 | code length, 0 where no code matches. */
function table(codes: number[]): Uint16Array {
  const t = new Uint16Array(8192);
  codes.concat(EXTENDED).forEach((s, i) => {
    const len = 31 - Math.clz32(s);
    const at = (s ^ (1 << len)) << (13 - len);
    t.fill(((i < 64 ? i : (i - 63) * 64) << 4) | len, at, at + (1 << (13 - len)));
  });
  return t;
}

let tables: Uint16Array[] | undefined;

/**
 * CCITTFaxDecode: decode Group 3 / Group 4 fax data to packed rows of 1-bit pixels (each row
 * padded to a byte), 0 = black unless BlackIs1. Returns what was decoded before damage, or null
 * when nothing could be.
 */
export function ccittDecode(data: Uint8Array, p: Partial<CcittParams>): Uint8Array | null {
  const k = p.K ?? 0;
  const cols = p.Columns ?? 1728;
  const rows = p.Rows ?? 0;
  if (!(cols >= 1 && cols <= MAX_COLUMNS) || cols % 1) return null;
  const T = (tables ??= [table(WHITE), table(BLACK)]);
  const rowBytes = (cols + 7) >> 3;
  const maxRows = Math.min(rows > 0 ? rows : Infinity, Math.floor(MAX_OUTPUT / rowBytes));
  let out = new Uint8Array(rowBytes * Math.min(maxRows, 256));
  const end = data.length * 8;
  let pos = 0;
  /** The next `n` (<= 13) bits, zeros past the end. */
  const peek = (n: number) => (((data[pos >> 3] << 16) | (data[(pos >> 3) + 1] << 8) | data[(pos >> 3) + 2]) >>> (24 - n - (pos & 7))) & ((1 << n) - 1);
  // Changing elements of the reference and the coding line, followed by `cols` sentinels.
  let ref = new Int32Array(cols + 4).fill(cols);
  let cur = new Int32Array(cols + 4);
  let n = 0;
  const add = (x: number) => {
    if (x >= cols) return;
    // A zero-length run cancels the previous change (malformed data may even go back).
    if (n && x <= cur[n - 1]) n--;
    else cur[n++] = x;
  };
  /** One run length of `color`: make-up codes, then a terminating code; -1 if invalid. */
  const run = (color: number) => {
    for (let total = 0; ; ) {
      const e = T[color][peek(13)];
      pos += e & 15;
      if (!e || pos > end) return -1;
      total += e >> 4;
      if (e >> 4 < 64) return total;
    }
  };
  const row1d = () => {
    for (let a0 = 0, c = 0; a0 < cols; c ^= 1) {
      const r = run(c);
      if (r < 0 || (a0 += r) > cols) return false;
      add(a0);
    }
    return true;
  };
  const row2d = () => {
    for (let a0 = -1, c = 0, b = 0; a0 < cols; ) {
      // b1: the first change on the reference line right of a0 to the opposite color of a0's.
      while (b > 0 && ref[b - 1] > a0) b--;
      while (ref[b] <= a0) b++;
      if ((b & 1) !== c) b++;
      const b7 = peek(7);
      const z = Math.clz32(b7) - 25;
      if (z === 3) {
        // Pass: a0 moves under b2.
        pos += 4;
        a0 = ref[b + 1];
      } else if (z === 2) {
        // Horizontal: two runs from a0.
        pos += 3;
        const r1 = run(c);
        const r2 = run(c ^ 1);
        if (r1 < 0 || r2 < 0) return false;
        const a1 = Math.min(Math.max(a0, 0) + r1, cols);
        add(a1);
        add((a0 = Math.min(a1 + r2, cols)));
      } else if (z < 6) {
        // Vertical: a1 = b1 + d, |d| <= 3 (V0: 1, VR1/VL1: 011/010, VR2/VL2: 000011/000010, ...).
        const len = z ? z + 2 : 1;
        const d = z < 2 ? z : z - 2;
        pos += len;
        add((a0 = Math.min(Math.max(ref[b] + ((b7 >> (7 - len)) & 1 ? d : -d), a0, 0), cols)));
        c ^= 1;
      } else return false; // EOL, uncompressed mode or garbage
      if (pos > end) return false;
    }
    return true;
  };

  const align = () => p.EncodedByteAlign && (pos = (pos + 7) & ~7);
  let done = 0;
  let damaged = 0;
  while (done < maxRows) {
    let twoD = k < 0;
    if (k < 0) {
      // Group 4 rows have no EOL: one here starts the end of block.
      align();
      if (peek(12) === 1) break;
    } else {
      // Fill bits and an EOL, then for K > 0 a tag bit, 1 for a 1-D row; EOL EOL ends the block.
      // Byte-aligned, an EOL ends on a byte boundary (so it is looked for first when rows have
      // one), and rows without an EOL start on one.
      if (!p.EndOfLine) align();
      while (pos < end && !peek(12)) pos++;
      if (peek(12) === 1) {
        pos += 12;
        if (peek(12) === 1 || (k > 0 && peek(13) === 0x1001)) break;
      } else align();
      if (k > 0) {
        twoD = !peek(1);
        pos++;
      }
    }
    if (pos >= end) break;
    n = 0;
    if (!(twoD ? row2d() : row1d())) {
      // With EOLs to resynchronize on, keep going past a few damaged rows.
      if (k < 0 || !p.EndOfLine || damaged++ >= (p.DamagedRowsBeforeError ?? 0)) break;
      while (++pos < end && peek(12) !== 1);
    }
    if ((done + 1) * rowBytes > out.length) {
      const grown = new Uint8Array(Math.min(out.length * 2, maxRows * rowBytes));
      grown.set(out);
      out = grown;
    }
    const o = done++ * rowBytes;
    out.fill(p.BlackIs1 ? 0 : 255, o, o + rowBytes);
    for (let i = 0; i < n; i += 2) {
      for (let x = cur[i], e = i + 1 < n ? cur[i + 1] : cols; x < e; x++) out[o + (x >> 3)] ^= 0x80 >> (x & 7);
    }
    [ref, cur] = [cur, ref];
    ref.fill(cols, n, n + 3);
  }
  return done ? out.slice(0, done * rowBytes) : null;
}
