/**
 * A small CCITT fax encoder for tests (T.4 one- and two-dimensional coding, T.6), independent of
 * the decoder: its code tables are written out as bit strings.
 */

const WHITE_TERM = '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100';
const WHITE_MAKEUP = '11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011';
const BLACK_TERM = '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111';
const BLACK_MAKEUP = '0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101';
const EXT_MAKEUP = '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111';
const EOL = '000000000001';
const VERTICAL: Record<number, string> = { [-3]: '0000010', [-2]: '000010', [-1]: '010', 0: '1', 1: '011', 2: '000011', 3: '0000011' };

const split = (s: string) => s.split(' ');
const TERM = [split(WHITE_TERM), split(BLACK_TERM)];
const MAKEUP = [split(WHITE_MAKEUP), split(BLACK_MAKEUP)];
const EXT = split(EXT_MAKEUP);

export interface EncodeOptions {
  /** As /K: < 0 Group 4, 0 one-dimensional, > 0 mixed with a 1-D row every K rows. */
  k: number;
  /** Start rows with EOL (Group 3). */
  eol?: boolean;
  /** Byte-align rows (the EOL ends on a byte boundary when there is one). */
  byteAlign?: boolean;
  /** End with RTC (Group 3) or EOFB (Group 4). */
  eob?: boolean;
}

class Bits {
  s: string[] = [];
  n = 0;
  put(b: string): void {
    this.s.push(b);
    this.n += b.length;
  }
  pad(before = 0): void {
    const r = (8 - ((this.n + before) % 8)) % 8;
    if (r) this.put('0'.repeat(r));
  }
  bytes(): Uint8Array {
    const all = this.s.join('');
    const out = new Uint8Array(Math.ceil(all.length / 8));
    for (let i = 0; i < all.length; i++) if (all[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

function runCode(bits: Bits, color: number, r: number): void {
  while (r >= 2624) {
    bits.put(EXT[12]);
    r -= 2560;
  }
  if (r >= 64) {
    const m = r >> 6;
    bits.put(m <= 27 ? MAKEUP[color][m - 1] : EXT[m - 28]);
    r &= 63;
  }
  bits.put(TERM[color][r]);
}

/** Changing elements of a row (1 = black): positions where the color differs from the left. */
function changes(row: Uint8Array): number[] {
  const out: number[] = [];
  for (let x = 0; x < row.length; x++) if (row[x] !== (x ? row[x - 1] : 0)) out.push(x);
  return out;
}

/**
 * Encode rows of pixels (one byte per pixel, 1 = black) of width `w`.
 */
export function ccittEncode(pixels: Uint8Array, w: number, h: number, o: EncodeOptions): Uint8Array {
  const bits = new Bits();
  let ref: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * w, (y + 1) * w);
    const cur = changes(row);
    const twoD = o.k < 0 || (o.k > 0 && y % o.k !== 0);
    if (o.k >= 0 && o.eol) {
      if (o.byteAlign) bits.pad(12);
      bits.put(EOL);
    } else if (o.byteAlign) bits.pad();
    if (o.k > 0) bits.put(twoD ? '0' : '1');
    if (!twoD) {
      let a0 = 0;
      for (let i = 0, c = 0; a0 < w || i === 0; i++, c ^= 1) {
        const a1 = i < cur.length ? cur[i] : w;
        runCode(bits, c, a1 - a0);
        a0 = a1;
        if (a0 >= w) break;
      }
    } else {
      // T.4 2-D coding, with changing elements as positions where the color flips.
      const next = (list: number[], x: number) => list.find((v) => v > x) ?? w;
      const colorAt = (list: number[], x: number) => list.filter((v) => v <= x).length & 1;
      let a0 = -1;
      let c = 0;
      while (a0 < w) {
        // b1: first change on the reference line right of a0 to the color opposite a0's.
        let b1 = next(ref, a0);
        while (b1 < w && colorAt(ref, b1) === c) b1 = next(ref, b1);
        const b2 = next(ref, b1);
        const a1 = next(cur, a0);
        if (b2 < a1) {
          bits.put('0001');
          a0 = b2;
        } else if (Math.abs(a1 - b1) <= 3) {
          bits.put(VERTICAL[a1 - b1]);
          a0 = a1;
          c ^= 1;
        } else {
          const a2 = next(cur, a1);
          bits.put('001');
          runCode(bits, c, a1 - Math.max(a0, 0));
          runCode(bits, c ^ 1, a2 - a1);
          a0 = a2;
        }
      }
    }
    ref = cur;
  }
  if (o.eob) {
    if (o.k < 0) bits.put(EOL + EOL);
    else for (let i = 0; i < 6; i++) bits.put(EOL + (o.k > 0 ? '1' : ''));
  }
  return bits.bytes();
}
