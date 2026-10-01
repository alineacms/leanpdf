import { PdfDocument } from './document.ts';
import { toSource } from './io.ts';
import { SourceReader } from './reader.ts';
import type { PdfInput } from './types.ts';

/**
 * Open a PDF for reading: parses (or rebuilds) the cross-reference index, nothing more. Objects
 * are read on demand with bounded random access. Pass the result to the read functions
 * (`getInfo`, `extractText`, ...) or to `rewritePdf`.
 *
 * `input` is a Blob or File (read in pieces, never whole), the file's bytes (not to be changed
 * while the document is in use), or any RandomAccessSource.
 */
export function openPdf(input: PdfInput, opts: { signal?: AbortSignal } = {}): Promise<PdfDocument> {
  return PdfDocument.open(new SourceReader(toSource(input)), opts.signal);
}
