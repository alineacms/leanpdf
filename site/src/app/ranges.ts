/**
 * Page ranges as people type them: 1-based, comma separated, in the order wanted.
 * "1-3, 7, 5" is pages 1, 2, 3, 7, 5; "8-" runs to the last page, "-3" from the first; "5-2" runs
 * backwards. Blank means every page.
 */

/** The 0-based page indexes `spec` lists, null for a blank spec, or an error message. */
export function parseRanges(spec: string, pageCount: number): number[] | null | string {
  if (!spec.trim()) return null;
  const out: number[] = [];
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d*)\s*(-|–|to)?\s*(\d*)$/i.exec(part);
    if (!m || (!m[1] && !m[3])) return `“${part}” is not a page number or a range like 2-5.`;
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    for (const p of [from, to]) if (p < 1 || p > pageCount) return pageCount === 1 ? `This PDF has one page; there is no page ${p}.` : `There is no page ${p}: pages are 1 to ${pageCount}.`;
    const step = from <= to ? 1 : -1;
    for (let p = from; p !== to + step; p += step) out.push(p - 1);
  }
  return out.length ? out : null;
}

/** The first page listed twice (1-based), if any. */
export function firstRepeat(indexes: number[]): number | undefined {
  const seen = new Set<number>();
  for (const i of indexes) {
    if (seen.has(i)) return i + 1;
    seen.add(i);
  }
  return undefined;
}

/** "3 pages", "1 page". */
export const pagesText = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'page' : 'pages'}`;
