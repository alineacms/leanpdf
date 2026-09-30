/**
 * JPEG 2000 inverse discrete wavelet transform (ITU-T T.800 Annex F): the reversible 5/3 and the
 * irreversible 9/7 filter, both by lifting on floats (the 5/3 stays exact: its values are integers
 * far below 2^24, and its divisions are shifts). Rows go through a line buffer; columns are lifted
 * in place, whole rows at a time in one sweep, then the rows are put in order.
 */

/** Samples of symmetric extension on each side of a line: enough for the four 9/7 steps. */
const PAD = 4;
// 9/7 lifting steps in synthesis order (delta, gamma, beta, alpha) and scaling (Table F.4).
const LIFT = [0.443506852043971, 0.882911075530934, -0.052980118572961, -1.586134342059924];
const [DELTA, GAMMA, BETA, ALPHA] = LIFT;
const K = 1.230174104914001;

export interface Level {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let line = new Float64Array(0);
let at = new Int32Array(0);
let seen = new Uint8Array(0);
let spare = new Float32Array(0);

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
  if (line.length < max + 2 * PAD) (line = new Float64Array(max + 2 * PAD)), (at = new Int32Array(max + 2)), (seen = new Uint8Array(max));
  for (let r = 1; r < levels.length; r++) {
    const { x0, y0, x1, y1 } = levels[r], lo = levels[r - 1], w = x1 - x0, h = y1 - y0;
    if (!w || !h) continue;
    // Rows first, then columns (F.3.2 2D_SR). The rows also apply the columns' 9/7 scaling
    // (the top rows are the low-pass ones): the row transform is linear, so it may come after.
    const lh = lo.y1 - lo.y0, kl = rev || h < 2 ? 1 : K, kh = rev || h < 2 ? 1 : 1 / K;
    for (let y = 0; y < h; y++) row(a, y * stride, w, lo.x1 - lo.x0, x0 & 1, rev, y < lh ? kl : kh);
    columns(a, stride, w, h, lh, y0 & 1, rev);
  }
}

/**
 * A line starting at an odd coordinate starts with a high-pass sample. `nl`: low-pass samples;
 * `k`: scale for the result.
 */
function row(a: Float32Array, off: number, n: number, nl: number, odd: number, rev: boolean, k: number): void {
  const t = line, P = PAD;
  if (n === 1) {
    // A lone low-pass sample is the value; a lone high-pass one is twice it (F.3.7).
    if (odd) a[off] = rev ? a[off] >> 1 : a[off] / 2;
    a[off] *= k;
    return;
  }
  // Interleave, scaling the 9/7 bands (the first step of the inverse), and extend both ends.
  const kl = rev ? 1 : K, kh = rev ? 1 : 1 / K;
  for (let q = 0, j = P + odd; q < nl; q++, j += 2) t[j] = a[off + q] * kl;
  for (let q = nl, j = P + 1 - odd; q < n; q++, j += 2) t[j] = a[off + q] * kh;
  for (let i = 1; i <= P; i++) (t[P - i] = t[P + mirror(-i, n)]), (t[P + n - 1 + i] = t[P + mirror(n - 1 + i, n)]);
  // One sweep over the low-pass positions j (P + odd + 2i), each step trailing the one before
  // by a sample and carrying its latest result; samples trailing far enough are final and go
  // straight back to the row. Each step reaches one sample less into the extension than the one
  // before, so what is computed beyond that (from the zeros the carries start with) never
  // reaches the row.
  const o = off - P, e = P + n;
  let h1 = t[1 - odd], d2 = 0;
  if (rev) {
    for (let j = 2 - odd; j <= e; j += 2) {
      const h = t[j + 1], d = t[j] - ((h1 + h + 2) >> 2), g = h1 + ((d2 + d) >> 1);
      if (j >= P && j < e) a[o + j] = d;
      if (j > P && j <= e) a[o + j - 1] = g;
      (h1 = h), (d2 = d);
    }
    return;
  }
  const D = DELTA, G = GAMMA, B = BETA, A = ALPHA;
  let g3 = 0, b4 = 0;
  for (let j = 2 - odd; j < e + 3; j += 2) {
    const h = t[j + 1], d = t[j] - D * (h1 + h), g = h1 - G * (d2 + d), b = d2 - B * (g3 + g);
    if (j - 2 >= P && j - 2 < e) a[o + j - 2] = b * k;
    if (j - 3 >= P && j - 3 < e) a[o + j - 3] = (g3 - A * (b4 + b)) * k;
    (h1 = h), (d2 = d), (g3 = g), (b4 = b);
  }
}

function columns(a: Float32Array, stride: number, w: number, n: number, nl: number, odd: number, rev: boolean): void {
  if (n === 1) {
    if (odd) for (let x = 0; x < w; x++) a[x] = rev ? a[x] >> 1 : a[x] / 2;
    return;
  }
  // Offset of the row holding sample j of the interleaved column (low-pass rows first), for
  // j = -1..n with the ends mirrored: lifting in place then never needs extension rows.
  for (let j = -1; j <= n; j++) {
    const k = mirror(j, n);
    at[j + 1] = ((k ^ odd) & 1 ? nl + ((k - 1 + odd) >> 1) : (k - odd) >> 1) * stride;
  }
  // One sweep down the rows, each lifting step trailing the one before by a row, so the rows
  // being worked on stay in cache: at row i, step s updates row i - 1 - s (even steps the
  // low-pass rows, odd steps the high-pass ones). Every other row that is all of them at once,
  // which away from the ends runs as one loop carrying the new values.
  const steps = rev ? 2 : 4, D = DELTA, G = GAMMA, B = BETA, A = ALPHA, rows = at;
  for (let i = 1 - odd; i < n + steps; i += 2) {
    if (i > steps && i < n) {
      const r0 = rows[i + 1], r1 = rows[i], r2 = rows[i - 1], r3 = rows[i - 2];
      if (rev) {
        for (let x = 0; x < w; x++) {
          const n1 = a[r1 + x] - ((a[r2 + x] + a[r0 + x] + 2) >> 2);
          a[r1 + x] = n1;
          a[r2 + x] += (a[r3 + x] + n1) >> 1;
        }
      } else {
        const r4 = rows[i - 3], r5 = rows[i - 4];
        for (let x = 0; x < w; x++) {
          const p3 = a[r3 + x], p4 = a[r4 + x];
          const n1 = a[r1 + x] - D * (a[r2 + x] + a[r0 + x]);
          const n2 = a[r2 + x] - G * (p3 + n1);
          const n3 = p3 - B * (p4 + n2);
          a[r1 + x] = n1;
          a[r2 + x] = n2;
          a[r3 + x] = n3;
          a[r4 + x] = p4 - A * (a[r5 + x] + n3);
        }
      }
      continue;
    }
    for (let s = 0; s < steps; s++) {
      const r = i - 1 - s;
      if (r < 0 || r >= n) continue;
      const d = rows[r + 1], u = rows[r], v = rows[r + 2], c = LIFT[s];
      if (!rev) for (let x = 0; x < w; x++) a[d + x] -= c * (a[u + x] + a[v + x]);
      else if (s) for (let x = 0; x < w; x++) a[d + x] += (a[u + x] + a[v + x]) >> 1;
      else for (let x = 0; x < w; x++) a[d + x] -= (a[u + x] + a[v + x] + 2) >> 2;
    }
  }
  // Put the rows in order, following the permutation's cycles with one spare row.
  seen.fill(0, 0, n);
  const t = spare.length < w ? (spare = new Float32Array(w)) : spare.subarray(0, w);
  for (let j = 0; j < n; j++) {
    if (seen[j]) continue;
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
