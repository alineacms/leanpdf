/**
 * Shared helpers for the read features: name trees, number trees, destinations and actions.
 * Everything here is tolerant of damaged input: cycles, bad nodes and wrong /Limits are skipped
 * or worked around, never thrown.
 */
import { latin1 } from '../core/bytes.ts';
import type { PdfDocument } from '../core/document.ts';
import { PdfEncryptedError } from '../core/errors.ts';
import { nameOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { pageNumbers } from '../core/pages.ts';
import { decodeText, stringBytes } from '../core/strings.ts';

/** Nodes visited per tree walk, at most. */
const MAX_NODES = 1 << 20;
const MAX_TREE_DEPTH = 64;

/** Throw PdfEncryptedError if the document is encrypted (strings and streams are unreadable). */
export function assertNotEncrypted(doc: PdfDocument): void {
  if (doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
}

/** Resolve to a dictionary (a stream's dictionary for streams), or undefined. */
export async function dictOf(doc: PdfDocument, o: PdfObj | undefined): Promise<PdfDict | undefined> {
  const v = await doc.resolve(o);
  return v instanceof PdfDict ? v : undefined;
}

/** Resolve to an array, or undefined. */
export async function arrayOf(doc: PdfDocument, o: PdfObj | undefined): Promise<PdfObj[] | undefined> {
  const v = await doc.resolve(o);
  return Array.isArray(v) ? v : undefined;
}

/** The document catalog. */
export const catalogOf = (doc: PdfDocument): Promise<PdfDict | undefined> => dictOf(doc, doc.trailer.get('Root'));

/** A resolved text string (or name) as a JS string. */
export async function textAt(doc: PdfDocument, o: PdfObj | undefined): Promise<string | undefined> {
  const v = await doc.resolve(o);
  if (v instanceof PdfString) return decodeText(stringBytes(v));
  return v instanceof PdfName ? v.name : undefined;
}

/**
 * A URI string: byte strings are UTF-8 when valid (as written by most producers), else latin1;
 * text strings with a byte order mark are decoded as such.
 */
export async function uriAt(doc: PdfDocument, o: PdfObj | undefined): Promise<string | undefined> {
  const v = await doc.resolve(o);
  if (!(v instanceof PdfString)) return undefined;
  const b = stringBytes(v);
  if (b[0] === 0xfe && b[1] === 0xff) return decodeText(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b); // drops a UTF-8 byte order mark
  } catch {
    return latin1(b);
  }
}

/** A name-tree key (the bytes of a string, or a name) as a latin1 string; numbers as they are. */
export function keyOf(o: PdfObj | undefined): string | number | undefined {
  if (o instanceof PdfString) return latin1(stringBytes(o));
  if (o instanceof PdfName) return o.name;
  return typeof o === 'number' ? o : undefined;
}

/**
 * Visit the leaf entries of a name tree (`kind` 'Names') or number tree ('Nums') in order. Values
 * are passed unresolved (so callers can see references). `visit` may return true to stop.
 * Cycles and malformed nodes are skipped; at most about a million nodes are visited.
 */
export async function walkTree(
  doc: PdfDocument,
  root: PdfObj | undefined,
  kind: 'Names' | 'Nums',
  visit: (key: PdfObj, value: PdfObj) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  const seen = new Set<number>();
  let budget = MAX_NODES;
  const walk = async (node: PdfObj | undefined, depth: number): Promise<boolean> => {
    if (node instanceof PdfRef) {
      if (seen.has(node.num)) return false;
      seen.add(node.num);
    }
    const d = await dictOf(doc, node);
    if (!d || --budget < 0 || depth > MAX_TREE_DEPTH) return false;
    const leaf = await arrayOf(doc, d.get(kind));
    if (leaf) {
      for (let i = 0; i + 1 < leaf.length; i += 2) {
        const k = await doc.resolve(leaf[i]);
        if (k !== undefined && (await visit(k, leaf[i + 1]))) return true;
      }
    }
    for (const kid of (await arrayOf(doc, d.get('Kids'))) ?? []) if (await walk(kid, depth + 1)) return true;
    return false;
  };
  await walk(root, 0);
}

/** Leaf entries a name tree keeps parsed, at most. */
const MAX_CACHED = 1 << 16;
/** Full scans for keys that guided lookups miss in a tree with inconsistent /Limits, at most. */
const MAX_SCANS = 32;

/**
 * Name-tree lookups, guided by /Limits. Nodes are kept once read (interior nodes always; leaves
 * up to 65 536 entries, least recently used first out), so repeated lookups cost little I/O.
 * The first miss reads the whole tree to check its /Limits: when every key lies within them,
 * misses are real; otherwise (unsorted trees and wrong /Limits, which Acrobat tolerates) misses
 * fall back to a full scan, at most 32 times. Keys are latin1 strings of the key bytes (see
 * `keyOf`).
 */
export function nameTree(doc: PdfDocument, root: PdfObj | undefined): (key: string) => Promise<PdfObj | undefined> {
  type Node = { kids?: PdfObj[]; lim?: string[]; names?: Map<string, PdfObj> };
  /** By object number, or by the dictionary itself for direct nodes (such as a direct root). */
  const cache = new Map<number | PdfObj, Node>();
  let cached = 0;
  let trusted = false;
  let scans = 0;
  const node = async (o: PdfObj): Promise<Node | undefined> => {
    const id = o instanceof PdfRef ? o.num : o;
    let n = cache.get(id);
    if (n) {
      cache.delete(id);
      cache.set(id, n);
      return n;
    }
    const d = await dictOf(doc, o);
    if (!d) return undefined;
    n = { kids: await arrayOf(doc, d.get('Kids')) };
    const l = await arrayOf(doc, d.get('Limits'));
    const lim = l && [keyOf(await doc.resolve(l[0])), keyOf(await doc.resolve(l[1]))];
    if (lim && typeof lim[0] === 'string' && typeof lim[1] === 'string') n.lim = lim as string[];
    const a = await arrayOf(doc, d.get('Names'));
    if (a) {
      const m = (n.names = new Map());
      for (let i = 0; i + 1 < a.length; i += 2) {
        const k = keyOf(await doc.resolve(a[i]));
        if (typeof k === 'string' && !m.has(k)) m.set(k, a[i + 1]);
      }
    }
    if (cache.size < MAX_NODES) {
      cache.set(id, n);
      cached += n.names?.size ?? 0;
      for (const [k, v] of cache) {
        if (cached <= MAX_CACHED) break;
        if (v.names && k !== id) {
          cache.delete(k);
          cached -= v.names.size;
        }
      }
    }
    return n;
  };
  /**
   * Look for `key` from `o` down, in the kids whose /Limits admit it (all kids when `all`).
   * `lo`..`hi` is the range the ancestors' /Limits admit; `bad` is called for keys outside it.
   */
  const find = async (o: PdfObj, key: string, all: boolean, lo: string, hi: string, depth: number, seen: Set<number>, bad?: () => void): Promise<PdfObj | undefined> => {
    if (o instanceof PdfRef) {
      if (seen.has(o.num)) return undefined;
      seen.add(o.num);
    }
    const n = depth <= MAX_TREE_DEPTH && seen.size < MAX_NODES ? await node(o) : undefined;
    if (!n) return undefined;
    if (n.lim && depth) {
      if (n.lim[0] > lo) lo = n.lim[0];
      if (n.lim[1] < hi) hi = n.lim[1];
    }
    if (bad) for (const k of n.names?.keys() ?? []) if (k < lo || k > hi) bad();
    const v = n.names?.get(key);
    if (v !== undefined) return v;
    for (const kid of n.kids ?? []) {
      // Checking a cached kid's /Limits needs no await (lookups check many kids).
      const lim = all ? undefined : (cache.get(kid instanceof PdfRef ? kid.num : kid) ?? (await node(kid)))?.lim;
      if (lim && (key < lim[0] || key > lim[1])) continue;
      const r = await find(kid, key, all, lo, hi, depth + 1, seen, bad);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return async (key) => {
    if (root === undefined) return undefined;
    const v = await find(root, key, false, '', '\uffff', 0, new Set());
    if (v !== undefined || trusted || scans >= MAX_SCANS) return v;
    let ok = !scans++;
    // The first miss checks every key against its ancestors' /Limits on the way.
    const r = await find(root, key, true, '', '\uffff', 0, new Set(), ok ? () => (ok = false) : undefined);
    trusted = ok && r === undefined;
    return r;
  };
}

/** Where a destination or action leads. */
export interface Target {
  /** 0-based page index inside this document. */
  pageIndex?: number;
  /** URI of a URI action. */
  url?: string;
}

/**
 * A function giving the target of an outline item or link annotation: its /Dest, else its /A
 * action (GoTo and URI are understood). Named destinations are looked up in the /Names /Dests
 * tree and in the legacy catalog /Dests dictionary (mupdf only consults the latter when both
 * exist). Page indexes come from one page-tree walk, done lazily, unless `pages` (page object
 * numbers in order) is given.
 */
export function targetResolver(doc: PdfDocument, catalog: PdfDict | undefined, pages?: number[]): (d: PdfDict) => Promise<Target> {
  let pageMap: Promise<[Map<number, number>, number]> | undefined;
  /** Page index of a page reference, or of a page number (used by some writers). */
  const pageIndex = async (o: PdfObj | undefined): Promise<number | undefined> => {
    if (typeof o !== 'number' && !(o instanceof PdfRef)) return undefined;
    pageMap ??= (async () => {
      const nums = pages ?? (await pageNumbers(doc));
      const m = new Map<number, number>();
      nums.forEach((n, i) => n && !m.has(n) && m.set(n, i));
      return [m, nums.length];
    })();
    const [m, count] = await pageMap;
    return typeof o === 'number' ? (Number.isInteger(o) && o >= 0 && o < count ? o : undefined) : m.get(o.num);
  };
  let tree: ((key: string) => Promise<PdfObj | undefined>) | undefined;
  let legacy: Promise<PdfDict | undefined> | undefined;
  const named = new Map<string, Promise<PdfObj | undefined>>();
  const lookup = (key: string, isName: boolean): Promise<PdfObj | undefined> => {
    let p = named.get(key);
    if (!p) {
      p = (async () => {
        if (!catalog) return undefined;
        tree ??= nameTree(doc, (await dictOf(doc, catalog.get('Names')))?.get('Dests'));
        legacy ??= dictOf(doc, catalog.get('Dests'));
        const fromTree = () => tree!(key);
        const fromDict = async () => (await legacy)?.get(key);
        // Names were meant for the 1.1 /Dests dictionary, strings for the name tree; accept both.
        return isName ? ((await fromDict()) ?? (await fromTree())) : ((await fromTree()) ?? (await fromDict()));
      })();
      named.set(key, p);
    }
    return p;
  };
  /** 0-based page index of a destination (explicit array, name or string). */
  const dest = async (o: PdfObj | undefined): Promise<number | undefined> => {
    for (let depth = 0; depth < 4; depth++) {
      let v = await doc.resolve(o);
      if (v instanceof PdfName || v instanceof PdfString) {
        v = await doc.resolve(await lookup(keyOf(v) as string, v instanceof PdfName));
      }
      if (v instanceof PdfDict) {
        o = v.get('D');
        continue;
      }
      if (!Array.isArray(v) || !v.length) return undefined;
      return pageIndex(v[0] instanceof PdfRef ? v[0] : await doc.resolve(v[0]));
    }
    return undefined;
  };
  /** Target of an action dictionary: GoTo (/D) and URI (/URI) are understood. */
  const action = async (o: PdfObj | undefined): Promise<Target> => {
    const a = await dictOf(doc, o);
    const s = a && nameOf(await doc.resolve(a.get('S')));
    if (s === 'GoTo') return { pageIndex: await dest(a!.get('D')) };
    if (s === 'URI') return { url: await uriAt(doc, a!.get('URI')) };
    return {};
  };
  return async (d) => {
    const t = d.get('Dest') !== undefined ? { pageIndex: await dest(d.get('Dest')) } : await action(d.get('A'));
    if (t.pageIndex === undefined) delete t.pageIndex;
    if (t.url === undefined) delete t.url;
    return t;
  };
}
