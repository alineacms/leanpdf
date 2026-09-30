/**
 * JPEG 2000 inverse discrete wavelet transform (ITU-T T.800 Annex F): the reversible 5/3 and the
 * irreversible 9/7 filter, both by lifting on floats (the 5/3 stays exact: its values are integers
 * far below 2^24). Rows go through a line buffer; columns are lifted in place a whole row segment
 * at a time, in strips narrow enough to stay in cache, then the rows are put in order.
 */

/** Samples of symmetric extension on each side of a line: enough for the four 9/7 steps. */
const PAD = 4;
const STRIP = 512;
// 9/7 lifting steps in synthesis order (delta, gamma, beta, alpha) and scaling (Table F.4).
const LIFT = [0.443506852043971, 0.882911075530934, -0.052980118572961, -1.586134342059924];
const K = 1.230174104914001;

export interface Level {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let line = new Float32Array(0);
let at = new Int32Array(0);
let seen = new Uint8Array(0);

/** Index of `j` in a line of `n` samples, mirrored (whole-sample symmetric, periodic for short lines). */
function mirror(j: number, n: number): number {
  const p = 2 * (n - 1);
  j %= p;
  if (j < 0) j += p;
  return j < n ? j : p - j;
}

/**
 * Synthesize `levels[r]` from `levels[r - 1]`, for r = 1.., in `a` (row stride `stride`), which holds
 * the subbands in the usual layout: LL top left, HL top right, LH bottom left, HH bottom right,
 * each level's LL holding the level below. `rev`: 5/3, else 9/7.
 */
export function idwt(a: Float32Array, stride: number, levels: Level[], rev: boolean): void {
  let max = 0;
  for (const l of levels) max = Math.max(max, l.x1 - l.x0, l.y1 - l.y0);
  if (line.length < max + 2 * PAD) (line = new Float32Array(max + 2 * PAD)), (at = new Int32Array(max + 2)), (seen = new Uint8Array(max));
  for (let r = 1; r < levels.length; r++) {
    const { x0, y0, x1, y1 } = levels[r], lo = levels[r - 1], w = x1 - x0, h = y1 - y0;
    if (!w || !h) continue;
    // Rows first, then columns (F.3.2 2D_SR).
    for (let y = 0; y < h; y++) row(a, y * stride, w, lo.x1 - lo.x0, x0 & 1, rev);
    columns(a, stride, w, h, lo.y1 - lo.y0, y0 & 1, rev);
  }
}

/** A line starting at an odd coordinate starts with a high-pass sample. `nl`: low-pass samples. */
function row(a: Float32Array, off: number, n: number, nl: number, odd: number, rev: boolean): void {
  const t = line;
  if (n === 1) {
    // A lone low-pass sample is the value; a lone high-pass one is twice it (F.3.7).
    if (odd) a[off] = rev ? Math.floor(a[off] / 2) : a[off] / 2;
    return;
  }
  // Interleave, scaling the 9/7 bands (the first step of the inverse), and extend both ends.
  const kl = rev ? 1 : K, kh = rev ? 1 : 1 / K;
  for (let q = 0, j = PAD + odd; q < nl; q++, j += 2) t[j] = a[off + q] * kl;
  for (let q = nl, j = PAD + 1 - odd; q < n; q++, j += 2) t[j] = a[off + q] * kh;
  for (let i = 1; i <= PAD; i++) (t[PAD - i] = t[PAD + mirror(-i, n)]), (t[PAD + n - 1 + i] = t[PAD + mirror(n - 1 + i, n)]);
  // Each step reaches one sample less into the extension than the one before. The low-pass
  // (even) samples are those at PAD + odd + 2k.
  if (rev) {
    for (let j = PAD - odd, e = PAD + n + 1; j < e; j += 2) t[j] -= Math.floor((t[j - 1] + t[j + 1] + 2) / 4);
    for (let j = PAD + 1 - odd, e = PAD + n; j < e; j += 2) t[j] += Math.floor((t[j - 1] + t[j + 1]) / 2);
  } else {
    for (let s = 0; s < 4; s++) {
      const c = LIFT[s];
      for (let j = s + 2 - odd, e = 2 * PAD + n - s - 1; j < e; j += 2) t[j] -= c * (t[j - 1] + t[j + 1]);
    }
  }
  for (let q = 0; q < n; q++) a[off + q] = t[PAD + q];
}

function columns(a: Float32Array, stride: number, w: number, n: number, nl: number, odd: number, rev: boolean): void {
  if (n === 1) {
    if (odd) for (let x = 0; x < w; x++) a[x] = rev ? Math.floor(a[x] / 2) : a[x] / 2;
    return;
  }
  // Offset of the row holding sample j of the interleaved column (low-pass rows first), for
  // j = -1..n with the ends mirrored: lifting in place then never needs extension rows.
  for (let j = -1; j <= n; j++) {
    const k = mirror(j, n);
    at[j + 1] = ((k ^ odd) & 1 ? nl + ((k - 1 + odd) >> 1) : (k - odd) >> 1) * stride;
  }
  for (let x0 = 0; x0 < w; x0 += STRIP) {
    const x1 = Math.min(x0 + STRIP, w);
    if (rev) {
      for (let j = odd; j < n; j += 2) {
        const d = at[j + 1], u = at[j], v = at[j + 2];
        for (let x = x0; x < x1; x++) a[d + x] -= Math.floor((a[u + x] + a[v + x] + 2) / 4);
      }
      for (let j = 1 - odd; j < n; j += 2) {
        const d = at[j + 1], u = at[j], v = at[j + 2];
        for (let x = x0; x < x1; x++) a[d + x] += Math.floor((a[u + x] + a[v + x]) / 2);
      }
    } else {
      for (let j = 0; j < n; j++) {
        const d = at[j + 1], k = (j ^ odd) & 1 ? 1 / K : K;
        for (let x = x0; x < x1; x++) a[d + x] *= k;
      }
      for (let s = 0; s < 4; s++) {
        const c = LIFT[s];
        for (let j = (odd + s) & 1; j < n; j += 2) {
          const d = at[j + 1], u = at[j], v = at[j + 2];
          for (let x = x0; x < x1; x++) a[d + x] -= c * (a[u + x] + a[v + x]);
        }
      }
    }
  }
  // Put the rows in order, following the permutation's cycles with one spare row.
  seen.fill(0, 0, n);
  for (let j = 0; j < n; j++) {
    if (seen[j]) continue;
    const t = line.subarray(0, w);
    t.set(a.subarray(j * stride, j * stride + w));
    for (let k = j; ; ) {
      seen[k] = 1;
      const s = at[k + 1];
      if (s === j * stride) {
        a.set(t, k * stride);
        break;
      }
      a.copyWithin(k * stride, s, s + w);
      k = s / stride;
    }
  }
}
