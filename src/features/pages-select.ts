import { EMPTY, latin1 } from '../core/bytes.ts';
import { intOf, nameOf, numOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import type { Plugin, RewriteContext } from '../core/rewrite.ts';
import { stringBytes } from '../core/strings.ts';
import { catalog, editSub, gcState, gcStages, patched, resolve, setEntry, setObject } from './unused.ts';

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
const MAX_DEPTH = 64;

interface Leaf {
  /** 0 for a page stored directly in /Kids. */
  num: number;
  ref?: PdfRef;
  /** Only kept for pages stored directly in /Kids; the others are read when needed. */
  dict?: PdfDict;
  /** Raw values the page inherits from its ancestors. */
  inherited: Map<string, PdfObj>;
}

/** The pages in the order `walkPages` finds them, with what they inherit, unresolved. */
async function leaves(ctx: RewriteContext): Promise<Leaf[]> {
  const doc = ctx.doc;
  const root = await doc.resolve(doc.trailer.get('Root'));
  const out: Leaf[] = [];
  if (!(root instanceof PdfDict)) return out;
  const seen = new Set<number>();
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
    const kids = await doc.resolve(node.get('Kids'));
    const type = nameOf(node.get('Type'));
    if (type === 'Pages' || (type !== 'Page' && Array.isArray(kids))) {
      const inherited = new Map(f.inherited);
      for (const k of INHERITED) if (node.get(k) !== undefined) inherited.set(k, node.get(k)!);
      if (Array.isArray(kids) && stack.length < 256) stack.push({ kids, i: 0, inherited });
      continue;
    }
    out.push(kid instanceof PdfRef ? { num, ref: kid, inherited: f.inherited } : { num: 0, dict: node, inherited: f.inherited });
  }
  return out;
}

const dict = (entries: [string, PdfObj][]): PdfDict => {
  const d = new PdfDict();
  for (const [k, v] of entries) d.set(k, v, EMPTY);
  return d;
};

const sameRef = (a: PdfObj | undefined, b: PdfRef | undefined): boolean =>
  a instanceof PdfRef && b !== undefined ? a.num === b.num && a.gen === b.gen : a === undefined && b === undefined;

/**
 * Rewrite plugin that keeps, reorders or deletes pages: the output has exactly the pages at
 * `indices` (0-based positions in the input), in that order. Indices must be integers, unique
 * and in range (a RangeError otherwise; out-of-range ones are detected when the rewrite runs).
 *
 * The page tree is replaced by one flat /Pages node; each kept page gets the attributes it
 * inherited (/Resources, /MediaBox, /CropBox, /Rotate) and a new /Parent. Removed pages and
 * everything only they used are left out (it includes `removeUnused`; references to removed pages
 * that remain elsewhere read as null). When pages are removed:
 * - outline items pointing at them are removed (an item that still has children stays, without
 *   its destination), siblings are relinked and /Count updated; an empty outline goes;
 * - named destinations pointing at them are removed (catalog /Dests and /Names /Dests), as are
 *   link annotations on kept pages that lead to them and an /OpenAction that opens one;
 * - form fields lose the widgets that were on them (fields left without widgets go, and the
 *   calculation order /CO follows);
 * - the logical structure tree (/StructTreeRoot, and /MarkInfo) is dropped: it describes the
 *   removed content too, and pruning it is not supported. Article threads are left as they are.
 * Page labels (/PageLabels) are recomputed so that every page keeps its label. Use it once per
 * rewrite (a second one throws). Encrypted input is rejected (PdfEncryptedError), also next to
 * `decrypt`.
 */
export function selectPages(indices: number[]): Plugin {
  const sel = [...indices];
  const chosen = new Set<number>();
  for (const i of sel) {
    if (!Number.isInteger(i) || i < 0) throw new RangeError(`Page indices must be non-negative integers, got ${i}`);
    if (chosen.has(i)) throw new RangeError(`Page ${i} is selected more than once`);
    chosen.add(i);
  }
  if (!sel.length) throw new RangeError('Select at least one page');
  return {
    ...gcStages(),
    async prepare(ctx) {
      const state = gcState(ctx);
      if (state.paged) throw new Error('selectPages can be used only once per rewrite');
      state.paged = true;
      const pages = await leaves(ctx);
      for (const i of sel) if (i >= pages.length) throw new RangeError(`Page index ${i} is out of range: the document has ${pages.length} pages`);
      const cat = await catalog(ctx);
      if (!cat) return;
      const [cn, cd] = cat;

      // A new flat page tree.
      const node = ctx.addObject(null);
      const kids: PdfRef[] = [];
      for (const i of sel) {
        const p = pages[i];
        const own = p.ref ? await ctx.getObject(p.num) : p.dict;
        const changes = new Map<string, PdfObj>([['Parent', node]]);
        for (const k of INHERITED) {
          if (own instanceof PdfDict && own.get(k) === undefined && p.inherited.has(k)) changes.set(k, p.inherited.get(k)!);
        }
        if (!p.ref) kids.push(ctx.addObject(patched(p.dict!, changes)));
        else {
          for (const [k, v] of changes) setEntry(ctx, p.num, k, v);
          kids.push(p.ref);
        }
      }
      ctx.setObject(node.num, dict([['Type', new PdfName('Pages')], ['Kids', kids], ['Count', kids.length]]));
      setEntry(ctx, cn, 'Pages', node);

      const removed = new Set<number>();
      pages.forEach((p, i) => p.num && !chosen.has(i) && removed.add(p.num));
      const identity = sel.every((x, i) => x === i) && sel.length === pages.length;
      if (!identity) await relabel(ctx, cn, cd, sel);
      if (!removed.size) return;
      for (const n of removed) state.severed.add(n);
      await unlink(ctx, cn, cd, pages, chosen, removed);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// References to removed pages

/** Visit the leaves (/Names or /Nums arrays) of a name or number tree. */
async function eachLeaf(
  ctx: RewriteContext,
  root: PdfObj | undefined,
  key: 'Names' | 'Nums',
  fn: (node: PdfObj, d: PdfDict, arr: PdfObj[]) => Promise<void> | void,
): Promise<void> {
  const seen = new Set<number>();
  const walk = async (n: PdfObj | undefined, depth: number): Promise<void> => {
    if (n instanceof PdfRef) {
      if (seen.has(n.num)) return;
      seen.add(n.num);
    }
    const d = await resolve(ctx, n);
    if (!(d instanceof PdfDict) || depth > MAX_DEPTH) return;
    const arr = await resolve(ctx, d.get(key));
    if (Array.isArray(arr)) await fn(n!, d, arr);
    const kids = await resolve(ctx, d.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) await walk(k, depth + 1);
  };
  await walk(root, 0);
}

const nameKey = (o: PdfObj | undefined): string | undefined =>
  o instanceof PdfName ? o.name : o instanceof PdfString ? latin1(stringBytes(o)) : undefined;

async function unlink(ctx: RewriteContext, cn: number, cd: PdfDict, pages: Leaf[], chosen: Set<number>, removed: Set<number>): Promise<void> {
  // Named destinations: catalog /Dests (names) and /Names /Dests (strings); readers accept either.
  const named = new Map<string, PdfObj>();
  const dests = await resolve(ctx, cd.get('Dests'));
  if (dests instanceof PdfDict) for (const [k, v] of dests.map) named.set(k, v);
  const namesDict = await resolve(ctx, cd.get('Names'));
  const destTree = namesDict instanceof PdfDict ? namesDict.get('Dests') : undefined;
  await eachLeaf(ctx, destTree, 'Names', (_n, _d, arr) => {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const k = nameKey(arr[i]);
      if (k !== undefined) named.set(k, arr[i + 1]);
    }
  });

  /** Does a destination (explicit, named, or a named destination's value) lead to a removed page? */
  const deadDest = async (dest: PdfObj | undefined, depth = 0): Promise<boolean> => {
    if (depth > 8) return false;
    const k = nameKey(dest);
    if (k !== undefined) return named.has(k) && deadDest(named.get(k), depth + 1);
    const v = await resolve(ctx, dest);
    if (Array.isArray(v)) return v[0] instanceof PdfRef && removed.has(v[0].num);
    return v instanceof PdfDict && deadDest(v.get('D'), depth + 1);
  };
  /** Does an outline item or link annotation (its /Dest or GoTo /A) lead to a removed page? */
  const deadTarget = async (d: PdfDict): Promise<boolean> => {
    if (d.get('Dest') !== undefined) return deadDest(d.get('Dest'));
    const a = await resolve(ctx, d.get('A'));
    return a instanceof PdfDict && nameOf(a.get('S')) === 'GoTo' && deadDest(a.get('D'));
  };

  // Named destinations themselves.
  if (dests instanceof PdfDict) {
    const gone = new Map<string, null>();
    for (const [k, v] of dests.map) if (await deadDest(v)) gone.set(k, null);
    await editSub(ctx, cn, 'Dests', gone);
  }
  let newRoot: PdfDict | undefined;
  await eachLeaf(ctx, destTree, 'Names', async (n, d, arr) => {
    const out: PdfObj[] = [];
    for (let i = 0; i + 1 < arr.length; i += 2) if (!(await deadDest(arr[i + 1]))) out.push(arr[i], arr[i + 1]);
    if (out.length === arr.length - (arr.length & 1)) return;
    if (n instanceof PdfRef) setEntry(ctx, n.num, 'Names', out);
    else newRoot = patched(d, new Map([['Names', out]]));
  });
  if (newRoot) await editSub(ctx, cn, 'Names', new Map([['Dests', newRoot]]));

  const open = await resolve(ctx, cd.get('OpenAction'));
  if (Array.isArray(open) ? await deadDest(open) : open instanceof PdfDict && (await deadTarget(dict([['A', open]])))) {
    setEntry(ctx, cn, 'OpenAction', null);
  }
  await pruneOutline(ctx, cn, cd, deadTarget);

  // Links on kept pages that lead to removed ones; which annotations sit on which pages.
  const onKept = new Set<number>();
  const onRemoved = new Set<number>();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pd = p.ref ? await ctx.getObject(p.num) : p.dict;
    if (!(pd instanceof PdfDict)) continue;
    const annots = pd.get('Annots');
    const arr = await resolve(ctx, annots);
    if (!Array.isArray(arr)) continue;
    const kept = chosen.has(i);
    const out: PdfObj[] = [];
    for (const x of arr) {
      if (x instanceof PdfRef) (kept ? onKept : onRemoved).add(x.num);
      const a = kept ? await resolve(ctx, x) : undefined;
      if (a instanceof PdfDict && nameOf(a.get('Subtype')) === 'Link' && (await deadTarget(a))) continue;
      out.push(x);
    }
    if (out.length === arr.length || !p.num) continue;
    if (annots instanceof PdfRef) setObject(ctx, annots.num, out);
    else setEntry(ctx, p.num, 'Annots', out.length ? out : null);
  }

  // Form fields whose widgets were on removed pages.
  const form = await resolve(ctx, cd.get('AcroForm'));
  if (form instanceof PdfDict) {
    const dead = new Set([...onRemoved].filter((n) => !onKept.has(n)));
    const gone = new Set<number>();
    const seen = new Set<number>();
    const prune = async (arr: PdfObj[], depth: number): Promise<PdfObj[] | undefined> => {
      let changed = false;
      const out: PdfObj[] = [];
      for (const x of arr) {
        const num = x instanceof PdfRef ? x.num : -1;
        const f = num >= 0 && !seen.has(num) && depth < MAX_DEPTH ? await ctx.getObject(num) : undefined;
        seen.add(num);
        const widget = f instanceof PdfDict && nameOf(f.get('Subtype')) === 'Widget';
        // On a removed page: listed in its /Annots, or (listed nowhere) pointing at it with /P.
        const p = widget ? (f as PdfDict).get('P') : undefined;
        let drop = dead.has(num) || (p instanceof PdfRef && removed.has(p.num) && !onKept.has(num));
        if (!drop && f instanceof PdfDict) {
          const kids = await resolve(ctx, f.get('Kids'));
          const left = Array.isArray(kids) ? await prune(kids, depth + 1) : undefined;
          drop = !!left && !left.length && !widget;
          if (left && !drop) setEntry(ctx, num, 'Kids', left);
        }
        if (drop) {
          gone.add(num);
          changed = true;
        } else out.push(x);
      }
      return changed ? out : undefined;
    };
    const changes = new Map<string, PdfObj | null>();
    const fields = await resolve(ctx, form.get('Fields'));
    const left = Array.isArray(fields) ? await prune(fields, 0) : undefined;
    if (left) changes.set('Fields', left);
    const co = await resolve(ctx, form.get('CO'));
    if (Array.isArray(co) && gone.size) {
      const c = co.filter((x) => !(x instanceof PdfRef && gone.has(x.num)));
      if (c.length !== co.length) changes.set('CO', c.length ? c : null);
    }
    await editSub(ctx, cn, 'AcroForm', changes);
  }

  // The structure tree refers to content of every page.
  for (const k of ['StructTreeRoot', 'MarkInfo']) if (cd.get(k) !== undefined) setEntry(ctx, cn, k, null);
}

/**
 * Remove outline items whose target is gone (items that still have children stay, without a
 * target), relinking siblings and fixing /First, /Last and /Count.
 */
async function pruneOutline(ctx: RewriteContext, cn: number, cd: PdfDict, dead: (d: PdfDict) => Promise<boolean>): Promise<void> {
  const top = cd.get('Outlines');
  const root = await resolve(ctx, top);
  if (!(top instanceof PdfRef) || !(root instanceof PdfDict)) return;
  const seen = new Set<number>([top.num]);
  /**
   * Prune the children of `node`. Returns how many stay, how many would show with `node` open,
   * and whether anything below it changed.
   */
  const level = async (num: number, node: PdfDict, depth: number): Promise<{ kids: number; visible: number; changed: boolean }> => {
    const items: [PdfRef, PdfDict][] = [];
    for (let c = node.get('First'); c instanceof PdfRef && !seen.has(c.num) && depth < MAX_DEPTH; ) {
      seen.add(c.num);
      const d = await ctx.getObject(c.num);
      if (!(d instanceof PdfDict)) break;
      items.push([c, d]);
      c = d.get('Next');
    }
    const kept: [PdfRef, PdfDict][] = [];
    let visible = 0;
    let dropped = false;
    let below = false;
    for (const [r, d] of items) {
      const sub = await level(r.num, d, depth + 1);
      below ||= sub.changed;
      if (await dead(d)) {
        if (!sub.kids) {
          dropped = true;
          continue;
        }
        for (const k of ['Dest', 'A']) if (d.get(k) !== undefined) setEntry(ctx, r.num, k, null);
      }
      kept.push([r, d]);
      visible += 1 + ((numOf(d.get('Count')) ?? 0) > 0 ? sub.visible : 0);
    }
    if (dropped) {
      kept.forEach(([r, d], i) => {
        const prev = kept[i - 1]?.[0];
        const next = kept[i + 1]?.[0];
        if (!sameRef(d.get('Prev'), prev)) setEntry(ctx, r.num, 'Prev', prev ?? null);
        if (!sameRef(d.get('Next'), next)) setEntry(ctx, r.num, 'Next', next ?? null);
      });
      setEntry(ctx, num, 'First', kept[0]?.[0] ?? null);
      setEntry(ctx, num, 'Last', kept[kept.length - 1]?.[0] ?? null);
    }
    // Open items (and the root) count the items that show; closed items count negatively.
    const old = numOf(node.get('Count'));
    const count = !visible ? null : depth > 0 && old !== undefined && old < 0 ? -visible : visible;
    if ((dropped || below) && (old ?? null) !== count) setEntry(ctx, num, 'Count', count);
    return { kids: kept.length, visible, changed: dropped || below };
  };
  const r = await level(top.num, root, 0);
  if (!r.kids) setEntry(ctx, cn, 'Outlines', null);
}

// ---------------------------------------------------------------------------------------------
// Page labels

interface Label {
  style: PdfObj | undefined;
  prefix: PdfObj | undefined;
  n: number;
}

/** Recompute /PageLabels for the new page order, so every page keeps its label. */
async function relabel(ctx: RewriteContext, cn: number, cd: PdfDict, sel: number[]): Promise<void> {
  const tree = cd.get('PageLabels');
  if (tree === undefined) return;
  const ranges: [number, PdfDict][] = [];
  await eachLeaf(ctx, tree, 'Nums', async (_n, _d, arr) => {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const start = intOf(arr[i]);
      const d = await resolve(ctx, arr[i + 1]);
      if (start !== undefined && start >= 0 && d instanceof PdfDict) ranges.push([start, d]);
    }
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const labelOf = async (i: number): Promise<Label> => {
    // The last range starting at or before i.
    let lo = 0;
    for (let hi = ranges.length; lo < hi; ) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][0] <= i) lo = mid + 1;
      else hi = mid;
    }
    const r = ranges[lo - 1];
    // Pages before the first range show plain numbers.
    if (!r) return { style: new PdfName('D'), prefix: undefined, n: i + 1 };
    const st = intOf(await resolve(ctx, r[1].get('St')));
    return { style: await resolve(ctx, r[1].get('S')), prefix: await resolve(ctx, r[1].get('P')), n: (st ?? 1) + i - r[0] };
  };
  const text = (o: PdfObj | undefined): string => (o instanceof PdfName ? '/' + o.name : o instanceof PdfString ? latin1(stringBytes(o)) : '');
  const nums: PdfObj[] = [];
  let prev: Label | undefined;
  for (let j = 0; j < sel.length; j++) {
    const l = await labelOf(sel[j]);
    const continues = prev && text(prev.style) === text(l.style) && text(prev.prefix) === text(l.prefix) && l.n === prev.n + 1;
    prev = l;
    if (continues) continue;
    const entries: [string, PdfObj][] = [];
    if (l.style instanceof PdfName) entries.push(['S', l.style]);
    if (l.prefix instanceof PdfString) entries.push(['P', l.prefix]);
    if (l.n !== 1) entries.push(['St', l.n]);
    nums.push(j, dict(entries));
  }
  setEntry(ctx, cn, 'PageLabels', dict([['Nums', nums]]));
}
