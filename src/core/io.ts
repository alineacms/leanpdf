/** PdfInput and PdfOutput to the RandomAccessSource and OutputSink the core works with. */
import { BlobSource, WritableStreamSink } from '../io/blob.ts';
import type { OutputSink, PdfInput, PdfOutput, RandomAccessSource } from './types.ts';

export function toSource(input: PdfInput): RandomAccessSource {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    return { size: b.length, read: async (offset, length) => b.subarray(offset, offset + length) };
  }
  return typeof Blob !== 'undefined' && input instanceof Blob ? new BlobSource(input) : (input as RandomAccessSource);
}

export function toSink(output: PdfOutput): OutputSink {
  return typeof (output as WritableStream).getWriter === 'function' ? new WritableStreamSink(output as WritableStream<Uint8Array>) : (output as OutputSink);
}
