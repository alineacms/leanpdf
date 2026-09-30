import type { PdfDocument } from '../core/document.ts';
import { nameOf, numOf, PdfRef, type PdfObj } from '../core/objects.ts';
import { walkPages } from '../core/pages.ts';
import { arrayOf, assertNotEncrypted, catalogOf, dictOf, targetResolver, textAt } from './names.ts';

/** A bookmark. */
export interface OutlineItem {
  title: string;
  /** 0-based page index the item leads to, when it leads to a page of this document. */
  pageIndex?: number;
  /** Target of a URI action. */
  url?: string;
  /** Items with children: whether they are shown expanded (/Count > 0). */
  open?: boolean;
  children: OutlineItem[];
}

/** A link annotation. */
export interface LinkInfo {
  /** 0-based index of the page the link is on. */
  pageIndex: number;
  /** Active area [x1, y1, x2, y2] in default user space, normalized so x1 <= x2, y1 <= y2. */
  rect: number[];
  /** Target of a URI action. */
  url?: string;
  /** 0-based index of the page the link leads to. */
  targetPageIndex?: number;
}

const MAX_ITEMS = 100_000;
const MAX_DEPTH = 64;

/**
 * The document outline (bookmarks) as a tree. Destinations are resolved to page indexes:
 * explicit destinations, named ones (the /Dests name tree and the legacy /Dests dictionary)
 * and GoTo actions; URI actions give `url`. Cycles are cut, and at most 100 000 items and 64
 * levels are read. Throws PdfEncryptedError for encrypted documents.
 */
export async function getOutline(doc: PdfDocument): Promise<OutlineItem[]> {
  assertNotEncrypted(doc);
  const cat = await catalogOf(doc);
  const root = await dictOf(doc, cat?.get('Outlines'));
  if (!root) return [];
  const target = targetResolver(doc, cat);
  const seen = new Set<number>();
  let budget = MAX_ITEMS;
  const level = async (first: PdfObj | undefined, depth: number): Promise<OutlineItem[]> => {
    const items: OutlineItem[] = [];
    for (let node = first; node instanceof PdfRef && !seen.has(node.num) && budget > 0; ) {
      seen.add(node.num);
      budget--;
      const d = await dictOf(doc, node);
      if (!d) break;
      const item: OutlineItem = { title: (await textAt(doc, d.get('Title'))) ?? '', ...(await target(d)), children: [] };
      if (depth < MAX_DEPTH) item.children = await level(d.get('First'), depth + 1);
      if (item.children.length) item.open = (numOf(await doc.resolve(d.get('Count'))) ?? 0) > 0;
      items.push(item);
      node = d.get('Next');
    }
    return items;
  };
  return level(root.get('First'), 0);
}

/**
 * All link annotations, page by page, with their targets resolved like outline items.
 * Throws PdfEncryptedError for encrypted documents.
 */
export async function getLinks(doc: PdfDocument): Promise<LinkInfo[]> {
  assertNotEncrypted(doc);
  const pages: number[] = [];
  const annots: (PdfObj | undefined)[] = [];
  for await (const p of walkPages(doc)) {
    pages.push(p.num);
    annots.push(p.dict.get('Annots'));
  }
  const target = targetResolver(doc, await catalogOf(doc), pages);
  const out: LinkInfo[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (const a of (await arrayOf(doc, annots[i])) ?? []) {
      const d = await dictOf(doc, a);
      if (!d || nameOf(await doc.resolve(d.get('Subtype'))) !== 'Link') continue;
      const r = await arrayOf(doc, d.get('Rect'));
      const n: number[] = [];
      for (const x of r ?? []) {
        const v = numOf(await doc.resolve(x));
        if (v !== undefined) n.push(v);
      }
      if (n.length !== 4) continue;
      const t = await target(d);
      const link: LinkInfo = { pageIndex: i, rect: [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])] };
      if (t.url !== undefined) link.url = t.url;
      if (t.pageIndex !== undefined) link.targetPageIndex = t.pageIndex;
      out.push(link);
    }
  }
  return out;
}
