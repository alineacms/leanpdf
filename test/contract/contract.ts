/**
 * Codec contract suite, shared by every ImageCodec implementation.
 *
 * Runtime neutral: this module uses only ECMAScript built-ins (plus setTimeout), so it runs in
 * Bun, on a browser main thread and inside a Web Worker. Everything runtime specific is injected
 * through `ContractEnv`: the codec, a JPEG decoder used to check what the codec produced, and the
 * JPEG input fixtures (the Node side encodes them with sharp from `JPEG_SPECS`).
 *
 * Every codec is held to the same expectations. Where codecs legitimately differ, the difference
 * is an explicit, documented entry in `CodecCapabilities` instead of a looser check for everyone.
 */
import { sniffJpeg } from '../../src/core/jpeg.ts';
import type { ColorComponents, ImageCodec, ImageInput, ImageOutput, RecompressOptions } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------------------------
// Public API

/** Decoded pixels, 8 bits per sample, row-major, no padding. */
export interface DecodedImage {
  width: number;
  height: number;
  /** 1 (gray), 3 (RGB) or 4 (RGBA, e.g. from getImageData). */
  channels: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Documented, per-codec differences the contract allows. */
export interface CodecCapabilities {
  /**
   * Gray input with `preserveGray: true` is encoded as a 1-component JPEG.
   * SharpImageCodec: true. BrowserImageCodec: false, because canvas JPEG encoders always write
   * 3-component YCbCr, so gray input comes back as RGB (with R = G = B).
   */
  grayOutput: boolean;
}

export const SHARP_CAPABILITIES: CodecCapabilities = { grayOutput: true };
export const BROWSER_CAPABILITIES: CodecCapabilities = { grayOutput: false };

export interface ContractEnv {
  codec: ImageCodec;
  capabilities: CodecCapabilities;
  /** Decode a JPEG to pixels. It must ignore EXIF orientation and ICC profiles. */
  decode(jpeg: Uint8Array): Promise<DecodedImage>;
  /** JPEG inputs keyed by `JpegSpec.name`, encoded from `synthesize(spec)` (see `JPEG_SPECS`). */
  jpegFixtures: Record<string, Uint8Array>;
  /** A single codec call slower than this counts as a hang. Default 20 s. */
  timeoutMs?: number;
}

export type CaseStatus = 'pass' | 'fail';
export type InfoValue = string | number | boolean | null;

/** JSON-serializable, so browser results can cross page.evaluate / postMessage unchanged. */
export interface CaseResult {
  name: string;
  status: CaseStatus;
  failures: string[];
  info: Record<string, InfoValue>;
  ms: number;
}

// ---------------------------------------------------------------------------------------------
// Synthetic images

export type Pattern = 'photo' | 'smooth';

export interface SynthSpec {
  width: number;
  height: number;
  components: ColorComponents;
  /** 'photo' adds deterministic noise on top of the smooth gradients and blocks. */
  pattern: Pattern;
  seed: number;
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Gradients, low-frequency waves and a 4x4 block pattern in normalized coordinates (so the
 * picture is the same at every size), optionally with noise. Not symmetric under flips or
 * rotations, so a transposed or mirrored result is caught by the resemblance check.
 */
export function synthesize(spec: SynthSpec): Uint8Array {
  const { width: w, height: h, components: c } = spec;
  const out = new Uint8Array(w * h * c);
  const rnd = prng(spec.seed);
  const amp = spec.pattern === 'photo' ? 28 : 0;
  let o = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const block = ((Math.floor(u * 4) + Math.floor(v * 4)) & 1 ? 22 : -22) + (u < 0.25 && v < 0.5 ? 30 : 0);
      const r = 50 + 150 * u + 25 * Math.sin(2 * Math.PI * (2 * u + v)) + block;
      const g = 40 + 170 * v + block;
      const b = 128 + 80 * Math.cos(2 * Math.PI * (u - 1.5 * v)) - block;
      if (c === 1) {
        out[o++] = clamp8(0.299 * r + 0.587 * g + 0.114 * b + (rnd() - 0.5) * amp);
      } else {
        out[o++] = clamp8(r + (rnd() - 0.5) * amp);
        out[o++] = clamp8(g + (rnd() - 0.5) * amp);
        out[o++] = clamp8(b + (rnd() - 0.5) * amp);
      }
    }
  }
  return out;
}

/** JPEG inputs. The Node side encodes each one with sharp and passes the bytes in. */
export interface JpegSpec extends SynthSpec {
  name: string;
  /** sharp quality 1..100. */
  quality: number;
  progressive?: boolean;
  subsampling?: '4:2:0' | '4:4:4';
  /** Written as an EXIF Orientation tag. PDF renderers ignore it, so codecs must too. */
  exifOrientation?: number;
}

export const JPEG_SPECS: JpegSpec[] = [
  { name: 'rgb-large', width: 2400, height: 1800, components: 3, pattern: 'photo', seed: 11, quality: 92 },
  { name: 'gray-large', width: 1000, height: 700, components: 1, pattern: 'photo', seed: 12, quality: 90 },
  { name: 'rgb-small', width: 300, height: 200, components: 3, pattern: 'photo', seed: 13, quality: 90 },
  { name: 'rgb-progressive', width: 900, height: 600, components: 3, pattern: 'photo', seed: 14, quality: 90, progressive: true },
  { name: 'rgb-444-odd', width: 1203, height: 805, components: 3, pattern: 'photo', seed: 15, quality: 90, subsampling: '4:4:4' },
  { name: 'rgb-exif-rot90', width: 600, height: 400, components: 3, pattern: 'smooth', seed: 16, quality: 90, exifOrientation: 6 },
];

export function jpegSpec(name: string): JpegSpec {
  const s = JPEG_SPECS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown JPEG spec ${name}`);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** Mean absolute error of 16x16-cell averages must stay under this (0..255 scale). */
export const MAX_CELL_MAE = 8;
/** Per-channel difference of the global mean must stay under this. */
export const MAX_MEAN_DIFF = 4;

const DEFAULT_OPTS: RecompressOptions = { maxWidth: 1600, maxHeight: 1600, jpegQuality: 0.75, preserveGray: true };

interface Ctx {
  env: ContractEnv;
  failures: string[];
  info: Record<string, InfoValue>;
  check(cond: unknown, msg: string): boolean;
}

function hash(d: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
  return (h >>> 0) ^ d.length;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms (hang)`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function recompress(ctx: Ctx, input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null> {
  // Wrap in an async function so a synchronous throw becomes a rejection.
  return withTimeout((async () => ctx.env.codec.recompress(input, opts))(), ctx.env.timeoutMs ?? 20_000, 'recompress');
}

/** Average over a gx x gy grid of cells, in normalized coordinates, as `comps` channels. */
function cellMeans(img: DecodedImage, comps: ColorComponents, gx: number, gy: number): Float64Array {
  const { width: w, height: h, channels: ch, data } = img;
  const sums = new Float64Array(gx * gy * comps);
  const counts = new Float64Array(gx * gy);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(gy - 1, Math.floor(((y + 0.5) * gy) / h));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(gx - 1, Math.floor(((x + 0.5) * gx) / w));
      const cell = cy * gx + cx;
      const p = (y * w + x) * ch;
      counts[cell]++;
      if (comps === 1) {
        sums[cell] += ch >= 3 ? 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] : data[p];
      } else if (ch >= 3) {
        sums[cell * 3] += data[p];
        sums[cell * 3 + 1] += data[p + 1];
        sums[cell * 3 + 2] += data[p + 2];
      } else {
        sums[cell * 3] += data[p];
        sums[cell * 3 + 1] += data[p];
        sums[cell * 3 + 2] += data[p];
      }
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] /= counts[Math.floor(i / comps)] || 1;
  return sums;
}

/** Compare decoded output with reference pixels at low resolution. */
function resemblance(ref: DecodedImage, out: DecodedImage, comps: ColorComponents): { mae: number; meanDiff: number } {
  // Cells of at least ~3x3 output pixels, so per-pixel JPEG ringing on tiny images averages out.
  const gx = Math.max(1, Math.min(16, Math.ceil(Math.min(ref.width, out.width) / 3)));
  const gy = Math.max(1, Math.min(16, Math.ceil(Math.min(ref.height, out.height) / 3)));
  const a = cellMeans(ref, comps, gx, gy);
  const b = cellMeans(out, comps, gx, gy);
  let mae = 0;
  const meanA = new Float64Array(comps);
  const meanB = new Float64Array(comps);
  for (let i = 0; i < a.length; i++) {
    mae += Math.abs(a[i] - b[i]);
    meanA[i % comps] += a[i];
    meanB[i % comps] += b[i];
  }
  let meanDiff = 0;
  for (let k = 0; k < comps; k++) meanDiff = Math.max(meanDiff, Math.abs(meanA[k] - meanB[k]) / (gx * gy));
  return { mae: mae / a.length, meanDiff };
}

/** Everything the contract requires of one successful recompress call. */
async function verifyOutput(
  ctx: Ctx,
  input: ImageInput,
  opts: RecompressOptions,
  out: ImageOutput | null,
  ref: DecodedImage | null,
): Promise<void> {
  const { check } = ctx;
  if (!check(out, 'codec returned null for a valid, supported input')) return;
  const o = out!;
  check(o.data instanceof Uint8Array && o.data.length > 0, 'output data is a non-empty Uint8Array');
  const info = sniffJpeg(o.data);
  if (!check(info, 'output is not a JPEG that sniffJpeg can parse')) return;
  const j = info!;
  ctx.info.bytes = o.data.length;
  ctx.info.size = `${o.width}x${o.height}x${o.components}`;
  ctx.info.sof = `0x${j.sof.toString(16)}`;
  check(j.width === o.width && j.height === o.height, `SOF size ${j.width}x${j.height} != returned ${o.width}x${o.height}`);
  check(j.components === o.components, `SOF components ${j.components} != returned ${o.components}`);
  check(o.components === 1 || o.components === 3, `components ${o.components} is not 1 or 3`);
  check(j.precision === 8, `precision ${j.precision} != 8`);
  check(j.sof === 0xc0 || j.sof === 0xc1, `SOF 0x${j.sof.toString(16)} is not baseline (0xc0/0xc1)`);
  check(o.data[o.data.length - 2] === 0xff && o.data[o.data.length - 1] === 0xd9, 'output does not end with EOI');

  // Colour model: gray stays gray only when asked to and when the codec can.
  const wantComps = input.components === 1 && opts.preserveGray && ctx.env.capabilities.grayOutput ? 1 : 3;
  check(o.components === wantComps, `components ${o.components}, expected ${wantComps} (capabilities: ${JSON.stringify(ctx.env.capabilities)})`);

  // Geometry: fits, keeps the aspect ratio, never enlarges, and uses the space it has.
  const { width: iw, height: ih } = input;
  const boxW = Math.min(opts.maxWidth, iw);
  const boxH = Math.min(opts.maxHeight, ih);
  check(o.width >= 1 && o.height >= 1, `degenerate size ${o.width}x${o.height}`);
  check(o.width <= opts.maxWidth && o.height <= opts.maxHeight, `${o.width}x${o.height} exceeds max ${opts.maxWidth}x${opts.maxHeight}`);
  check(o.width <= iw && o.height <= ih, `${o.width}x${o.height} enlarges input ${iw}x${ih}`);
  const aspectH = (o.width * ih) / iw;
  const aspectW = (o.height * iw) / ih;
  check(
    Math.abs(o.height - aspectH) <= 1 || Math.abs(o.width - aspectW) <= 1,
    `${o.width}x${o.height} does not keep the aspect ratio of ${iw}x${ih} (±1 px)`,
  );
  check(o.width >= boxW - 1 || o.height >= boxH - 1, `${o.width}x${o.height} is smaller than needed to fit ${boxW}x${boxH}`);

  // Content.
  const dec = await withTimeout(ctx.env.decode(o.data), 20_000, 'decode');
  check(dec.width === o.width && dec.height === o.height, `decoded ${dec.width}x${dec.height} != returned ${o.width}x${o.height}`);
  if (ref) {
    const { mae, meanDiff } = resemblance(ref, dec, input.components);
    ctx.info.mae = Math.round(mae * 100) / 100;
    ctx.info.meanDiff = Math.round(meanDiff * 100) / 100;
    check(mae <= MAX_CELL_MAE, `cell MAE ${mae.toFixed(2)} > ${MAX_CELL_MAE}: output does not resemble the input`);
    // An output of a few pixels is a handful of samples of the browser's resampler, which at
    // extreme ratios (5000:1 in WebKit) doesn't quite average the whole area.
    const meanLimit = o.width * o.height <= 4 ? 2 * MAX_MEAN_DIFF : MAX_MEAN_DIFF;
    check(meanDiff <= meanLimit, `mean colour moved by ${meanDiff.toFixed(2)} > ${meanLimit}`);
  }
  if (o.components === 3 && input.components === 1 && dec.channels >= 3) {
    // Gray in, RGB out: must still be neutral.
    let maxChroma = 0;
    for (let p = 0; p < dec.width * dec.height * dec.channels; p += dec.channels * 7) {
      const d = Math.max(Math.abs(dec.data[p] - dec.data[p + 1]), Math.abs(dec.data[p + 1] - dec.data[p + 2]));
      if (d > maxChroma) maxChroma = d;
    }
    ctx.info.maxChroma = maxChroma;
    check(maxChroma <= 6, `gray input came back coloured (max |R-G|,|G-B| = ${maxChroma})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs

function pixelInput(spec: SynthSpec): { input: ImageInput; ref: DecodedImage } {
  const data = synthesize(spec);
  return {
    input: { kind: 'pixels', data, width: spec.width, height: spec.height, components: spec.components },
    ref: { width: spec.width, height: spec.height, channels: spec.components, data },
  };
}

function jpegInput(ctx: Ctx, name: string): { input: ImageInput; ref: DecodedImage } {
  const spec = jpegSpec(name);
  const data = ctx.env.jpegFixtures[name];
  if (!data) throw new Error(`JPEG fixture ${name} was not provided`);
  return {
    input: { kind: 'jpeg', data, width: spec.width, height: spec.height, components: spec.components },
    ref: { width: spec.width, height: spec.height, channels: spec.components, data: synthesize(spec) },
  };
}

/** Byte offset of the SOS marker, or -1. */
function sosOffset(d: Uint8Array): number {
  let i = 2;
  while (i + 3 < d.length) {
    const m = d[i + 1];
    if (m === 0xda) return i;
    i += 2 + ((d[i + 2] << 8) | d[i + 3]);
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Cases

export interface ContractCase {
  name: string;
  run(ctx: Ctx): Promise<void>;
}

const P = (w: number, h: number, c: ColorComponents, pattern: Pattern = 'photo', seed = w * 31 + h): SynthSpec => ({
  width: w,
  height: h,
  components: c,
  pattern,
  seed,
});

function recompressCase(name: string, make: (ctx: Ctx) => { input: ImageInput; ref: DecodedImage }, opts: Partial<RecompressOptions> = {}): ContractCase {
  return {
    name,
    async run(ctx) {
      const { input, ref } = make(ctx);
      const o = { ...DEFAULT_OPTS, ...opts };
      const before = hash(input.data);
      const out = await recompress(ctx, input, o);
      ctx.check(hash(input.data) === before, 'codec modified its input buffer');
      await verifyOutput(ctx, input, o, out, ref);
    },
  };
}

function qualityCase(name: string, make: (ctx: Ctx) => { input: ImageInput }, opts: Partial<RecompressOptions> = {}): ContractCase {
  return {
    name,
    async run(ctx) {
      const { input } = make(ctx);
      const sizes: number[] = [];
      for (const q of [0.3, 0.6, 0.9]) {
        const out = await recompress(ctx, input, { ...DEFAULT_OPTS, ...opts, jpegQuality: q });
        if (!ctx.check(out, `null output at quality ${q}`)) return;
        sizes.push(out!.data.length);
        ctx.info[`q${q}`] = out!.data.length;
      }
      ctx.check(sizes[0] < sizes[1] && sizes[1] < sizes[2], `sizes are not increasing with quality: ${sizes.join(' < ')}`);
    },
  };
}

/** Invalid input must produce null or a rejection, never a hang (and never garbage). */
function invalidCase(name: string, make: (ctx: Ctx) => ImageInput, lenient = false): ContractCase {
  return {
    name,
    async run(ctx) {
      const input = make(ctx);
      let out: ImageOutput | null = null;
      try {
        out = await recompress(ctx, input, DEFAULT_OPTS);
        ctx.info.outcome = out ? 'output' : 'null';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.info.outcome = 'threw';
        ctx.info.error = msg.slice(0, 160);
        ctx.check(!/hang/.test(msg), msg);
        return;
      }
      if (!out) return;
      if (!lenient) {
        ctx.check(false, `invalid input produced ${out.data.length} bytes of output instead of null/throw`);
        return;
      }
      // Decoders may recover a damaged-but-recognizable JPEG; if so the output must still be sound.
      await verifyOutput(ctx, input, DEFAULT_OPTS, out, null);
    },
  };
}

export const CASES: ContractCase[] = [
  // Raw pixels, both colour models, many shapes.
  recompressCase('pixels rgb 2400x1800 -> 1600 box', () => pixelInput(P(2400, 1800, 3))),
  recompressCase('pixels gray 2000x1500 -> 1600 box', () => pixelInput(P(2000, 1500, 1))),
  recompressCase('pixels rgb 333x217 already small', () => pixelInput(P(333, 217, 3))),
  recompressCase('pixels gray 257x129 already small', () => pixelInput(P(257, 129, 1))),
  recompressCase('pixels rgb 3000x40 extreme wide', () => pixelInput(P(3000, 40, 3, 'smooth'))),
  recompressCase('pixels gray 40x3000 extreme tall', () => pixelInput(P(40, 3000, 1, 'smooth'))),
  recompressCase('pixels rgb 1x1', () => pixelInput(P(1, 1, 3, 'smooth'))),
  recompressCase('pixels gray 1x1', () => pixelInput(P(1, 1, 1, 'smooth'))),
  recompressCase('pixels rgb 7x5 tiny odd', () => pixelInput(P(7, 5, 3, 'smooth'))),
  recompressCase('pixels rgb 1203x805 -> 500x500 box', () => pixelInput(P(1203, 805, 3)), { maxWidth: 500, maxHeight: 500 }),
  recompressCase('pixels rgb 1000x1000 -> 640x480 box', () => pixelInput(P(1000, 1000, 3)), { maxWidth: 640, maxHeight: 480 }),
  recompressCase('pixels rgb 5000x10 -> 1x1 box', () => pixelInput(P(5000, 10, 3, 'smooth')), { maxWidth: 1, maxHeight: 1 }),
  recompressCase('pixels gray preserveGray=false', () => pixelInput(P(640, 480, 1)), { preserveGray: false }),
  // JPEG inputs.
  recompressCase('jpeg rgb 2400x1800 -> 1600 box', (c) => jpegInput(c, 'rgb-large')),
  recompressCase('jpeg gray 1000x700 -> 800 box', (c) => jpegInput(c, 'gray-large'), { maxWidth: 800, maxHeight: 800 }),
  recompressCase('jpeg gray preserveGray=false', (c) => jpegInput(c, 'gray-large'), { preserveGray: false }),
  recompressCase('jpeg rgb 300x200 already small', (c) => jpegInput(c, 'rgb-small')),
  recompressCase('jpeg progressive input -> baseline', (c) => jpegInput(c, 'rgb-progressive'), { maxWidth: 600, maxHeight: 600 }),
  recompressCase('jpeg 4:4:4 1203x805 -> 800 box', (c) => jpegInput(c, 'rgb-444-odd'), { maxWidth: 800, maxHeight: 800 }),
  recompressCase('jpeg EXIF orientation is ignored', (c) => jpegInput(c, 'rgb-exif-rot90')),
  // Quality.
  qualityCase('quality: lower gives smaller (rgb pixels)', () => pixelInput(P(800, 600, 3))),
  qualityCase('quality: lower gives smaller (gray pixels)', () => pixelInput(P(800, 600, 1))),
  qualityCase('quality: lower gives smaller (jpeg input)', (c) => jpegInput(c, 'rgb-large'), { maxWidth: 1000, maxHeight: 1000 }),
  // Behaviour across calls.
  {
    name: 'deterministic output',
    async run(ctx) {
      const { input } = pixelInput(P(640, 480, 3));
      const a = await recompress(ctx, input, DEFAULT_OPTS);
      const b = await recompress(ctx, input, DEFAULT_OPTS);
      if (!ctx.check(a && b, 'null output')) return;
      ctx.check(hash(a!.data) === hash(b!.data), `two runs differ (${a!.data.length} vs ${b!.data.length} bytes)`);
    },
  },
  {
    name: 'concurrent calls are independent',
    async run(ctx) {
      const specs = [P(900, 300, 3), P(300, 900, 1), P(1700, 1700, 3), P(64, 64, 1)];
      const inputs = specs.map((s) => pixelInput(s));
      const opts = { ...DEFAULT_OPTS, maxWidth: 500, maxHeight: 500 };
      const outs = await Promise.all(inputs.map((x) => recompress(ctx, x.input, opts)));
      for (let i = 0; i < outs.length; i++) await verifyOutput(ctx, inputs[i].input, opts, outs[i], inputs[i].ref);
      delete ctx.info.bytes;
      delete ctx.info.size;
    },
  },
  // Invalid data.
  invalidCase('invalid: random bytes', () => {
    const r = prng(99);
    const data = new Uint8Array(4096).map(() => (r() * 256) | 0);
    data[0] = 0x00;
    return { kind: 'jpeg', data, width: 64, height: 64, components: 3 };
  }),
  invalidCase('invalid: SOI followed by garbage', () => {
    const r = prng(98);
    const data = new Uint8Array(4096).map(() => (r() * 256) | 0);
    data.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    return { kind: 'jpeg', data, width: 64, height: 64, components: 3 };
  }),
  invalidCase('invalid: empty data', () => ({ kind: 'jpeg', data: new Uint8Array(0), width: 64, height: 64, components: 3 })),
  invalidCase('invalid: headers only, no scan', (c) => {
    const src = c.env.jpegFixtures['rgb-small'];
    const cut = sosOffset(src);
    if (cut < 0) throw new Error('fixture has no SOS');
    const data = new Uint8Array(cut + 2);
    data.set(src.subarray(0, cut));
    data.set([0xff, 0xd9], cut);
    return { kind: 'jpeg', data, width: 300, height: 200, components: 3 };
  }),
  invalidCase(
    'invalid: truncated in the middle of the scan (lenient)',
    (c) => {
      const src = c.env.jpegFixtures['rgb-small'];
      return { kind: 'jpeg', data: src.slice(0, Math.floor(src.length * 0.6)), width: 300, height: 200, components: 3 };
    },
    true,
  ),
];

export const CASE_NAMES: string[] = CASES.map((c) => c.name);

export async function runCase(env: ContractEnv, c: ContractCase): Promise<CaseResult> {
  const failures: string[] = [];
  const ctx: Ctx = {
    env,
    failures,
    info: {},
    check(cond, msg) {
      if (!cond) failures.push(msg);
      return !!cond;
    },
  };
  const t0 = Date.now();
  try {
    await c.run(ctx);
  } catch (e) {
    failures.push(`threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  return { name: c.name, status: failures.length ? 'fail' : 'pass', failures, info: ctx.info, ms: Date.now() - t0 };
}

/** Run the whole suite (or the named cases) sequentially. */
export async function runContract(env: ContractEnv, only?: string[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of CASES) if (!only || only.includes(c.name)) results.push(await runCase(env, c));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics

/** A short description of a JPEG's marker layout: APPn/ICC/Adobe markers, SOF type, sampling. */
export function describeJpeg(d: Uint8Array): Record<string, InfoValue> {
  const r: Record<string, InfoValue> = {};
  const markers: string[] = [];
  let i = 2;
  while (i + 3 < d.length && d[i] === 0xff) {
    const m = d[i + 1];
    const len = (d[i + 2] << 8) | d[i + 3];
    const seg = i + 4;
    const tag = (n: number) => String.fromCharCode(...d.subarray(seg, seg + n));
    if (m === 0xe0) markers.push(tag(4) === 'JFIF' ? `APP0/JFIF ${d[seg + 5]}.${String(d[seg + 6]).padStart(2, '0')}` : 'APP0');
    else if (m === 0xe1) markers.push(tag(4) === 'Exif' ? 'APP1/Exif' : 'APP1');
    else if (m === 0xe2) markers.push(tag(11) === 'ICC_PROFILE' ? `APP2/ICC(${len - 2}B)` : 'APP2');
    else if (m === 0xee) markers.push(`APP14/Adobe t=${d[seg + 11]}`);
    else if (m === 0xdb) markers.push('DQT');
    else if (m === 0xc4) markers.push('DHT');
    else if (m === 0xdd) markers.push('DRI');
    else if (m === 0xfe) markers.push('COM');
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc8 && m !== 0xcc) {
      markers.push(`SOF${m - 0xc0}`);
      const n = d[seg + 5];
      const samp: string[] = [];
      for (let k = 0; k < n; k++) {
        const s = d[seg + 7 + 3 * k];
        samp.push(`${s >> 4}x${s & 15}`);
      }
      r.sampling = samp.join(',');
      r.componentIds = Array.from(d.subarray(seg + 6, seg + 6 + 3 * n)).filter((_, k) => k % 3 === 0).join(',');
    } else if (m === 0xda) {
      markers.push('SOS');
      break;
    } else markers.push(`FF${m.toString(16).toUpperCase()}`);
    i += 2 + len;
  }
  r.markers = markers.join(' ');
  return r;
}
