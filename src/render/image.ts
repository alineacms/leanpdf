/**
 * Image XObjects and inline images for rendering. JPEG data goes to the browser's decoder
 * (createImageBitmap, which also resizes); other samples are unpacked row by row, mapped through
 * /Decode and the color space into RGBA, and box-averaged down when the image is much larger than
 * its footprint on the page, so a huge image never needs more than its drawn size. Soft masks,
 * stencil masks and color-key masks become the alpha channel.
 */
import { ccittDecode } from '../core/ccitt.ts';
import { decodeStream, type Decoded } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { intOf, numOf, PdfDict, PdfName, PdfRef, type PdfObj } from '../core/objects.ts';
import { loadColorSpace, type ColorSpace } from './colorspace.ts';
import { decodeJpeg } from './jpeg.ts';
import { canvas, type Canvas } from './util.ts';

export interface LoadedImage {
  source: Canvas | ImageBitmap;
  /** A stencil mask: paint the current fill where alpha is set (the color channels are unused). */
  stencil: boolean;
  interpolate: boolean;
}

/** A decoded image and the draw size it was decoded for (null: it can't be drawn). */
export interface CachedImage {
  img: LoadedImage | null;
  w: number;
  h: number;
}

const area = (e: CachedImage) => (e.img ? e.img.source.width * e.img.source.height : 0);

/** Decoded images of a document by object number, kept across renders up to `budget` pixels. */
export class ImageCache {
  private readonly map = new Map<number, CachedImage>();
  private pixels = 0;
  private readonly budget: number;

  constructor(budget = 1 << 24) {
    this.budget = budget;
  }

  get(num: number): CachedImage | undefined {
    const e = this.map.get(num);
    // Map order is the eviction order: most recently used last.
    if (e) {
      this.map.delete(num);
      this.map.set(num, e);
    }
    return e;
  }

  set(num: number, e: CachedImage): void {
    const old = this.map.get(num);
    if (old) this.pixels -= area(old);
    this.map.delete(num);
    this.map.set(num, e);
    this.pixels += area(e);
    for (const [k, v] of this.map) {
      if (this.pixels <= this.budget || k === num) break;
      this.map.delete(k);
      this.pixels -= area(v);
    }
  }
}

/** Reads an image dictionary entry by full or abbreviated key: resolved, or as written with `raw`. */
export type ImageDict = (key: string, abbr?: string, raw?: boolean) => Promise<PdfObj | undefined>;

/** Largest decoded image kept, in pixels (larger ones are averaged down). */
const MAX_PIXELS = 1 << 25;
const MAX_DATA = 1 << 28;
const GRAY = /* @__PURE__ */ new PdfName('DeviceGray');

export interface ImageOptions {
  /** Draw size in device pixels: images are reduced to about this when much larger. */
  width: number;
  height: number;
  colorSpaces?: PdfDict;
  warn(message: string): void;
}

/** Integer reduction factors for an image of w x h drawn at about tw x th pixels. */
function factors(w: number, h: number, tw: number, th: number): [number, number] {
  let fx = Math.max(1, Math.floor(w / Math.max(1, tw)));
  let fy = Math.max(1, Math.floor(h / Math.max(1, th)));
  while (Math.ceil(w / fx) * Math.ceil(h / fy) > MAX_PIXELS) {
    fx++;
    fy++;
  }
  return [fx, fy];
}

async function nums(doc: PdfDocument, o: PdfObj | undefined): Promise<number[] | undefined> {
  const a = await doc.resolve(o);
  if (!Array.isArray(a)) return undefined;
  const out: number[] = [];
  for (const x of a) out.push(numOf(await doc.resolve(x)) ?? 0);
  return out;
}

/** CCITT parameters from /DecodeParms. */
function ccittParams(p: PdfDict | undefined, w: number, h: number): Parameters<typeof ccittDecode>[1] {
  const g = (k: string) => p?.get(k);
  return {
    K: intOf(g('K')) ?? 0,
    Columns: intOf(g('Columns')) ?? w,
    Rows: intOf(g('Rows')) ?? h,
    EndOfLine: g('EndOfLine') === true,
    EncodedByteAlign: g('EncodedByteAlign') === true,
    EndOfBlock: g('EndOfBlock') !== false,
    BlackIs1: g('BlackIs1') === true,
    DamagedRowsBeforeError: intOf(g('DamagedRowsBeforeError')) ?? 0,
  };
}

/** A canvas whose alpha channel is the gray level of `src` (an opaque bitmap or canvas). */
function grayToAlpha(src: Canvas | ImageBitmap, w: number, h: number): Canvas {
  const [c, ctx] = canvas(w, h, true);
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i];
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Keep `target` only where `mask` has alpha (scaled to cover it). */
function applyAlpha(target: Canvas, mask: Canvas): void {
  const ctx = target.getContext('2d')!;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, target.width, target.height);
  ctx.globalCompositeOperation = 'source-over';
}

interface Samples {
  w: number;
  h: number;
  bpc: number;
  cs?: ColorSpace;
  /** Components per pixel. */
  n: number;
  decode: number[];
  data: Uint8Array;
  /** Stencil: alpha where the (decoded) sample is 0. */
  stencil: boolean;
  /** Color-key ranges in sample values, [min, max] per component. */
  key?: number[];
}

/** 8-bit DeviceRGB samples as they are: no /Decode, no color key. */
const plainRgb = (s: Samples) => s.n === 3 && s.bpc === 8 && !!s.cs?.direct && !s.key && s.decode.every((v, i) => v === (i & 1));

/**
 * Box-average samples before color conversion, straight from the data, where that gives the same
 * result: one-component spaces other than Indexed, and plain RGB. False for anything else.
 */
function reduceSamples(s: Samples, fx: number, fy: number, rowBytes: number, o: Uint8ClampedArray): boolean {
  const { w, h, bpc, n, data, decode, cs } = s;
  if (s.stencil || s.key || !cs) return false;
  const gray = n === 1 && bpc <= 8 && cs.name !== 'Indexed';
  if (!gray && !plainRgb(s)) return false;
  const ow = Math.ceil(w / fx);
  const max = (1 << bpc) - 1;
  const shift = 8 - bpc;
  // Sums down each sample column over fy rows, then across groups of fx columns.
  const col = new Float64Array(w * n);
  let lut: Uint32Array | undefined;
  if (gray) {
    // RGBA for averages in 256 steps across the sample range.
    const px = new Uint8ClampedArray(1024);
    cs.rgbRow(Float32Array.from({ length: 256 }, (_, t) => decode[0] + (t * (decode[1] - decode[0])) / 255), 0, 256, px, 0);
    for (let t = 0; t < 256; t++) px[4 * t + 3] = 255;
    lut = new Uint32Array(px.buffer);
  }
  const o32 = new Uint32Array(o.buffer, o.byteOffset, o.length >> 2);
  let rows = 0;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const off = y * rowBytes;
    if (bpc === 8) for (let i = 0; i < w * n; i++) col[i] += data[off + i];
    else for (let x = 0, bit = 0; x < w; x++, bit += bpc) col[x] += (data[off + (bit >> 3)] >> (shift - (bit & 7))) & max;
    if (++rows < fy && y < h - 1) continue;
    for (let c = 0, x = 0; c < ow; c++, p++) {
      const end = Math.min(w, x + fx);
      const cells = rows * (end - x);
      if (lut) {
        let sum = 0;
        for (; x < end; x++) sum += col[x];
        o32[p] = lut[Math.round((sum * 255) / (cells * max))];
      } else {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 3 * x; x < end; x++, i += 3) {
          r += col[i];
          g += col[i + 1];
          b += col[i + 2];
        }
        o[4 * p] = r / cells;
        o[4 * p + 1] = g / cells;
        o[4 * p + 2] = b / cells;
        o[4 * p + 3] = 255;
      }
    }
    col.fill(0);
    rows = 0;
  }
  return true;
}

/**
 * A reader for one row of samples at byte `off`, writing RGBA pixels to `d8` (or `d32`, the same
 * buffer) from pixel `p`. Returns it with whether alpha can be below 255.
 */
function rowReader(s: Samples): [(off: number, d8: Uint8ClampedArray, d32: Uint32Array, p: number) => void, boolean] {
  const { w, bpc, n, data, decode, key } = s;
  const max = (1 << bpc) - 1;
  if (n === 1 && bpc <= 8) {
    // One component: a table from sample value to RGBA covers /Decode, color, key and stencil.
    const px = new Uint8ClampedArray(4 * (max + 1));
    const vals = Float32Array.from({ length: max + 1 }, (_, v) => decode[0] + (v * (decode[1] - decode[0])) / max);
    if (!s.stencil) s.cs!.rgbRow(vals, 0, max + 1, px, 0);
    for (let v = 0; v <= max; v++) px[4 * v + 3] = s.stencil ? (vals[v] < 0.5 ? 255 : 0) : key && v >= key[0] && v <= key[1] ? 0 : 255;
    // Same byte order in and out, so the platform's endianness doesn't matter.
    const lut = new Uint32Array(px.buffer);
    const shift = 8 - bpc;
    const read =
      bpc === 8
        ? (off: number, _: Uint8ClampedArray, d: Uint32Array, p: number) => {
            for (let x = 0; x < w; x++) d[p + x] = lut[data[off + x]];
          }
        : (off: number, _: Uint8ClampedArray, d: Uint32Array, p: number) => {
            for (let x = 0, bit = 0; x < w; x++, bit += bpc) d[p + x] = lut[(data[off + (bit >> 3)] >> (shift - (bit & 7))) & max];
          };
    return [read, s.stencil || !!key];
  }
  if (plainRgb(s)) {
    return [
      (off, d, _, p) => {
        for (let x = 0, i = off, j = 4 * p; x < w; x++, i += 3, j += 4) {
          d[j] = data[i];
          d[j + 1] = data[i + 1];
          d[j + 2] = data[i + 2];
          d[j + 3] = 255;
        }
      },
      false,
    ];
  }
  // Decoded value of each sample value, per component (bpc <= 8); 16-bit samples are computed.
  const lut = bpc <= 8 ? Array.from({ length: n }, (_, k) => Float32Array.from({ length: max + 1 }, (_, v) => decode[2 * k] + (v * (decode[2 * k + 1] - decode[2 * k])) / max)) : undefined;
  const vals = new Float32Array(w * n);
  const raw = new Uint16Array(w * n);
  return [
    (off, d, _, p) => {
      for (let i = 0, k = 0; i < w * n; i++, k = k + 1 === n ? 0 : k + 1) {
        let v: number;
        if (bpc === 8) v = data[off + i];
        else if (bpc === 16) v = (data[off + 2 * i] << 8) | data[off + 2 * i + 1];
        else {
          const bit = i * bpc;
          v = (data[off + (bit >> 3)] >> (8 - bpc - (bit & 7))) & max;
        }
        raw[i] = v;
        vals[i] = lut ? lut[k][v] : decode[2 * k] + (v * (decode[2 * k + 1] - decode[2 * k])) / 65535;
      }
      s.cs!.rgbRow(vals, 0, w, d, 4 * p);
      for (let x = 0; x < w; x++) {
        let a = 255;
        if (key) {
          let inside = true;
          for (let k = 0; k < n && inside; k++) inside = raw[x * n + k] >= key[2 * k] && raw[x * n + k] <= key[2 * k + 1];
          if (inside) a = 0;
        }
        d[4 * (p + x) + 3] = a;
      }
    },
    !!key,
  ];
}

/** Unpack samples into an RGBA canvas, averaging fx x fy blocks. */
function rasterize(s: Samples, fx: number, fy: number): Canvas {
  const { w, h, bpc, n } = s;
  const ow = Math.ceil(w / fx);
  const oh = Math.ceil(h / fy);
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  // Short data reads as zeros, and every read stays in bounds.
  if (s.data.length < rowBytes * h) {
    const full = new Uint8Array(rowBytes * h);
    full.set(s.data);
    s = { ...s, data: full };
  }
  const [c, ctx] = canvas(ow, oh);
  const out = ctx.createImageData(ow, oh);
  const o = out.data;
  if ((fx > 1 || fy > 1) && reduceSamples(s, fx, fy, rowBytes, o)) {
    ctx.putImageData(out, 0, 0);
    return c;
  }
  const [read, alpha] = rowReader(s);
  if (fx === 1 && fy === 1) {
    const o32 = new Uint32Array(o.buffer, o.byteOffset, o.length >> 2);
    for (let y = 0; y < h; y++) read(y * rowBytes, o, o32, y * w);
    ctx.putImageData(out, 0, 0);
    return c;
  }
  const row = new Uint8ClampedArray(w * 4);
  const row32 = new Uint32Array(row.buffer);
  const col = Int32Array.from({ length: w }, (_, x) => Math.floor(x / fx) * 4);
  const acc = new Float64Array(ow * 4);
  let rows = 0;
  let p = 0;
  for (let y = 0; y < h; y++) {
    read(y * rowBytes, row, row32, 0);
    if (alpha) {
      // Premultiplied sums, so transparent pixels don't darken edges.
      for (let x = 0, i = 0; x < w; x++, i += 4) {
        const j = col[x];
        const a = row[i + 3];
        acc[j] += row[i] * a;
        acc[j + 1] += row[i + 1] * a;
        acc[j + 2] += row[i + 2] * a;
        acc[j + 3] += a;
      }
    } else {
      for (let x = 0, i = 0; x < w; x++, i += 4) {
        const j = col[x];
        acc[j] += row[i];
        acc[j + 1] += row[i + 1];
        acc[j + 2] += row[i + 2];
      }
    }
    if (++rows < fy && y < h - 1) continue;
    for (let x = 0, j = 0; x < ow; x++, j += 4, p += 4) {
      const cells = rows * Math.min(fx, w - x * fx);
      if (alpha) {
        const a = acc[j + 3];
        o[p] = a ? acc[j] / a : 0;
        o[p + 1] = a ? acc[j + 1] / a : 0;
        o[p + 2] = a ? acc[j + 2] / a : 0;
        o[p + 3] = a / cells;
      } else {
        o[p] = acc[j] / cells;
        o[p + 1] = acc[j + 1] / cells;
        o[p + 2] = acc[j + 2] / cells;
        o[p + 3] = 255;
      }
    }
    acc.fill(0);
    rows = 0;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

/**
 * Decode a JPEG of w x h to at least tw x th when smaller. WebCodecs' ImageDecoder decodes at 1/8
 * steps of the full size directly (Chromium picks the largest step within the size asked for),
 * which is several times faster than decoding it all and resizing, the fallback.
 */
async function browserJpeg(bytes: Uint8Array, w: number, h: number, tw: number, th: number): Promise<ImageBitmap> {
  const k = Math.max(1, Math.ceil(Math.max((8 * tw) / w, (8 * th) / h)));
  if (k < 8 && typeof ImageDecoder === 'function') {
    try {
      const dec = new ImageDecoder({ data: bytes as Uint8Array<ArrayBuffer>, type: 'image/jpeg', desiredWidth: Math.ceil((k * w) / 8), desiredHeight: Math.ceil((k * h) / 8) });
      try {
        const { image } = await dec.decode();
        try {
          return await createImageBitmap(image);
        } finally {
          image.close();
        }
      } finally {
        dec.close();
      }
    } catch {
      // Unsupported here, or a JPEG it rejects: try the other way.
    }
  }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  const [fx, fy] = factors(w, h, tw, th);
  return createImageBitmap(blob, fx > 1 || fy > 1 ? { resizeWidth: Math.ceil(w / fx), resizeHeight: Math.ceil(h / fy), resizeQuality: 'high' } : {});
}

/**
 * Decode an image to something drawImage takes, reduced toward `opts.width` x `opts.height`.
 * Null (with a warning) for images that can't be drawn: JPEG 2000 and JBIG2 for now, broken data.
 */
export async function loadImage(doc: PdfDocument, get: ImageDict, data: Decoded | null, opts: ImageOptions): Promise<LoadedImage | null> {
  const w = intOf(await get('Width', 'W')) ?? 0;
  const h = intOf(await get('Height', 'H')) ?? 0;
  if (w <= 0 || h <= 0 || w * h > MAX_DATA || !data) return null;
  const stencil = (await get('ImageMask', 'IM')) === true;
  const interpolate = (await get('Interpolate', 'I')) === true;
  const decodeArr = await nums(doc, await get('Decode', 'D'));
  let source: Canvas | ImageBitmap | undefined;
  let bytes = data.data;
  let bpc = stencil ? 1 : (intOf(await get('BitsPerComponent', 'BPC')) ?? 8);
  // Sample grid size: a JPEG decoded here may come out reduced.
  let sw = w;
  let sh = h;
  if (data.codec === 'JPXDecode' || data.codec === 'JBIG2Decode') {
    opts.warn(data.codec === 'JPXDecode' ? 'JPEG 2000 images are not supported yet' : 'JBIG2 images are not supported yet');
    return null;
  }
  const cs = stencil ? undefined : await loadColorSpace(doc, await get('ColorSpace', 'CS'), opts.colorSpaces);
  const n = stencil ? 1 : (cs?.n ?? 0);
  if (data.codec === 'DCTDecode') {
    // Browsers read every CMYK JPEG as Adobe-inverted, while in PDF inversion is up to /Decode,
    // and know nothing of /ColorTransform. Those, stencil masks, and JPEGs the browser rejects
    // are decoded here, reduced by up to 8.
    const ratio = Math.min(w / Math.max(1, opts.width), h / Math.max(1, opts.height));
    const reduce = Math.max(0, Math.min(3, Math.floor(Math.log2(ratio))));
    const ct = intOf(data.parms?.get('ColorTransform'));
    let jpeg = n === 4 || stencil || ct !== undefined ? decodeJpeg(bytes, reduce, ct) : null;
    if (jpeg?.components !== n) {
      jpeg = null;
      try {
        source = await browserJpeg(bytes, w, h, opts.width, opts.height);
      } catch {
        const j = decodeJpeg(bytes, reduce, ct);
        if (j?.components === n) jpeg = j;
      }
    }
    if (jpeg) {
      bytes = jpeg.data;
      sw = jpeg.width;
      sh = jpeg.height;
      bpc = 8;
    } else if (!source) {
      opts.warn('A JPEG image could not be decoded');
      return null;
    } else {
      // Inverted gray or RGB (/Decode [1 0 ...]); a stencil mask paints where samples are 0.
      const inverted = decodeArr?.[0] === 1 && decodeArr[1] === 0;
      if (stencil ? !inverted : inverted && decodeArr.length <= 6) {
        const [c, ctx] = canvas(source.width, source.height);
        ctx.drawImage(source, 0, 0);
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        source = c;
      }
      if (stencil) source = grayToAlpha(source, source.width, source.height);
    }
  } else if (data.codec === 'CCITTFaxDecode') {
    const bits = ccittDecode(bytes, ccittParams(data.parms, w, h));
    if (!bits) {
      opts.warn('A fax-encoded image could not be decoded');
      return null;
    }
    // Rows lost to damage are padded white rather than read as black.
    const p = ccittParams(data.parms, w, h);
    const full = Math.ceil(w / 8) * h;
    bytes = bits.length >= full ? bits : Uint8Array.from({ length: full }, (_, i) => (i < bits.length ? bits[i] : p.BlackIs1 ? 0 : 255));
    bpc = 1;
  }
  if (!source) {
    if (!stencil && !cs) {
      opts.warn('An image has an unsupported color space');
      return null;
    }
    if (![1, 2, 4, 8, 16].includes(bpc) || n < 1) return null;
    const decode = decodeArr && decodeArr.length >= 2 * n ? decodeArr : stencil ? [0, 1] : cs!.defaultDecode(bpc);
    const maskObj = stencil ? undefined : await get('Mask');
    const key = Array.isArray(maskObj) ? await nums(doc, maskObj) : undefined;
    const [fx, fy] = factors(sw, sh, opts.width, opts.height);
    source = rasterize({ w: sw, h: sh, bpc, n, cs, decode, data: bytes, stencil, key: key && key.length >= 2 * n ? key : undefined }, fx, fy);
  }

  // Soft mask, or an explicit stencil mask, as the alpha channel.
  if (!stencil) {
    const smask = await get('SMask', undefined, true);
    const mask = await get('Mask', undefined, true);
    const ref = smask instanceof PdfRef ? smask : mask instanceof PdfRef ? mask : undefined;
    const alpha = ref && (await loadMask(doc, ref, ref === smask, source.width, source.height, opts));
    if (alpha) {
      if (!(source instanceof OffscreenCanvas)) {
        const [c, ctx] = canvas(source.width, source.height);
        ctx.drawImage(source, 0, 0);
        source = c;
      }
      applyAlpha(source, alpha);
    }
  }
  return { source, stencil, interpolate };
}

/** A soft mask (gray levels) or stencil mask (painted samples) as an alpha canvas of about w x h. */
async function loadMask(doc: PdfDocument, ref: PdfRef, soft: boolean, w: number, h: number, opts: ImageOptions): Promise<Canvas | null> {
  const hdr = await doc.header(ref.num);
  const d = hdr?.value;
  if (!hdr?.stream || !(d instanceof PdfDict)) return null;
  // A soft mask is read as a gray image; masks of masks are ignored.
  const get: ImageDict = async (k, a, raw) =>
    k === 'SMask' || k === 'Mask' ? undefined : soft && k === 'ColorSpace' ? GRAY : soft && k === 'ImageMask' ? false : raw ? d.get(k) : doc.resolve(d.get(k) ?? (a ? d.get(a) : undefined));
  const img = await loadImage(doc, get, await decodeStream(doc, hdr, MAX_DATA), { ...opts, width: w, height: h });
  if (!img) return null;
  if (img.stencil) return img.source instanceof OffscreenCanvas ? img.source : grayToAlpha(img.source, w, h);
  return grayToAlpha(img.source, img.source.width, img.source.height);
}
