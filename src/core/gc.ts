import type { PdfDocument } from './document.ts';
import { PdfDict, PdfRef, type PdfObj } from './objects.ts';
import { E_COMPRESSED } from './xref.ts';

/**
 * Mark every object reachable from `roots` (by default everything the trailer references),
 * plus the object streams holding them. Returns a `keep` predicate for `rewrite`. Memory is one
 * byte per object and a work stack.
 */
export async function reachable(doc: PdfDocument, roots: PdfObj[] = [...doc.trailer.map.values()]): Promise<(num: number) => boolean> {
  const index = doc.index;
  const marked = new Uint8Array(index.size);
  const stack: number[] = [];
  const visit = (o: PdfObj | undefined): void => {
    if (o instanceof PdfRef) {
      if (o.num < marked.length && !marked[o.num]) {
        marked[o.num] = 1;
        stack.push(o.num);
      }
    } else if (Array.isArray(o)) for (const x of o) visit(x);
    else if (o instanceof PdfDict) for (const v of o.map.values()) visit(v);
  };
  for (const r of roots) visit(r);
  while (stack.length) visit(await doc.getObject(stack.pop()!));
  for (let n = 0; n < index.size; n++) if (marked[n] && index.type[n] === E_COMPRESSED) marked[index.a[n]] = 1;
  return (num) => num >= marked.length || marked[num] === 1;
}
