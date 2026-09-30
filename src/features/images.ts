import type { PdfDocument } from '../core/document.ts';
import { inflateAll } from '../core/flate.ts';
import { loadImage } from '../core/image.ts';
import { intOf, nameOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import { walkPages } from '../core/pages.ts';
import { arrayOf, assertNotEncrypted, dictOf } from './names.ts';

/** An image XObject and where it is used. */
export interface ImageInfo {
  /** Object number of the image stream (pass it to `extractImage`). */
  num: number;
  /** 0-based indexes of the pages that use the image, ascending. */
  pages: number[];
  width: number;
  height: number;
  /** 1 for image masks; 0 when not given (JPX images). */
  bitsPerComponent: number;
  /**
   * Short color space description: 'DeviceRGB', 'ICCBased(RGB)', 'Indexed(DeviceRGB)',
   * 'Separation(Spot 1)', 'DeviceN(4)', ... Absent for image masks and when not given.
   */
  colorSpace?: string;
  /** Filter names in decoding order, abbreviations expanded (e.g. ['FlateDecode', 'DCTDecode']). */
  filters: string[];
  /** Size of the encoded stream data. */
  encodedBytes: number;
  /** A stencil mask (/ImageMask true). */
  imageMask: boolean;
  /** Has a soft mask (/SMask, or /SMaskInData for JPX). */
  hasSoftMask: boolean;
}

/** Image data in a directly usable form. */
export type ExtractedImage =
  /** A complete JPEG file (as stored; CMYK JPEGs are often inverted Adobe JPEGs). */
  | { kind: 'jpeg'; data: Uint8Array }
  /** A JPEG 2000 codestream or JP2 file, as stored. */
  | { kind: 'jpx'; data: Uint8Array }
  /** 8-bit samples, row-major, no padding: gray (1 component) or RGB (3). */
  | { kind: 'pixels'; data: Uint8Array; width: number; height: number; components: 1 | 3 };

const FILTERS: Record<string, string> = {
  Fl: 'FlateDecode', DCT: 'DCTDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
};
const SPACES: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };
/** Largest decoded image `extractImage` produces, in samples. */
const MAX_SAMPLES = 1 << 29;
const MAX_DEPTH = 32;

async function filtersOf(doc: PdfDocument, d: PdfDict): Promise<string[]> {
  const f = await doc.resolve(d.get('Filter'));
  const out: string[] = [];
  for (const x of Array.isArray(f) ? f : f === undefined || f === null ? [] : [f]) {
    const n = nameOf(await doc.resolve(x)) ?? '?';
    out.push(FILTERS[n] ?? n);
  }
  return out;
}

/** Short description of a color space. */
async function describeColorSpace(doc: PdfDocument, o: PdfObj | undefined, depth = 0): Promise<string | undefined> {
  const cs = await doc.resolve(o);
  const a = Array.isArray(cs) ? cs : undefined;
  const n = nameOf(a ? await doc.resolve(a[0]) : cs);
  if (!n) return undefined;
  const family = SPACES[n] ?? n;
  if (!a || depth > 2) return family;
  const arg = await doc.resolve(a[1]);
  if (family === 'ICCBased') {
    const c = arg instanceof PdfDict ? intOf(await doc.resolve(arg.get('N'))) : undefined;
    return `ICCBased(${c === 1 ? 'Gray' : c === 3 ? 'RGB' : c === 4 ? 'CMYK' : (c ?? '?')})`;
  }
  if (family === 'Indexed') return `Indexed(${(await describeColorSpace(doc, a[1], depth + 1)) ?? '?'})`;
  if (family === 'Separation') return `Separation(${nameOf(arg) ?? '?'})`;
  if (family === 'DeviceN') return `DeviceN(${Array.isArray(arg) ? arg.length : '?'})`;
  return family;
}

/**
 * Every image XObject the pages use, in order of first use: images in page resources, inside
 * (nested) Form XObjects, tiling patterns and annotation appearances. Each form is scanned once
 * however many pages share it; cycles are cut. Images are found through resource dictionaries,
 * not by parsing content streams, so one that is listed but never drawn still counts. Inline
 * images are not listed, and soft masks only through `hasSoftMask`.
 * Throws PdfEncryptedError for encrypted documents.
 */
export async function listImages(doc: PdfDocument): Promise<ImageInfo[]> {
  assertNotEncrypted(doc);
  /** Image info by object number; null for objects that are neither images nor forms. */
  const images = new Map<number, ImageInfo | null>();
  /** Images inside a form (or pattern or appearance stream), transitively. */
  const forms = new Map<number, number[]>();

  const describe = async (num: number, hdr: ObjHeader, d: PdfDict): Promise<ImageInfo> => {
    const span = await doc.span(hdr, doc.reader.size);
    const imageMask = (await doc.resolve(d.get('ImageMask'))) === true;
    const info: ImageInfo = {
      num,
      pages: [],
      width: intOf(await doc.resolve(d.get('Width'))) ?? 0,
      height: intOf(await doc.resolve(d.get('Height'))) ?? 0,
      bitsPerComponent: imageMask ? 1 : (intOf(await doc.resolve(d.get('BitsPerComponent'))) ?? 0),
      filters: await filtersOf(doc, d),
      encodedBytes: span.dataEnd >= 0 ? span.dataEnd - span.dataStart : 0,
      imageMask,
      hasSoftMask: (await doc.resolve(d.get('SMask'))) instanceof PdfDict || (intOf(await doc.resolve(d.get('SMaskInData'))) ?? 0) > 0,
    };
    const cs = imageMask ? undefined : await describeColorSpace(doc, d.get('ColorSpace'));
    if (cs) info.colorSpace = cs;
    return info;
  };

  const visit = async (o: PdfObj | undefined, out: Set<number>, path: Set<number>, depth: number): Promise<void> => {
    if (!(o instanceof PdfRef) || path.has(o.num)) return;
    const n = o.num;
    const known = images.get(n);
    const inner = forms.get(n);
    if (known) out.add(n);
    if (inner) for (const i of inner) out.add(i);
    if (known !== undefined || inner) return;
    const hdr = await doc.header(n);
    const d = hdr?.value;
    if (!hdr?.stream || !(d instanceof PdfDict)) return void images.set(n, null);
    if (nameOf(await doc.resolve(d.get('Subtype'))) === 'Image') {
      images.set(n, await describe(n, hdr, d));
      return void out.add(n);
    }
    // Forms, tiling patterns and appearance streams. Without /Resources they use their
    // parent's, which are scanned already.
    const found = new Set<number>();
    path.add(n);
    await scan(d.get('Resources'), found, path, depth + 1);
    path.delete(n);
    forms.set(n, [...found]);
    for (const i of found) out.add(i);
  };

  const scan = async (res: PdfObj | undefined, out: Set<number>, path: Set<number>, depth: number): Promise<void> => {
    const r = depth <= MAX_DEPTH ? await dictOf(doc, res) : undefined;
    for (const key of ['XObject', 'Pattern']) {
      const d = r && (await dictOf(doc, r.get(key)));
      for (const v of d?.map.values() ?? []) await visit(v, out, path, depth);
    }
  };

  for await (const p of walkPages(doc)) {
    const used = new Set<number>();
    const path = new Set<number>();
    await scan(p.resources, used, path, 0);
    for (const a of (await arrayOf(doc, p.dict.get('Annots'))) ?? []) {
      const ap = await dictOf(doc, (await dictOf(doc, a))?.get('AP'));
      const n = ap?.get('N');
      // /N is an appearance stream or a dictionary of them (one per state).
      if (n instanceof PdfRef && (await doc.header(n.num))?.stream) await visit(n, used, path, 0);
      else for (const s of (await dictOf(doc, n))?.map.values() ?? []) await visit(s, used, path, 0);
    }
    for (const i of used) images.get(i)!.pages.push(p.index);
  }
  const out: ImageInfo[] = [];
  for (const v of images.values()) if (v && v.pages.length) out.push(v);
  return out;
}

/** Components of a gray or RGB color space, else undefined. */
async function components(doc: PdfDocument, o: PdfObj | undefined): Promise<1 | 3 | undefined> {
  const cs = await doc.resolve(o);
  const a = Array.isArray(cs) ? cs : undefined;
  const n = nameOf(a ? await doc.resolve(a[0]) : cs);
  if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return 1;
  if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return 3;
  if (n === 'ICCBased' && a) {
    const s = await dictOf(doc, a[1]);
    const c = s && intOf(await doc.resolve(s.get('N')));
    if (c === 1 || c === 3) return c;
  }
  return undefined;
}

const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8;

/**
 * The data of image `num` in a usable form: the JPEG file for DCT images (also when wrapped in
 * Flate), the JPEG 2000 data for JPX images, and decoded samples for 8-bit gray and RGB images
 * that are unfiltered or Flate-compressed (with or without a PNG/TIFF predictor, default
 * /Decode). Returns null for anything else (image masks, CMYK, indexed, other bit depths,
 * CCITT, JBIG2, ...) and for damaged data. Throws PdfEncryptedError for encrypted documents.
 */
export async function extractImage(doc: PdfDocument, num: number): Promise<ExtractedImage | null> {
  assertNotEncrypted(doc);
  const hdr = await doc.header(num);
  const d = hdr?.value;
  if (!hdr?.stream || !(d instanceof PdfDict) || nameOf(await doc.resolve(d.get('Subtype'))) !== 'Image') return null;
  const span = await doc.span(hdr, doc.reader.size);
  if (span.dataEnd < 0) return null;
  const len = span.dataEnd - span.dataStart;
  const chain = (await filtersOf(doc, d)).join(' ');
  if (chain === 'DCTDecode' || chain === 'JPXDecode') {
    const data = await doc.reader.raw(span.dataStart, len);
    return chain === 'JPXDecode' ? { kind: 'jpx', data } : isJpeg(data) ? { kind: 'jpeg', data } : null;
  }
  const dp = await doc.resolve(d.get('DecodeParms'));
  const parms = await dictOf(doc, Array.isArray(dp) ? dp[0] : dp);
  const predictor = (parms && intOf(await doc.resolve(parms.get('Predictor')))) ?? 1;
  if (chain === 'FlateDecode DCTDecode') {
    if (predictor !== 1) return null;
    const { data } = await inflateAll(doc.reader, span.dataStart, len, MAX_SAMPLES);
    return isJpeg(data) ? { kind: 'jpeg', data } : null;
  }
  if ((chain !== '' && chain !== 'FlateDecode') || (await doc.resolve(d.get('ImageMask'))) === true) return null;
  if (intOf(await doc.resolve(d.get('BitsPerComponent'))) !== 8) return null;
  const width = intOf(await doc.resolve(d.get('Width'))) ?? 0;
  const height = intOf(await doc.resolve(d.get('Height'))) ?? 0;
  const comps = await components(doc, d.get('ColorSpace'));
  if (!comps || width < 1 || height < 1 || width * height * comps > MAX_SAMPLES) return null;
  const decode = await arrayOf(doc, d.get('Decode'));
  if (decode) {
    if (decode.length !== 2 * comps) return null;
    for (let i = 0; i < decode.length; i++) if ((await doc.resolve(decode[i])) !== i % 2) return null;
  }
  if (predictor !== 1) {
    if (chain === '' || !(predictor === 2 || (predictor >= 10 && predictor <= 15))) return null;
    const p = parms!;
    if (
      (intOf(await doc.resolve(p.get('Colors'))) ?? 1) !== comps ||
      (intOf(await doc.resolve(p.get('BitsPerComponent'))) ?? 8) !== 8 ||
      (intOf(await doc.resolve(p.get('Columns'))) ?? 1) !== width
    ) {
      return null;
    }
  }
  const r = await loadImage(doc, span, { width, height, comps, icc: false, chain: chain ? 'flate' : 'raw', predictor, mask: false });
  return typeof r === 'string' || r.kind !== 'pixels' ? null : { kind: 'pixels', data: r.data, width, height, components: comps };
}
