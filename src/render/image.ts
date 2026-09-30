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
import { canvas, type Canvas } from './util.ts';

export interface LoadedImage {
  source: Canvas | ImageBitmap;
  /** A stencil mask: paint the current fill where alpha is set (the color channels are unused). */
  stencil: boolean;
  interpolate: boolean;
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

/** Unpack samples into an RGBA canvas, averaging fx x fy blocks. */
function rasterize(s: Samples, fx: number, fy: number): Canvas {
  const { w, h, bpc, n, data } = s;
  const ow = Math.ceil(w / fx);
  const oh = Math.ceil(h / fy);
  const [c, ctx] = canvas(ow, oh);
  const out = ctx.createImageData(ow, oh);
  const o = out.data;
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  const max = (1 << bpc) - 1;
  // Decoded value of each sample value, per component (bpc <= 8); 16-bit samples are computed.
  const lut = bpc <= 8 ? Array.from({ length: n }, (_, k) => Float32Array.from({ length: max + 1 }, (_, v) => s.decode[2 * k] + (v * (s.decode[2 * k + 1] - s.decode[2 * k])) / max)) : undefined;
  const vals = new Float32Array(w * n);
  const raw = new Uint16Array(w * n);
  const rgba = new Uint8ClampedArray(w * 4);
  const acc = fx > 1 || fy > 1 ? new Float32Array(ow * 4) : undefined;
  let accRows = 0;
  for (let y = 0; y < h; y++) {
    const off = y * rowBytes;
    for (let i = 0; i < w * n; i++) {
      let v: number;
      if (bpc === 8) v = data[off + i] ?? 0;
      else if (bpc === 16) v = ((data[off + 2 * i] ?? 0) << 8) | (data[off + 2 * i + 1] ?? 0);
      else {
        const bit = i * bpc;
        v = ((data[off + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
      }
      raw[i] = v;
      const k = i % n;
      vals[i] = lut ? lut[k][v] : s.decode[2 * k] + (v * (s.decode[2 * k + 1] - s.decode[2 * k])) / 65535;
    }
    if (s.stencil) {
      for (let x = 0; x < w; x++) {
        rgba[4 * x] = rgba[4 * x + 1] = rgba[4 * x + 2] = 0;
        rgba[4 * x + 3] = vals[x] < 0.5 ? 255 : 0;
      }
    } else {
      s.cs!.rgbRow(vals, 0, w, rgba, 0);
      for (let x = 0; x < w; x++) {
        let a = 255;
        if (s.key) {
          let inside = true;
          for (let k = 0; k < n && inside; k++) inside = raw[x * n + k] >= s.key[2 * k] && raw[x * n + k] <= s.key[2 * k + 1];
          if (inside) a = 0;
        }
        rgba[4 * x + 3] = a;
      }
    }
    const oy = Math.floor(y / fy);
    if (!acc) {
      o.set(rgba, oy * ow * 4);
      continue;
    }
    for (let x = 0; x < w; x++) {
      const j = Math.floor(x / fx) * 4;
      const a = rgba[4 * x + 3];
      // Premultiplied sums, so transparent pixels don't darken edges.
      acc[j] += rgba[4 * x] * a;
      acc[j + 1] += rgba[4 * x + 1] * a;
      acc[j + 2] += rgba[4 * x + 2] * a;
      acc[j + 3] += a;
    }
    if (++accRows === fy || y === h - 1) {
      for (let x = 0; x < ow; x++) {
        const j = x * 4;
        const cells = accRows * Math.min(fx, w - x * fx);
        const a = acc[j + 3];
        const p = (oy * ow + x) * 4;
        o[p] = a ? acc[j] / a : 0;
        o[p + 1] = a ? acc[j + 1] / a : 0;
        o[p + 2] = a ? acc[j + 2] / a : 0;
        o[p + 3] = a / cells;
      }
      acc.fill(0);
      accRows = 0;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
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
  const [fx, fy] = factors(w, h, opts.width * 1.5, opts.height * 1.5);
  const decodeArr = await nums(doc, await get('Decode', 'D'));
  let source: Canvas | ImageBitmap;
  let bytes = data.data;
  let bpc = stencil ? 1 : (intOf(await get('BitsPerComponent', 'BPC')) ?? 8);
  if (data.codec === 'JPXDecode' || data.codec === 'JBIG2Decode') {
    opts.warn(data.codec === 'JPXDecode' ? 'JPEG 2000 images are not supported yet' : 'JBIG2 images are not supported yet');
    return null;
  }
  if (data.codec === 'DCTDecode') {
    const ow = Math.ceil(w / fx);
    const oh = Math.ceil(h / fy);
    try {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
      source = await createImageBitmap(blob, fx > 1 || fy > 1 ? { resizeWidth: ow, resizeHeight: oh, resizeQuality: 'high' } : {});
    } catch {
      opts.warn('A JPEG image could not be decoded');
      return null;
    }
    // Inverted gray or RGB JPEG (/Decode [1 0 ...]).
    if (decodeArr && decodeArr[0] === 1 && decodeArr[1] === 0 && decodeArr.length <= 6) {
      const [c, ctx] = canvas(ow, oh);
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, ow, oh);
      source = c;
    }
    if (stencil) source = grayToAlpha(source, ow, oh);
  } else {
    if (data.codec === 'CCITTFaxDecode') {
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
    let cs: ColorSpace | undefined;
    let n = 1;
    if (!stencil) {
      cs = await loadColorSpace(doc, await get('ColorSpace', 'CS'), opts.colorSpaces);
      if (!cs) {
        opts.warn('An image has an unsupported color space');
        return null;
      }
      n = cs.n;
    }
    if (![1, 2, 4, 8, 16].includes(bpc) || n < 1) return null;
    const decode = decodeArr && decodeArr.length >= 2 * n ? decodeArr : stencil ? [0, 1] : cs!.defaultDecode(bpc);
    const maskObj = stencil ? undefined : await get('Mask');
    const key = Array.isArray(maskObj) ? await nums(doc, maskObj) : undefined;
    source = rasterize({ w, h, bpc, n, cs, decode, data: bytes, stencil, key: key && key.length >= 2 * n ? key : undefined }, fx, fy);
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
