/**
 * PDF functions (ISO 32000 7.10): sampled (type 0), exponential (2), stitching (3) and PostScript
 * calculator (4). Loading does all the parsing; evaluating allocates nothing.
 */
import { latin1 } from '../core/bytes.ts';
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { intOf, numOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';

/**
 * A PDF function (types 0, 2, 3 and 4): maps m inputs to n outputs, clipping inputs to /Domain and
 * outputs to /Range. `out` is reused when given.
 */
export interface PdfFunction {
  (input: ArrayLike<number>, out?: number[]): number[];
  /** Stitching functions: the inputs where sub-functions meet (where the output may jump). */
  bounds?: number[];
}

type Eval = (x: number[], out: number[]) => void;

/** Sample values of a sampled function. */
const MAX_SAMPLES = 1 << 22;
const MAX_INPUTS = 12;
/** Instructions of a calculator function; it has no loops, so this also bounds the steps. */
const MAX_CODE = 1 << 16;
const MAX_STACK = 100;
const MAX_DEPTH = 8;
/** Function objects one load may visit (shared sub-functions count once). */
const MAX_NODES = 4096;
/** Stitching bounds kept (for gradient stops). */
const MAX_BOUNDS = 1024;

/** One load: finished sub-functions by object number, and the visits left. */
interface Ctx {
  memo: Map<number, PdfFunction | undefined>;
  left: number;
}

/** Clamp to [lo, hi], NaN to `lo`. */
export const clamp = (v: number, lo: number, hi: number): number => (v > lo ? (v < hi ? v : hi) : lo);

/** Map `x` from [x0, x1] to [y0, y1]. */
export const lerp = (x: number, x0: number, x1: number, y0: number, y1: number): number =>
  x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);

/** An array of finite numbers (elements may be references), or undefined. */
export async function numArray(doc: PdfDocument, o: PdfObj | undefined): Promise<number[] | undefined> {
  const a = await doc.resolve(o);
  if (!Array.isArray(a)) return undefined;
  const out: number[] = [];
  for (const x of a) {
    const v = numOf(await doc.resolve(x));
    if (v === undefined || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

/**
 * Load a function object (dictionary or stream), or an array of 1-output functions (their outputs
 * concatenated, as for shadings and tint transforms). Undefined when it can't be used.
 */
export function loadFunction(doc: PdfDocument, o: PdfObj | undefined): Promise<PdfFunction | undefined> {
  return load(doc, o, 0, { memo: new Map(), left: MAX_NODES });
}

async function load(doc: PdfDocument, o: PdfObj | undefined, depth: number, ctx: Ctx): Promise<PdfFunction | undefined> {
  // Shared sub-functions load once; cycles end at the depth limit.
  const num = o instanceof PdfRef ? o.num : -1;
  if (ctx.memo.has(num)) return ctx.memo.get(num);
  if (depth > MAX_DEPTH || --ctx.left < 0) return undefined;
  const fn = await build(doc, o, depth, ctx);
  if (num >= 0) ctx.memo.set(num, fn);
  return fn;
}

async function build(doc: PdfDocument, o: PdfObj | undefined, depth: number, ctx: Ctx): Promise<PdfFunction | undefined> {
  const v = await doc.resolve(o);
  if (Array.isArray(v)) {
    const fns: PdfFunction[] = [];
    for (const f of v) {
      const fn = await load(doc, f, depth + 1, ctx);
      if (!fn) return undefined;
      fns.push(fn);
    }
    const tmp: number[] = [];
    const all: PdfFunction = (input, out = []) => {
      out.length = 0;
      for (const fn of fns) out.push(...fn(input, tmp));
      return out;
    };
    const b = fns.flatMap((f) => f.bounds ?? []);
    if (b.length) all.bounds = b.sort((p, q) => p - q).slice(0, MAX_BOUNDS);
    return fns.length ? all : undefined;
  }
  if (!(v instanceof PdfDict)) return undefined;
  const type = intOf(await doc.resolve(v.get('FunctionType')));
  const range = await numArray(doc, v.get('Range'));
  const domain = (await numArray(doc, v.get('Domain'))) ?? [0, 1];
  const m = domain.length >> 1;
  let n = range ? range.length >> 1 : 0;
  if (!m || m > MAX_INPUTS) return undefined;
  let f: Eval | undefined;
  let bounds: number[] | undefined;

  if (type === 0 || type === 4) {
    const data = o instanceof PdfRef && (await readStream(doc, o, 16 << 20));
    if (!data) return undefined;
    if (type === 4) f = calculator(latin1(data), n);
    else if (range) f = await sampled(doc, v, data, domain, range, m, n);
  } else if (type === 2) {
    const c0 = (await numArray(doc, v.get('C0'))) ?? [0];
    const c1 = (await numArray(doc, v.get('C1'))) ?? [1];
    const e = numOf(await doc.resolve(v.get('N')));
    if (e === undefined || c1.length < c0.length) return undefined;
    n = c0.length;
    f = (x, out) => {
      const t = x[0] ** e;
      for (let j = 0; j < n; j++) out[j] = c0[j] + t * (c1[j] - c0[j]);
    };
  } else if (type === 3) {
    const fa = await doc.resolve(v.get('Functions'));
    const b = (await numArray(doc, v.get('Bounds'))) ?? [];
    const enc = await numArray(doc, v.get('Encode'));
    const k = Array.isArray(fa) ? fa.length : 0;
    if (!k || b.length < k - 1 || !enc || enc.length < 2 * k) return undefined;
    const fns: PdfFunction[] = [];
    for (const s of fa as PdfObj[]) {
      const fn = await load(doc, s, depth + 1, ctx);
      if (!fn) return undefined;
      fns.push(fn);
    }
    const lo = (i: number) => (i ? b[i - 1] : domain[0]);
    const hi = (i: number) => (i < k - 1 ? b[i] : domain[1]);
    const t = [0];
    f = (x, out) => {
      // Subdomains are [Bounds(i-1), Bounds(i)); the first includes Domain0 even when empty.
      let i = 0;
      if (x[0] > domain[0]) while (i < k - 1 && x[0] >= b[i]) i++;
      t[0] = lerp(x[0], lo(i), hi(i), enc[2 * i], enc[2 * i + 1]);
      fns[i](t, out);
    };
    // Where sub-functions meet, and their own bounds mapped back to this input.
    bounds = b.slice(0, k - 1);
    fns.forEach((fn, i) => {
      for (const s of fn.bounds ?? []) {
        const u = lerp(s, enc[2 * i], enc[2 * i + 1], lo(i), hi(i));
        if (u > lo(i) && u < hi(i)) bounds!.push(u);
      }
    });
    bounds = bounds.sort((p, q) => p - q).slice(0, MAX_BOUNDS);
  }
  if (!f) return undefined;
  const g = f;
  const x: number[] = [];
  const fn: PdfFunction = (input, out = []) => {
    for (let i = 0; i < m; i++) x[i] = clamp(input[i] ?? 0, domain[2 * i], domain[2 * i + 1]);
    g(x, out);
    if (range) for (let j = 0; j < n; j++) out[j] = clamp(out[j], range[2 * j], range[2 * j + 1]);
    else for (let j = 0; j < out.length; j++) if (!Number.isFinite(out[j])) out[j] = 0;
    return out;
  };
  if (bounds?.length) fn.bounds = bounds;
  return fn;
}

/** Type 0: a table of samples, interpolated multilinearly (/Order 3 is treated as 1). */
async function sampled(doc: PdfDocument, d: PdfDict, data: Uint8Array, domain: number[], range: number[], m: number, n: number): Promise<Eval | undefined> {
  const size = await numArray(doc, d.get('Size'));
  const bps = intOf(await doc.resolve(d.get('BitsPerSample'))) ?? 0;
  if (!size || size.length < m || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bps)) return undefined;
  const enc = (await numArray(doc, d.get('Encode'))) ?? size.flatMap((s) => [0, s - 1]);
  const dec = (await numArray(doc, d.get('Decode'))) ?? range;
  if (enc.length < 2 * m || dec.length < 2 * n) return undefined;
  // Offset between neighbours along each input; the first input varies fastest.
  let total = n;
  const stride: number[] = [];
  for (let i = 0; i < m; i++) {
    if (!(size[i] >= 1) || size[i] % 1) return undefined;
    stride.push(total);
    total *= size[i];
    if (total > MAX_SAMPLES) return undefined;
  }
  // Decode all samples up front; missing ones read as 0.
  const s = new Float32Array(total);
  const max = 2 ** bps - 1;
  for (let i = 0, bit = 0; i < total; i++) {
    let v = 0;
    for (let left = bps; left > 0; ) {
      const take = Math.min(left, 8 - (bit & 7));
      v = v * 2 ** take + (((data[bit >> 3] ?? 0) >> (8 - (bit & 7) - take)) & ((1 << take) - 1));
      bit += take;
      left -= take;
    }
    const j = i % n;
    s[i] = dec[2 * j] + (v * (dec[2 * j + 1] - dec[2 * j])) / max;
  }
  const base: number[] = [];
  const frac: number[] = [];
  return (x, out) => {
    for (let i = 0; i < m; i++) {
      const e = clamp(lerp(x[i], domain[2 * i], domain[2 * i + 1], enc[2 * i], enc[2 * i + 1]), 0, size[i] - 1);
      const k = Math.max(0, Math.min(Math.floor(e), size[i] - 2));
      base[i] = k * stride[i];
      frac[i] = size[i] > 1 ? e - k : 0;
    }
    for (let j = 0; j < n; j++) out[j] = 0;
    // Weighted sum over the 2^m corners of the cell.
    for (let c = 0; c < 1 << m; c++) {
      let w = 1;
      let at = 0;
      for (let i = 0; i < m && w; i++) {
        const up = (c >> i) & 1;
        w *= up ? frac[i] : 1 - frac[i];
        at += base[i] + up * stride[i];
      }
      if (w) for (let j = 0; j < n; j++) out[j] += w * s[at + j];
    }
  };
}

/** Calculator operators: unary (F1), binary (F2), then the stack operators. */
const OPS =
  'abs ceiling cos cvi cvr floor ln log neg round sin sqrt truncate not add sub mul div exp idiv mod atan bitshift eq ne gt ge lt le and or xor copy dup exch index pop roll true false';
const DEG = Math.PI / 180;
// Operands are numbers or booleans, as in PostScript.
type Val = any;
const isBool = (a: Val) => typeof a === 'boolean';
const F1: ((a: Val) => Val)[] = [
  Math.abs, Math.ceil, (a) => Math.cos(a * DEG), Math.trunc, (a) => a, Math.floor, Math.log, Math.log10, (a) => -a, Math.round,
  (a) => Math.sin(a * DEG), Math.sqrt, Math.trunc, (a) => (isBool(a) ? !a : ~a),
];
const F2: ((a: Val, b: Val) => Val)[] = [
  (a, b) => a + b, (a, b) => a - b, (a, b) => a * b, (a, b) => a / b, (a, b) => a ** b, (a, b) => Math.trunc(a / b),
  (a, b) => a % b, (a, b) => (Math.atan2(a, b) / DEG + 360) % 360, (a, b) => (b >= 0 ? a << b : a >> -b), (a, b) => a === b,
  (a, b) => a !== b, (a, b) => a > b, (a, b) => a >= b, (a, b) => a < b, (a, b) => a <= b,
  (a, b) => (isBool(a) ? a && b : a & b), (a, b) => (isBool(a) ? a || b : a | b), (a, b) => (isBool(a) ? a !== b : a ^ b),
];

/**
 * Type 4: compile the procedure to [op, arg] pairs (op 0: push arg, 1: pop and jump to arg if false,
 * 2: jump to arg, else operator op - 3) and run them on a bounded stack. Errors give zeros. `n`
 * outputs are taken from the top of the stack (0: the whole stack).
 */
function calculator(src: string, n: number): Eval | undefined {
  const toks = src.match(/[{}]|%[^\r\n]*|[^\s{}%]+/g) ?? [];
  const ops = OPS.split(' ');
  const code: number[] = [];
  let p = 0;
  const block = (): boolean => {
    if (toks[p++] !== '{') return false;
    for (let t; (t = toks[p++]) !== '}'; ) {
      if (t === undefined || code.length > MAX_CODE) return false;
      if (t[0] === '%') continue;
      if (t === '{') {
        p--;
        const jz = code.push(1, 0) - 1;
        if (!block()) return false;
        if (toks[p] === '{') {
          const jmp = code.push(2, 0) - 1;
          code[jz] = code.length;
          if (!block()) return false;
          code[jmp] = code.length;
          if (toks[p++] !== 'ifelse') return false;
        } else {
          code[jz] = code.length;
          if (toks[p++] !== 'if') return false;
        }
        continue;
      }
      const op = ops.indexOf(t);
      const v = Number(t);
      if (op >= 0) code.push(op + 3, 0);
      else if (Number.isFinite(v)) code.push(0, v);
      else return false;
    }
    return true;
  };
  if (!block()) return undefined;
  const st: Val[] = [];
  const rev = (a: number, b: number) => {
    for (b--; a < b; a++, b--) [st[a], st[b]] = [st[b], st[a]];
  };
  const U = F1.length + 3;
  const B = U + F2.length;
  return (x, out) => {
    let sp = 0;
    let ok = true;
    for (const v of x) st[sp++] = v;
    for (let pc = 0; pc < code.length && ok; pc += 2) {
      const op = code[pc];
      const a = code[pc + 1];
      let t: number;
      if (op === 0) st[sp++] = a;
      else if (op === 1) {
        if (sp < 1) ok = false;
        else if (!st[--sp]) pc = a - 2;
      } else if (op === 2) pc = a - 2;
      else if (op < U) {
        if (sp < 1) ok = false;
        else st[sp - 1] = F1[op - 3](st[sp - 1]);
      } else if (op < B) {
        if (sp < 2) ok = false;
        else st[sp - 2] = F2[op - U](st[sp - 2], st[--sp]);
      } else {
        switch (op - B) {
          case 0: // n copy
            t = st[--sp] | 0;
            if (!(t >= 0 && t <= sp)) ok = false;
            else for (let i = 0; i < t; i++, sp++) st[sp] = st[sp - t];
            break;
          case 1: // dup
            if (sp < 1) ok = false;
            else st[sp] = st[sp++ - 1];
            break;
          case 2: // exch
            if (sp < 2) ok = false;
            else rev(sp - 2, sp);
            break;
          case 3: // n index
            t = st[--sp] | 0;
            if (!(t >= 0 && t < sp)) ok = false;
            else st[sp] = st[sp++ - 1 - t];
            break;
          case 4: // pop
            ok = --sp >= 0;
            break;
          case 5: {
            // n j roll: rotate the top n by j, as three reversals.
            const j = st[--sp] | 0;
            t = st[--sp] | 0;
            if (!(t >= 0 && t <= sp)) ok = false;
            else if (t) {
              const r = ((j % t) + t) % t;
              rev(sp - t, sp);
              rev(sp - t, sp - t + r);
              rev(sp - t + r, sp);
            }
            break;
          }
          default: // true, false
            st[sp++] = op - B === 6;
        }
      }
      if (sp > MAX_STACK) ok = false;
    }
    const k = n || Math.max(sp, 0);
    out.length = k;
    for (let j = 0; j < k; j++) out[j] = ok ? +st[sp - k + j] || 0 : 0;
  };
}
