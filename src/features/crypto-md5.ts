/** MD5 (RFC 1321), only for PDF key derivation. Compact; inputs are small. */

let K: Int32Array | undefined;
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** MD5 digest of `msg` (16 bytes). */
export function md5(msg: Uint8Array): Uint8Array {
  if (!K) {
    K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  }
  const len = msg.length;
  const buf = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, len * 8, true);
  dv.setUint32(buf.length - 4, len / 2 ** 29, true);
  const h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  const M = new Int32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + 4 * i, true);
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) & 15 : r === 2 ? (3 * i + 5) & 15 : (7 * i) & 15;
      const x = (a + f + K[i] + M[g]) | 0;
      const s = S[(r << 2) | (i & 3)];
      a = d;
      d = c;
      c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) ov.setInt32(4 * i, h[i], true);
  return out;
}
