import type { ObjSpan, PdfDocument } from './document.ts';
import { isFatal } from './errors.ts';
import { buildImageObject, buildMaskObject, checkOutput, classifyImage, loadImage, shrinkMask, type ImagePlan } from './image.ts';
import { PdfDict, PdfRef } from './objects.ts';
import type { ObjHeader } from './objread.ts';
import { fitInside } from './resize.ts';
import { rewritePdf, type Plugin, type RewriteContext } from './rewrite.ts';
import type { CompressOptions, CompressReport, OutputSink, RandomAccessSource, RecompressOptions } from './types.ts';

type ImageResult = { parts: Uint8Array[]; saved: number } | { reason: string };

const DEFAULTS = {
  maxWidth: 1600,
  maxHeight: 1600,
  jpegQuality: 0.75,
  preserveGray: true,
  minImageBytes: 20_000,
  minSavingsRatio: 0.9,
};

export interface ImagesReport {
  imagesSeen: number;
  imagesRecompressed: number;
  /** Reason -> count. */
  imagesSkipped: Record<string, number>;
}

/** Options for the `compressImages` plugin: `CompressOptions` without the rewrite-level ones. */
export type CompressImagesOptions = Omit<CompressOptions, 'signal' | 'onProgress' | 'concurrency'>;

/**
 * Rewrite plugin that recompresses and downscales raster images, and shrinks soft masks.
 * Its `report` fills in as the rewrite runs.
 */
export function compressImages(options: CompressImagesOptions): Plugin & { report: ImagesReport } {
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const v = (options as Partial<typeof DEFAULTS>)[k];
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  if (!(o.maxWidth >= 1 && o.maxHeight >= 1)) throw new RangeError('maxWidth and maxHeight must be >= 1');
  if (!(o.jpegQuality > 0 && o.jpegQuality <= 1)) throw new RangeError('jpegQuality must be in (0, 1]');
  if (!(o.minSavingsRatio > 0)) throw new RangeError('minSavingsRatio must be > 0');
  const { codec } = options;
  const recompress: RecompressOptions = {
    maxWidth: Math.floor(o.maxWidth),
    maxHeight: Math.floor(o.maxHeight),
    jpegQuality: o.jpegQuality,
    preserveGray: o.preserveGray,
  };
  const report: ImagesReport = { imagesSeen: 0, imagesRecompressed: 0, imagesSkipped: {} };
  const skip = (reason: string): void => {
    report.imagesSkipped[reason] = (report.imagesSkipped[reason] ?? 0) + 1;
  };
  // Soft masks must stay gray and lossless, so the header pass collects them first.
  const softMasks = new Set<number>();

  // Fatal errors (source read failures) reject; everything else keeps the original image.
  const processImage = async (doc: PdfDocument, hdr: ObjHeader, span: ObjSpan, plan: ImagePlan): Promise<ImageResult> => {
    try {
      const input = await loadImage(doc, span, plan, fitInside(plan.width, plan.height, recompress.maxWidth, recompress.maxHeight));
      if (typeof input === 'string') return { reason: input };
      let out;
      try {
        out = await codec.recompress(input, recompress);
      } catch {
        return { reason: 'codecError' };
      }
      if (!out) return { reason: 'codecDeclined' };
      const info = checkOutput(out.data);
      if (!info) return { reason: 'codecOutputInvalid' };
      const oldLength = span.dataEnd - span.dataStart;
      if (out.data.length > oldLength * o.minSavingsRatio) return { reason: 'noGain' };
      const keepColorSpace = plan.icc && plan.comps === info.components;
      return { parts: buildImageObject(hdr.value as PdfDict, out.data, info, keepColorSpace), saved: oldLength - out.data.length };
    } catch (e) {
      if (isFatal(e)) throw e;
      return { reason: 'error' };
    }
  };

  const processMask = async (doc: PdfDocument, hdr: ObjHeader, span: ObjSpan, plan: ImagePlan, ow: number, oh: number): Promise<ImageResult> => {
    try {
      const data = await shrinkMask(doc, span, plan, ow, oh);
      if (typeof data === 'string') return { reason: data };
      const oldLength = span.dataEnd - span.dataStart;
      if (data.length > oldLength * o.minSavingsRatio) return { reason: 'noGain' };
      return { parts: buildMaskObject(hdr.value as PdfDict, data, ow, oh), saved: oldLength - data.length };
    } catch (e) {
      if (isFatal(e)) throw e;
      return { reason: 'error' };
    }
  };

  // Results are recorded when the object is written, so reports don't depend on timing.
  const settle = (ctx: RewriteContext, r: ImageResult) => (): Uint8Array[] | null => {
    if ('reason' in r) {
      skip(r.reason);
      return null;
    }
    report.imagesRecompressed++;
    ctx.saved(r.saved);
    return r.parts;
  };

  return {
    report,
    scan(_num, hdr) {
      const sm = (hdr.value as PdfDict).get('SMask');
      if (sm instanceof PdfRef) softMasks.add(sm.num);
    },
    async transform(num, hdr, span, ctx) {
      if (!hdr.stream || span.dataEnd < 0) return;
      const doc = ctx.doc;
      const plan = await classifyImage(doc, hdr.value as PdfDict, span.dataEnd - span.dataStart, o.minImageBytes, softMasks.has(num));
      if (plan === null) return;
      report.imagesSeen++;
      if (typeof plan === 'string') return void skip(plan);
      if (!plan.mask) return { task: processImage(doc, hdr, span, plan).then((r) => settle(ctx, r)) };
      // Soft masks shrink to the same box as their images; masks that already fit stay as they are.
      const [ow, oh] = fitInside(plan.width, plan.height, recompress.maxWidth, recompress.maxHeight);
      if (ow < plan.width || oh < plan.height || plan.chain === 'raw') {
        return { task: processMask(doc, hdr, span, plan, ow, oh).then((r) => settle(ctx, r)) };
      }
      skip('softMask');
    },
  };
}

/**
 * Recompress the raster images of a PDF. Reads `source` with bounded random access and writes a
 * complete new file to `sink` in one forward pass; unchanged objects are copied byte for byte.
 * The sink is closed on success and aborted (if it supports it) on failure.
 * Equivalent to `rewritePdf(source, sink, [compressImages(options)], options)`.
 */
export async function compressPdf(source: RandomAccessSource, sink: OutputSink, options: CompressOptions): Promise<CompressReport> {
  let images;
  try {
    images = compressImages(options);
  } catch (e) {
    await sink.abort?.(e).catch(() => {});
    throw e;
  }
  const r = await rewritePdf(source, sink, [images], options);
  return { ...images.report, ...r };
}
