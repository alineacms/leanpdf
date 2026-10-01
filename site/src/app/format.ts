/** Formatting and small DOM helpers shared by the app's tools. */

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export const fmtInt = (n: number): string => n.toLocaleString('en-US');

/** Elements with a data-ref attribute inside `root`, by that attribute. Throws if one is missing. */
export function refs<K extends string>(root: ParentNode, names: readonly K[]): Record<K, HTMLElement> {
  const out = {} as Record<K, HTMLElement>;
  for (const name of names) {
    const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
    if (!el) throw new Error(`[data-ref="${name}"] missing`);
    out[name] = el;
  }
  return out;
}

/** An element with text content (never HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

/** A human message for an error from the library or the browser. */
export function describeError(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : 'Error';
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  switch (name) {
    case 'PdfEncryptedError':
      return 'This PDF is encrypted, and could not be opened with its password.';
    case 'PdfPasswordError':
      return 'The password is not correct.';
    case 'PdfFormatError':
      return `This file is not a PDF, or it is too damaged to rebuild. (${message})`;
    case 'SourceReadError':
    case 'NotReadableError':
      return `The file could not be read. If it changed or moved after you chose it, choose it again. (${message})`;
    case 'NotAllowedError':
      return `The browser did not allow writing the file. (${message})`;
    case 'QuotaExceededError':
      return 'There is not enough storage space to write the result.';
    default:
      return `${name}: ${message}`;
  }
}
