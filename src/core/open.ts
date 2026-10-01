import { PdfDocument } from './document.ts';
import { SourceReader } from './reader.ts';
import type { RandomAccessSource } from './types.ts';
import { BlobSource } from '../io/blob.ts';

/**
 * Open a PDF for reading: parses (or rebuilds) the cross-reference index, nothing more. Objects
 * are read on demand with bounded random access. Pass the result to the read functions
 * (`getInfo`, `extractText`, ...) or to `rewritePdf`.
 *
 * `input` is a Blob or File (read in pieces, never whole), the file's bytes (not to be changed
 * while the document is in use), or any RandomAccessSource.
 */
export function openPdf(input: RandomAccessSource | Blob | Uint8Array | ArrayBuffer, opts: { signal?: AbortSignal } = {}): Promise<PdfDocument> {
  let source: RandomAccessSource;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    source = { size: b.length, read: async (offset, length) => b.subarray(offset, offset + length) };
  } else source = typeof Blob !== 'undefined' && input instanceof Blob ? new BlobSource(input) : (input as RandomAccessSource);
  return PdfDocument.open(new SourceReader(source), opts.signal);
}
