import { latin1 } from './bytes.ts';
import { encodeName, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from './objects.ts';

function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // No exponent notation in PDF; 6 decimals is plenty for coordinates.
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/**
 * Serialize an object. Values parsed from the source keep their original bytes wherever the
 * parser recorded them (dictionary entries), so rewritten dictionaries stay faithful.
 */
export function serialize(o: PdfObj | undefined): string {
  if (o === null || o === undefined) return 'null';
  if (typeof o === 'boolean') return String(o);
  if (typeof o === 'number') return num(o);
  if (o instanceof PdfName) return encodeName(o.name);
  if (o instanceof PdfRef) return `${o.num} ${o.gen} R`;
  if (o instanceof PdfString) return latin1(o.raw);
  if (Array.isArray(o)) return `[${o.map(serialize).join(' ')}]`;
  return dictString(o, new Map());
}

/**
 * A dictionary with some entries replaced (a string value, written as is) or removed (null).
 * Keys keep their order; new keys go at the end.
 */
export function dictString(d: PdfDict, updates: Map<string, string | null>): string {
  const left = new Map(updates);
  let s = '<<';
  for (const [k, v] of d.map) {
    const u = left.get(k);
    left.delete(k);
    if (u === null) continue;
    const raw = d.raw.get(k);
    s += `${encodeName(k)} ${u ?? (raw && raw.length ? latin1(raw) : serialize(v))}\n`;
  }
  for (const [k, u] of left) if (u !== null) s += `${encodeName(k)} ${u}\n`;
  return s + '>>';
}
