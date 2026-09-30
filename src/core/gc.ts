import type { PdfDocument } from './document.ts';
import { PdfDict, PdfRef, type PdfObj } from './objects.ts';
import { E_COMPRESSED } from './xref.ts';

/**
 * Mark every object reachable from `roots` (by default everything the trailer references),
 * plus the object streams holding them. Returns a `keep` predicate for `rewrite`. Memory is one
 * byte per object and a work stack.
 *
 * `getObject` supplies object values (pass a rewrite context's `getObject` to see its edits;
 * objects it adds past the end of the index are followed too, and always kept). References to
 * objects for which `skip` returns true are neither followed nor kept.
 */
export async function reachable(
  doc: PdfDocument,
  roots: PdfObj[] = [...doc.trailer.map.values()],
  getObject: (num: number) => Promise<PdfObj | undefined> = (n) => doc.getObject(n),
  skip?: (num: number) => boolean,
): Promise<(num: number) => boolean> {
  const index = doc.index;
  const marked = new Uint8Array(index.size);
  // Objects past the index: only new ones (added by a rewrite) exist there.
  const beyond = new Set<number>();
  const stack: number[] = [];
  const visit = (o: PdfObj | undefined): void => {
    if (o instanceof PdfRef) {
      const n = o.num;
      if (skip?.(n)) return;
      if (n < marked.length) {
        if (!marked[n]) {
          marked[n] = 1;
          stack.push(n);
        }
      } else if (!beyond.has(n)) {
        beyond.add(n);
        stack.push(n);
      }
    } else if (Array.isArray(o)) for (const x of o) visit(x);
    else if (o instanceof PdfDict) for (const v of o.map.values()) visit(v);
  };
  for (const r of roots) visit(r);
  while (stack.length) visit(await getObject(stack.pop()!));
  for (let n = 0; n < index.size; n++) if (marked[n] && index.type[n] === E_COMPRESSED) marked[index.a[n]] = 1;
  return (num) => num >= marked.length || marked[num] === 1;
}
