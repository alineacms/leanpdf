import type { PdfDocument } from './document.ts';
import { nameOf, numOf, PdfDict, PdfRef, type PdfObj } from './objects.ts';

export interface PageNode {
  /** 0-based page index. */
  index: number;
  /** Object number of the page dictionary (0 if the page is a direct object). */
  num: number;
  dict: PdfDict;
  /** Inherited attributes, resolved from the page or its ancestors. */
  resources: PdfDict | undefined;
  mediaBox: number[];
  cropBox: number[];
  rotate: number;
}

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
const LETTER = [0, 0, 612, 792];

async function box(doc: PdfDocument, o: PdfObj | undefined): Promise<number[] | undefined> {
  const a = await doc.resolve(o);
  if (!Array.isArray(a) || a.length !== 4) return undefined;
  const n: number[] = [];
  for (const x of a) {
    const v = numOf(await doc.resolve(x));
    if (v === undefined) return undefined;
    n.push(v);
  }
  return n;
}

/**
 * Walk the page tree in order, with inherited attributes applied. Robust against cycles, bogus
 * /Kids and missing /Type. Holds only the path from the root to the current page.
 */
export async function* walkPages(doc: PdfDocument): AsyncGenerator<PageNode> {
  const root = await doc.resolve(doc.trailer.get('Root'));
  if (!(root instanceof PdfDict)) return;
  const seen = new Set<number>();
  let index = 0;
  type Frame = { kids: PdfObj[]; i: number; inherited: Map<string, PdfObj> };
  const top = root.get('Pages');
  const stack: Frame[] = [{ kids: top === undefined ? [] : [top], i: 0, inherited: new Map() }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i >= f.kids.length) {
      stack.pop();
      continue;
    }
    const kid = f.kids[f.i++];
    const num = kid instanceof PdfRef ? kid.num : 0;
    if (num) {
      if (seen.has(num)) continue;
      seen.add(num);
    }
    const node = await doc.resolve(kid);
    if (!(node instanceof PdfDict)) continue;
    const inherited = new Map(f.inherited);
    for (const k of INHERITED) {
      const v = node.get(k);
      if (v !== undefined) inherited.set(k, v);
    }
    const kids = await doc.resolve(node.get('Kids'));
    const type = nameOf(node.get('Type'));
    if (type === 'Pages' || (type !== 'Page' && Array.isArray(kids))) {
      if (Array.isArray(kids) && stack.length < 256) stack.push({ kids, i: 0, inherited });
      continue;
    }
    const mediaBox = (await box(doc, inherited.get('MediaBox'))) ?? LETTER;
    const res = await doc.resolve(inherited.get('Resources'));
    const rot = numOf(await doc.resolve(inherited.get('Rotate'))) ?? 0;
    yield {
      index: index++,
      num,
      dict: node,
      resources: res instanceof PdfDict ? res : undefined,
      mediaBox,
      cropBox: (await box(doc, inherited.get('CropBox'))) ?? mediaBox,
      rotate: (((Math.round(rot / 90) * 90) % 360) + 360) % 360,
    };
  }
}

/** Object numbers of all pages, in order (0 for direct page objects). */
export async function pageNumbers(doc: PdfDocument): Promise<number[]> {
  const out: number[] = [];
  for await (const p of walkPages(doc)) out.push(p.num);
  return out;
}
