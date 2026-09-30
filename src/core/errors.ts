/** Base class for errors raised by the compressor. */
export class PdfError extends Error {
  override name = 'PdfError';
}

/** The document is encrypted; decryption is not supported. */
export class PdfEncryptedError extends PdfError {
  override name = 'PdfEncryptedError';
  constructor() {
    super('Encrypted PDFs are not supported (the trailer has an /Encrypt entry)');
  }
}

/** The input is not a PDF, or is too damaged to rebuild. */
export class PdfFormatError extends PdfError {
  override name = 'PdfFormatError';
}

/** Malformed syntax at a specific place. Internal; usually caught and handled. */
export class PdfSyntaxError extends PdfError {
  override name = 'PdfSyntaxError';
}

/** Reading the source failed. Never swallowed by recovery logic. */
export class SourceReadError extends PdfError {
  override name = 'SourceReadError';
  constructor(cause: unknown) {
    super(`Failed to read input: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.cause = cause;
  }
}

/** Thrown by the lexer when a token runs past the end of a partial buffer. */
export class NeedMoreData extends Error {
  override name = 'NeedMoreData';
}

export const NEED_MORE = /* @__PURE__ */ new NeedMoreData('need more data');

/** Errors that must propagate instead of triggering fallbacks. */
export function isFatal(e: unknown): boolean {
  return e instanceof SourceReadError || e instanceof PdfEncryptedError || (e instanceof Error && e.name === 'AbortError');
}
