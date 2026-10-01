import { BrowserImageCodec } from './codecs/browser.ts';
import { compressPdf } from './core/compress.ts';
import type { CompressOptions, CompressReport, ImageCodec } from './core/types.ts';
import { BlobPartsSink } from './io/blob.ts';

export * from './core/types.ts';
export { compressImages, compressPdf, type CompressImagesOptions, type ImagesReport } from './core/compress.ts';
export { openPdf } from './core/open.ts';
export { rewritePdf, type ObjectAction, type Plugin, type RewriteContext, type RewriteOptions, type RewriteReport, type TaskResult } from './core/rewrite.ts';
export type { PdfDocument } from './core/document.ts';
export { PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from './core/objects.ts';
export { PdfEncryptedError, PdfError, PdfFormatError, SourceReadError } from './core/errors.ts';
export { BlobPartsSink } from './io/blob.ts';
export { BrowserImageCodec } from './codecs/browser.ts';

// Reading (take a PdfDocument from openPdf)
export { getInfo, getPages, parsePdfDate, type DocumentInfo, type PageInfo } from './features/info.ts';
export { getLinks, getOutline, type LinkInfo, type OutlineItem } from './features/outline.ts';
export { getFormFields, type FieldType, type FormField } from './features/forms.ts';
export { attachmentStream, listAttachments, readAttachment, type Attachment, type AttachmentHandle } from './features/attachments.ts';
export { extractImage, listImages, type ExtractedImage, type ImageInfo } from './features/images.ts';
export { extractAllText, extractText, type PageText, type TextOptions } from './features/text.ts';

// Rendering (Canvas 2D, on the main thread or in a worker with OffscreenCanvas)
export { renderPage, type RenderOptions, type RenderResult } from './render/page.ts';

// Rewrite plugins (combine any of them in one rewritePdf pass)
export { removeUnused } from './features/unused.ts';
export { removeAttachments, removeJavaScript, stripMetadata, type StripMetadataOptions } from './features/strip.ts';
export { rotatePages } from './features/rotate.ts';
export { selectPages } from './features/pages-select.ts';
export { recompressStreams, type RecompressStreamsOptions, type StreamsReport } from './features/streams.ts';
export { repairPdf, repairStreams } from './features/repair.ts';

// Whole-file operations
export { mergePdfs, type MergeOptions, type MergeProgress, type MergeReport } from './features/merge.ts';
export {
  checkPassword, decrypt, decryptPdf, isEncrypted, openEncryptedPdf, PdfPasswordError, type DecryptOptions, type DecryptReport,
} from './features/decrypt.ts';
export { fitInside } from './core/resize.ts';

/**
 * Compress a PDF Blob or File. Passthrough bytes stay as slices of the input blob, so memory use
 * is bounded by the images being recompressed. Defaults to the BrowserImageCodec.
 */
export async function compressPdfBlob(
  file: Blob,
  opts: Omit<CompressOptions, 'codec'> & { codec?: ImageCodec } = {},
): Promise<{ blob: Blob; report: CompressReport }> {
  const sink = new BlobPartsSink();
  const report = await compressPdf(file, sink, { ...opts, codec: opts.codec ?? new BrowserImageCodec() });
  return { blob: sink.blob, report };
}
