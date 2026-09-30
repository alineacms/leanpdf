import { BrowserImageCodec } from './codecs/browser.ts';
import { compressPdf } from './core/compress.ts';
import type { CompressOptions, CompressReport, ImageCodec } from './core/types.ts';
import { BlobPartsSink, BlobSource } from './io/blob.ts';

export * from './core/types.ts';
export { compressImages, compressPdf, type CompressImagesOptions, type ImagesReport } from './core/compress.ts';
export { openPdf } from './core/open.ts';
export { rewritePdf, type ObjectAction, type Plugin, type RewriteContext, type RewriteOptions, type RewriteReport, type TaskResult } from './core/rewrite.ts';
export type { PdfDocument } from './core/document.ts';
export { PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from './core/objects.ts';
export { PdfEncryptedError, PdfError, PdfFormatError, SourceReadError } from './core/errors.ts';
export { BlobPartsSink, BlobSource, WritableStreamSink } from './io/blob.ts';
export { BrowserImageCodec } from './codecs/browser.ts';
export { fitInside } from './core/resize.ts';

/**
 * Compress a PDF Blob or File. Passthrough bytes stay as slices of the input blob, so memory use
 * is bounded by the images being recompressed. Defaults to the BrowserImageCodec.
 */
export async function compressPdfBlob(
  file: Blob,
  opts: Omit<CompressOptions, 'codec'> & { codec?: ImageCodec },
): Promise<{ blob: Blob; report: CompressReport }> {
  const sink = new BlobPartsSink();
  const report = await compressPdf(new BlobSource(file), sink, { ...opts, codec: opts.codec ?? new BrowserImageCodec() });
  return { blob: sink.blob, report };
}
