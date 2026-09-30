import { PdfDocument } from './document.ts';
import { SourceReader } from './reader.ts';
import type { RandomAccessSource } from './types.ts';
import { BlobSource } from '../io/blob.ts';

/**
 * Open a PDF for reading: parses (or rebuilds) the cross-reference index, nothing more. Objects
 * are read on demand with bounded random access. Pass the result to the read functions
 * (`getInfo`, `extractText`, ...) or to `rewritePdf`.
 */
export function openPdf(input: RandomAccessSource | Blob, opts: { signal?: AbortSignal } = {}): Promise<PdfDocument> {
  const source = typeof Blob !== 'undefined' && input instanceof Blob ? new BlobSource(input) : (input as RandomAccessSource);
  return PdfDocument.open(new SourceReader(source), opts.signal);
}
