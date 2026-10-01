/** Random-access, read-only view of the input. */
export interface RandomAccessSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Append-only output. `copyRange` lets implementations avoid materializing passthrough bytes.
 *
 * The compressor never mutates a chunk after passing it to `write`, so sinks may keep a
 * reference instead of copying.
 */
export interface OutputSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Copy bytes [offset, offset+length) from the source. Default impl: read + write. */
  copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void>;
  close(): Promise<void>;
  /** Optional: called instead of `close()` when compression fails, to discard partial output. */
  abort?(reason?: unknown): Promise<void>;
}

/**
 * A PDF to read: a Blob or File (read in pieces, never whole), the file's bytes (not to be changed
 * while in use), or any RandomAccessSource (NodeFileSource in Node).
 */
export type PdfInput = RandomAccessSource | Blob | Uint8Array | ArrayBuffer;

/**
 * Where to write a PDF: a WritableStream (from `showSaveFilePicker`, `Writable.toWeb(...)`, a
 * TransformStream, ...) or any OutputSink (BlobPartsSink, NodeFileSink).
 */
export type PdfOutput = OutputSink | WritableStream<Uint8Array>;

/** Gray or RGB. CMYK is never passed to codecs. */
export type ColorComponents = 1 | 3;

export type ImageInput =
  | { kind: 'jpeg'; data: Uint8Array; width: number; height: number; components: ColorComponents }
  /** 8-bit samples, row-major, no row padding. */
  | { kind: 'pixels'; data: Uint8Array; width: number; height: number; components: ColorComponents };

export interface RecompressOptions {
  /** Maximum output width in pixels, e.g. 1600. */
  maxWidth: number;
  /** Maximum output height in pixels, e.g. 1600. */
  maxHeight: number;
  /** JPEG quality in 0..1, e.g. 0.75. */
  jpegQuality: number;
  /** Encode grayscale input as grayscale if the codec can. */
  preserveGray: boolean;
}

export interface ImageOutput {
  /** Baseline (or progressive) JPEG. */
  data: Uint8Array;
  width: number;
  height: number;
  components: ColorComponents;
}

export interface ImageCodec {
  /** Return null to leave the image untouched (unsupported, or no gain). */
  recompress(input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null>;
}

/** Progress of a rewrite (compressPdf, rewritePdf, decryptPdf, ...). */
export interface RewriteProgress {
  processedObjects: number;
  totalObjects: number;
  bytesSaved: number;
}

export interface CompressOptions extends Partial<RecompressOptions> {
  codec: ImageCodec;
  /** Skip image streams whose encoded size is below this many bytes. Default 20 000. */
  minImageBytes?: number;
  /** Keep a replacement only if newSize <= oldSize * ratio. Default 0.9. */
  minSavingsRatio?: number;
  /** Images processed in parallel. Default 1, which bounds memory to one decoded image. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (e: RewriteProgress) => void;
}

export interface CompressReport {
  imagesSeen: number;
  imagesRecompressed: number;
  /** Reason -> count. */
  imagesSkipped: Record<string, number>;
  inputBytes: number;
  outputBytes: number;
  /** The input carried a digital signature (/ByteRange); rewriting invalidates it. */
  signaturesInvalidated: boolean;
  /** The cross-reference data was damaged and had to be rebuilt by scanning the file. */
  xrefRepaired: boolean;
  /** Human readable notes about anything unusual. */
  warnings: string[];
}
