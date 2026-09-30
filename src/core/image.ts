import { ascii, latin1 } from './bytes.ts';
import type { ObjSpan, PdfDocument } from './document.ts';
import { Deflater, inflateAll, inflateRange } from './flate.ts';
import { sniffJpeg, type JpegInfo } from './jpeg.ts';
import { encodeName, intOf, nameOf, PdfDict, type PdfObj } from './objects.ts';
import { RowDecoder } from './predictor.ts';
import { GrayDownscaler } from './resize.ts';
import type { ColorComponents, ImageInput } from './types.ts';

/** How to get at the samples of an image we can recompress. */
export interface ImagePlan {
  width: number;
  height: number;
  comps: ColorComponents;
  /** /ColorSpace is ICCBased (kept when the output has the same number of components). */
  icc: boolean;
  chain: 'dct' | 'flate-dct' | 'flate' | 'raw';
  /** /Predictor of a Flate image (1 = none). */
  predictor: number;
  /** /ColorTransform from the DCT decode parameters, if given. */
  colorTransform?: number;
  /** The image is another image's /SMask: it may only be downscaled, losslessly re-encoded. */
  mask: boolean;
}

const FILTER_ALIASES: Record<string, string> = {
  Fl: 'FlateDecode', DCT: 'DCTDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode',
};
const FILTER_REASONS: Record<string, string> = { JPXDecode: 'jpx', JBIG2Decode: 'jbig2', CCITTFaxDecode: 'ccitt' };
/** Largest decoded image we are willing to hold in memory, in samples. */
const MAX_SAMPLES = 1 << 29;

async function colorSpace(doc: PdfDocument, obj: PdfObj | undefined): Promise<{ comps: ColorComponents; icc: boolean } | string> {
  const cs = await doc.resolve(obj);
  const arr = Array.isArray(cs) ? cs : null;
  const name = arr ? nameOf(await doc.resolve(arr[0])) : nameOf(cs);
  switch (name) {
    case 'DeviceGray':
    case 'G':
      return { comps: 1, icc: false };
    case 'DeviceRGB':
    case 'RGB':
      return { comps: 3, icc: false };
    case 'DeviceCMYK':
    case 'CMYK':
      return 'cmyk';
    case 'ICCBased': {
      const s = arr && (await doc.resolve(arr[1]));
      const n = s instanceof PdfDict ? intOf(await doc.resolve(s.get('N'))) : undefined;
      return n === 1 || n === 3 ? { comps: n, icc: true } : n === 4 ? 'cmyk' : 'colorSpace';
    }
    case 'Indexed':
    case 'I':
      return 'indexed';
    case 'Separation':
      return 'separation';
    case 'DeviceN':
      return 'deviceN';
    case 'Lab':
      return 'lab';
    default:
      return cs === undefined ? 'noColorSpace' : 'colorSpace';
  }
}

/**
 * Decide whether an image XObject can be recompressed. Returns null when the dictionary is not
 * an image, a skip reason string, or a plan.
 */
export async function classifyImage(
  doc: PdfDocument,
  d: PdfDict,
  dataLength: number,
  minBytes: number,
  usedAsSoftMask: boolean,
): Promise<ImagePlan | string | null> {
  if (nameOf(await doc.resolve(d.get('Subtype'))) !== 'Image') return null;
  if (d.dup) return 'malformed';
  if ((await doc.resolve(d.get('ImageMask'))) === true) return 'imageMask';
  if (d.get('F') !== undefined) return 'external';

  const f = await doc.resolve(d.get('Filter'));
  const filters: string[] = [];
  for (const x of Array.isArray(f) ? f : f === undefined || f === null ? [] : [f]) {
    const n = nameOf(await doc.resolve(x));
    if (n === undefined) return 'filter';
    filters.push(FILTER_ALIASES[n] ?? n);
  }
  for (const n of filters) if (FILTER_REASONS[n]) return FILTER_REASONS[n];
  const key = filters.join(' ');
  const chain =
    key === 'DCTDecode' ? 'dct' : key === 'FlateDecode' ? 'flate' : key === 'FlateDecode DCTDecode' ? 'flate-dct' : key === '' ? 'raw' : null;
  if (!chain) return 'filter';
  if (dataLength < minBytes) return 'small';

  if ((await doc.resolve(d.get('BitsPerComponent'))) !== 8) return 'bitsPerComponent';
  const width = await doc.resolve(d.get('Width'));
  const height = await doc.resolve(d.get('Height'));
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return 'malformed';
  }
  const cs = await colorSpace(doc, d.get('ColorSpace'));
  // Soft masks stay gray and lossless: only Flate or unfiltered gray masks can be shrunk.
  if (usedAsSoftMask && (typeof cs === 'string' || cs.comps !== 1 || chain === 'dct' || chain === 'flate-dct')) return 'softMask';
  if (typeof cs === 'string') return cs;
  if (width * height * cs.comps > MAX_SAMPLES) return 'tooLarge';

  const decode = await doc.resolve(d.get('Decode'));
  if (decode !== undefined && decode !== null) {
    if (!Array.isArray(decode) || decode.length !== 2 * cs.comps) return 'decode';
    for (let i = 0; i < decode.length; i++) if ((await doc.resolve(decode[i])) !== i % 2) return 'decode';
  }
  if (Array.isArray(await doc.resolve(d.get('Mask')))) return 'colorKeyMask';
  // A mask with /Matte belongs to a pre-blended image and must keep that image's dimensions.
  if (usedAsSoftMask && d.get('Matte') !== undefined) return 'matte';
  const smask = await doc.resolve(d.get('SMask'));
  // A matte colour means the image is pre-blended and must keep its mask's dimensions.
  if (smask instanceof PdfDict && smask.get('Matte') !== undefined) return 'matte';

  const dp = await doc.resolve(d.get('DecodeParms'));
  const parms = async (i: number): Promise<PdfDict | undefined> => {
    const p = await doc.resolve(Array.isArray(dp) ? dp[i] : i === 0 ? dp : undefined);
    return p instanceof PdfDict ? p : undefined;
  };
  const plan: ImagePlan = { width, height, comps: cs.comps, icc: cs.icc, chain, predictor: 1, mask: usedAsSoftMask };
  if (chain === 'flate' || chain === 'flate-dct') {
    const p = await parms(0);
    const predictor = (p && intOf(await doc.resolve(p.get('Predictor')))) ?? 1;
    if (predictor !== 1) {
      if (chain === 'flate-dct' || !(predictor === 2 || (predictor >= 10 && predictor <= 15))) return 'predictor';
      const colors = intOf(await doc.resolve(p!.get('Colors'))) ?? 1;
      const bpc = intOf(await doc.resolve(p!.get('BitsPerComponent'))) ?? 8;
      const columns = intOf(await doc.resolve(p!.get('Columns'))) ?? 1;
      if (colors !== cs.comps || bpc !== 8 || columns !== width) return 'predictor';
      plan.predictor = predictor;
    }
  }
  if (chain === 'dct' || chain === 'flate-dct') {
    const p = await parms(chain === 'dct' ? 0 : 1);
    const ct = p && intOf(await doc.resolve(p.get('ColorTransform')));
    if (ct !== undefined) plan.colorTransform = ct;
  }
  return plan;
}

/** Why a JPEG cannot be handed to a codec, or null if it can. */
function jpegProblem(info: JpegInfo | null, plan: ImagePlan): string | null {
  if (!info) return 'jpegInvalid';
  if (info.components === 4) return 'cmyk';
  if (info.precision !== 8 || (info.sof !== 0xc0 && info.sof !== 0xc1 && info.sof !== 0xc2)) return 'jpegUnsupported';
  if (info.components !== plan.comps || info.width !== plan.width || info.height !== plan.height) return 'jpegMismatch';
  if (plan.comps === 3) {
    // Decoders apply YCbCr->RGB unless an Adobe marker (or R,G,B component ids) says otherwise;
    // the PDF may also override it. Only pass on JPEGs where everyone agrees on "transform".
    if (info.adobeTransform === 0 || (info.adobeTransform < 0 && info.rgbIds)) return 'jpegTransform';
    if (plan.colorTransform !== undefined && plan.colorTransform !== 1) return 'jpegTransform';
  }
  return null;
}

/** Read and decode what the codec needs. Returns a skip reason string on failure. */
export async function loadImage(doc: PdfDocument, span: ObjSpan, plan: ImagePlan): Promise<ImageInput | string> {
  const { width, height, comps } = plan;
  const start = span.dataStart;
  const len = span.dataEnd - span.dataStart;
  if (plan.chain === 'dct' || plan.chain === 'flate-dct') {
    let data: Uint8Array;
    if (plan.chain === 'dct') {
      data = await doc.reader.raw(start, len);
    } else {
      const r = await inflateAll(doc.reader, start, len, MAX_SAMPLES);
      data = r.data;
      // Accept an inflate error only if the JPEG itself is complete.
      let e = data.length - 1;
      while (e > 0 && data[e] !== 0xd9) e--;
      if (!r.complete && !(e > 0 && data[e - 1] === 0xff)) return 'decodeError';
    }
    const problem = jpegProblem(sniffJpeg(data), plan);
    return problem ?? { kind: 'jpeg', data, width, height, components: comps };
  }
  const rowBytes = width * comps;
  const size = rowBytes * height;
  if (plan.chain === 'raw') {
    if (len < size) return 'decodeError';
    return { kind: 'pixels', data: await doc.reader.raw(start, size), width, height, components: comps };
  }
  const out = new Uint8Array(size);
  const dec: RowDecoder = new RowDecoder(plan.predictor, comps, 8, width, (row): boolean => {
    out.set(row, (dec.rows - 1) * rowBytes);
    return dec.rows >= height;
  });
  try {
    await inflateRange(doc.reader, start, len, (c) => dec.push(c));
  } catch (e) {
    if (e instanceof Error && e.name === 'PdfSyntaxError') return 'decodeError';
    throw e;
  }
  if (dec.rows < height) return 'decodeError';
  return { kind: 'pixels', data: out, width, height, components: comps };
}

/** Check codec output. Returns the JPEG's own header info, or null if unusable. */
export function checkOutput(data: Uint8Array): JpegInfo | null {
  const info = sniffJpeg(data);
  if (!info || info.precision !== 8 || (info.components !== 1 && info.components !== 3)) return null;
  if (info.sof !== 0xc0 && info.sof !== 0xc1 && info.sof !== 0xc2) return null;
  if (!info.width || !info.height) return null;
  return info;
}

/**
 * Shrink a soft mask to (ow, oh) in one streaming pass: inflate and un-predict row by row,
 * area-average, and re-deflate with the PNG Up predictor. Memory is a few output rows plus the
 * compressed result. Returns the new Flate data, or a skip reason.
 */
export async function shrinkMask(doc: PdfDocument, span: ObjSpan, plan: ImagePlan, ow: number, oh: number): Promise<Uint8Array | string> {
  const { width, height } = plan;
  const deflater = new Deflater();
  const rowLen = ow + 1;
  const perBatch = Math.max(1, Math.floor((1 << 16) / rowLen));
  let batch = new Uint8Array(rowLen * perBatch);
  let fill = 0;
  const prev = new Uint8Array(ow);
  const scaler = new GrayDownscaler(width, height, ow, oh, (row) => {
    batch[fill] = 2; // PNG Up
    for (let j = 0; j < ow; j++) batch[fill + 1 + j] = row[j] - prev[j];
    prev.set(row);
    fill += rowLen;
    if (fill === batch.length) {
      void deflater.write(batch);
      batch = new Uint8Array(batch.length);
      fill = 0;
    }
  });
  const dec: RowDecoder = new RowDecoder(plan.predictor, 1, 8, width, (row): boolean => {
    scaler.push(row);
    return dec.rows >= height;
  });
  const start = span.dataStart;
  const len = span.dataEnd - start;
  try {
    if (plan.chain === 'raw') {
      for (let p = start, end = start + Math.min(len, width * height); p < end && dec.rows < height; p += 1 << 16) {
        dec.push(await doc.reader.raw(p, Math.min(1 << 16, end - p)));
      }
    } else {
      await inflateRange(doc.reader, start, len, (c) => dec.push(c));
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'PdfSyntaxError') return 'decodeError';
    throw e;
  }
  if (dec.rows < height) return 'decodeError';
  if (fill) void deflater.write(batch.subarray(0, fill));
  return deflater.finish();
}

/**
 * The new value of a rewritten image: all original keys in their original order and form,
 * except the ones in `updates`, which are replaced (or removed when null); new keys go last.
 */
export function rewriteImage(d: PdfDict, data: Uint8Array, updates: Map<string, string | null>): Uint8Array[] {
  updates.set('Length', String(data.length));
  updates.set('Decode', null);
  updates.set('DL', null);
  let s = '<<';
  for (const [k, raw] of d.raw) {
    const u = updates.get(k);
    if (u === undefined) s += `${encodeName(k)} ${latin1(raw)}\n`;
    else if (u !== null) s += `${encodeName(k)} ${u}\n`;
    updates.delete(k);
  }
  for (const [k, u] of updates) if (u !== null) s += `${encodeName(k)} ${u}\n`;
  return [ascii(s + '>>\nstream\n'), data, ascii('\nendstream')];
}

/** The new value of a recompressed JPEG image. */
export function buildImageObject(d: PdfDict, data: Uint8Array, info: JpegInfo, keepColorSpace: boolean): Uint8Array[] {
  const updates = new Map<string, string | null>([
    ['Width', String(info.width)],
    ['Height', String(info.height)],
    ['BitsPerComponent', '8'],
    ['Filter', '/DCTDecode'],
    ['DecodeParms', null],
  ]);
  if (!keepColorSpace) updates.set('ColorSpace', info.components === 1 ? '/DeviceGray' : '/DeviceRGB');
  return rewriteImage(d, data, updates);
}

/** The new value of a shrunk soft mask (Flate, PNG Up predictor). */
export function buildMaskObject(d: PdfDict, data: Uint8Array, width: number, height: number): Uint8Array[] {
  return rewriteImage(
    d,
    data,
    new Map<string, string | null>([
      ['Width', String(width)],
      ['Height', String(height)],
      ['BitsPerComponent', '8'],
      ['Filter', '/FlateDecode'],
      ['DecodeParms', `<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${width} >>`],
    ]),
  );
}
