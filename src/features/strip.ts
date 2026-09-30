import { latin1 } from '../core/bytes.ts';
import { nameOf, PdfDict, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import { walkPages } from '../core/pages.ts';
import type { Plugin, RewriteContext } from '../core/rewrite.ts';
import { stringBytes } from '../core/strings.ts';
import { E_COMPRESSED } from '../core/xref.ts';
import { catalog, editSub, gcStages, patched, resolve, setEntry, setObject } from './unused.ts';

type Want = (d: PdfDict, stream: boolean) => boolean;

/**
 * Finds the objects a plugin cares about without a second pass over the file: uncompressed ones
 * during the engine's header scan, the members of object streams when asked for the list.
 */
function sweep(want: Want) {
  // Per rewrite, so one plugin instance can serve several.
  const hits = new WeakMap<RewriteContext, number[]>();
  return {
    scan(num: number, hdr: ObjHeader, ctx: RewriteContext): void {
      if (!(hdr.value instanceof PdfDict) || !want(hdr.value, hdr.stream)) return;
      const h = hits.get(ctx);
      if (h) h.push(num);
      else hits.set(ctx, [num]);
    },
    async nums(ctx: RewriteContext): Promise<number[]> {
      const index = ctx.doc.index;
      const out = hits.get(ctx) ?? [];
      hits.delete(ctx);
      for (let n = 1; n < index.size; n++) {
        if (index.type[n] !== E_COMPRESSED) continue;
        const v = await ctx.doc.getObject(n);
        if (v instanceof PdfDict && want(v, false)) out.push(n);
      }
      return out;
    },
  };
}

const has = (d: PdfDict, keys: string[]): boolean => keys.some((k) => d.map.has(k));

function remove(ctx: RewriteContext, num: number, d: PdfObj | undefined, keys: string[]): void {
  if (d instanceof PdfDict) for (const k of keys) if (d.map.has(k)) setEntry(ctx, num, k, null);
}

export interface StripMetadataOptions {
  /**
   * Also remove /Metadata, /PieceInfo and /LastModified from every other dictionary and stream
   * (images, form XObjects, fonts, annotations, ...). Default true. Cheap: uncompressed objects
   * are checked during the header scan the rewrite does anyway, and a stream only gets a new
   * dictionary (its data is copied as is); object-stream members are parsed once more.
   */
  deep?: boolean;
}

const DOC_KEYS = ['Metadata', 'PieceInfo', 'LastModified'];
const PAGE_KEYS = ['Metadata', 'PieceInfo', 'LastModified', 'Thumb'];

/**
 * Rewrite plugin that removes document metadata: the document information dictionary (trailer
 * /Info: title, author, producer, dates, ...), the catalog's XMP /Metadata stream and /PieceInfo,
 * and each page's /Metadata, /PieceInfo, /LastModified and /Thumb (thumbnail image); with `deep`
 * (the default) also /Metadata, /PieceInfo and /LastModified everywhere else.
 *
 * The detached objects are then left out of the file (it includes `removeUnused`), and stale
 * copies inside object streams are overwritten, so the metadata is really gone. The trailer /ID is
 * kept. PDF/A and PDF/UA identification lives in the XMP, so the output no longer claims either.
 * Encrypted input is rejected (PdfEncryptedError), also next to `decrypt`: decrypt first, in a
 * separate rewrite.
 */
export function stripMetadata(options: StripMetadataOptions = {}): Plugin {
  const deep = options.deep ?? true;
  const s = sweep((d) => has(d, DOC_KEYS));
  return {
    ...gcStages(),
    scan: deep ? s.scan : undefined,
    async prepare(ctx) {
      ctx.setTrailer('Info', null);
      const cat = await catalog(ctx);
      if (cat) remove(ctx, cat[0], cat[1], DOC_KEYS);
      for await (const p of walkPages(ctx.doc)) if (p.num) remove(ctx, p.num, await ctx.getObject(p.num), PAGE_KEYS);
      if (deep) for (const n of await s.nums(ctx)) remove(ctx, n, await ctx.getObject(n), DOC_KEYS);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// JavaScript

type Memo = Map<number, PdfObj | null | undefined>;

/** A JavaScript action, a URI action with a `javascript:` URI, a rendition action that only runs a script. */
async function isScript(ctx: RewriteContext, d: PdfDict): Promise<boolean> {
  const s = nameOf(d.get('S'));
  if (s === 'JavaScript' || (s === 'Rendition' && d.map.has('JS') && !d.map.has('R'))) return true;
  if (s !== 'URI') return false;
  const uri = await resolve(ctx, d.get('URI'));
  return uri instanceof PdfString && /^\s*javascript:/i.test(latin1(stringBytes(uri)));
}

/**
 * An action, or array of actions, with the scripts taken out of it and of its /Next chain:
 * undefined when unchanged, null when nothing is left, else the replacement. Indirect actions
 * that stay are edited in place. Dictionaries without /S are not actions and stay as they are.
 */
async function clean(ctx: RewriteContext, o: PdfObj | undefined, memo: Memo, depth = 0): Promise<PdfObj | null | undefined> {
  if (depth > 64) return undefined;
  if (Array.isArray(o)) {
    const out: PdfObj[] = [];
    let changed = false;
    for (const x of o) {
      const r = await clean(ctx, x, memo, depth + 1);
      if (r === undefined) out.push(x);
      else {
        changed = true;
        if (Array.isArray(r)) out.push(...r);
        else if (r !== null) out.push(r);
      }
    }
    return changed ? (out.length ? out : null) : undefined;
  }
  let num = -1;
  let d: PdfObj | undefined = o;
  if (o instanceof PdfRef) {
    num = o.num;
    if (memo.has(num)) return memo.get(num);
    memo.set(num, undefined); // a cycle reads as unchanged
    d = await ctx.getObject(num);
  }
  if (!(d instanceof PdfDict) || d.get('S') === undefined) return undefined;
  let r: PdfObj | null | undefined;
  const next = d.get('Next');
  if (await isScript(ctx, d)) {
    // Replaced by whatever follows it.
    const n = next === undefined ? null : await clean(ctx, next, memo, depth + 1);
    r = n === undefined ? next : n;
  } else {
    const changes = await actionChanges(ctx, d, memo, depth);
    if (changes.size && num >= 0) for (const [k, v] of changes) setEntry(ctx, num, k, v);
    else if (changes.size) r = patched(d, changes);
  }
  if (num >= 0) memo.set(num, r);
  return r;
}

/** Changes to a non-script action: its /Next chain, the script of a rendition action that also plays media. */
async function actionChanges(ctx: RewriteContext, d: PdfDict, memo: Memo, depth: number): Promise<Map<string, PdfObj | null>> {
  const changes = new Map<string, PdfObj | null>();
  const next = d.get('Next');
  const n = next === undefined ? undefined : await clean(ctx, next, memo, depth + 1);
  if (n !== undefined) changes.set('Next', n);
  if (nameOf(d.get('S')) === 'Rendition' && d.map.has('JS')) changes.set('JS', null);
  return changes;
}

/** Changes to a dictionary that may hold actions: /A, /OpenAction, /PA, /AA, direct annotations. */
async function scriptChanges(ctx: RewriteContext, num: number, d: PdfDict, memo: Memo, depth = 0): Promise<Map<string, PdfObj | null>> {
  const changes = d.get('S') === undefined ? new Map<string, PdfObj | null>() : await actionChanges(ctx, d, memo, depth);
  for (const k of ['A', 'OpenAction', 'PA']) {
    const r = await clean(ctx, d.get(k), memo, depth);
    if (r !== undefined) changes.set(k, r);
  }
  // Additional actions (page open/close, form keystroke/format/validate/calculate, ...).
  const aa = d.get('AA');
  const aad = await resolve(ctx, aa);
  if (aad instanceof PdfDict) {
    const sub = new Map<string, PdfObj | null>();
    for (const [k, v] of aad.map) {
      const r = await clean(ctx, v, memo, depth);
      if (r !== undefined) sub.set(k, r);
    }
    let left = 0;
    for (const k of aad.map.keys()) if (sub.get(k) !== null) left++;
    if (!left) changes.set('AA', null);
    else if (sub.size && aa instanceof PdfRef) for (const [k, v] of sub) setEntry(ctx, aa.num, k, v);
    else if (sub.size) changes.set('AA', patched(aad, sub));
  }
  // Annotations should be indirect, but some writers put them directly in /Annots.
  const annots = d.get('Annots');
  const arr = await resolve(ctx, annots);
  if (Array.isArray(arr) && depth === 0 && arr.some((x) => x instanceof PdfDict)) {
    let changed = false;
    const out: PdfObj[] = [];
    for (const x of arr) {
      const c = x instanceof PdfDict ? await scriptChanges(ctx, num, x, memo, 1) : undefined;
      changed ||= !!c?.size;
      out.push(c?.size ? patched(x as PdfDict, c) : x);
    }
    if (changed && annots instanceof PdfRef) setObject(ctx, annots.num, out);
    else if (changed) changes.set('Annots', out);
  }
  return changes;
}

const ACTION_HOLDERS = ['A', 'AA', 'OpenAction', 'PA', 'Annots'];

/**
 * Rewrite plugin that removes JavaScript (best effort; rendering is unaffected):
 * - the document-level scripts (catalog /Names /JavaScript name tree);
 * - JavaScript actions wherever actions live: /OpenAction, /A of links, widgets, outline items
 *   and other annotations, /PA, every /AA additional-actions entry (document will-close/save/
 *   print, page open/close, annotation and form-field keystroke/format/validate/calculate
 *   scripts), and inside /Next chains, where a script is replaced by the actions after it;
 *   links whose only action was a script remain as inert links;
 * - URI actions with a `javascript:` URI, and the /JS script of rendition actions (the whole
 *   action when it has no rendition to play);
 * - the AcroForm calculation order /CO (calculate actions are always scripts);
 * - every JavaScript action object itself is replaced by null, and the scripts, now
 *   unreferenced, are left out of the file (it includes `removeUnused`).
 * Not touched: XFA form scripts (/AcroForm /XFA), 3D and rich-media scripts. Encrypted input is
 * rejected (PdfEncryptedError), also next to `decrypt`.
 */
export function removeJavaScript(): Plugin {
  const s = sweep(
    (d, stream) =>
      !stream && (has(d, ACTION_HOLDERS) || ['JavaScript', 'Rendition', 'URI'].includes(nameOf(d.get('S')) ?? '') || (d.map.has('S') && d.map.has('Next'))),
  );
  return {
    ...gcStages(),
    scan: s.scan,
    async prepare(ctx) {
      const cat = await catalog(ctx);
      if (cat) {
        const names = await resolve(ctx, cat[1].get('Names'));
        if (names instanceof PdfDict && names.map.has('JavaScript')) await editSub(ctx, cat[0], 'Names', new Map([['JavaScript', null]]));
        const form = await resolve(ctx, cat[1].get('AcroForm'));
        if (form instanceof PdfDict && form.map.has('CO')) await editSub(ctx, cat[0], 'AcroForm', new Map([['CO', null]]));
      }
      const memo: Memo = new Map();
      const scripts: number[] = [];
      for (const n of await s.nums(ctx)) {
        const d = await ctx.getObject(n);
        if (!(d instanceof PdfDict)) continue;
        if (await isScript(ctx, d)) scripts.push(n);
        else for (const [k, v] of await scriptChanges(ctx, n, d, memo)) setEntry(ctx, n, k, v);
      }
      // Anything still pointing at a script action now points at null.
      for (const n of scripts) setObject(ctx, n, null);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Attachments

/**
 * Rewrite plugin that removes embedded files:
 * - the document's attachments (catalog /Names /EmbeddedFiles);
 * - file attachment annotations (taken off every page, their pop-ups too, and replaced by null
 *   wherever else they are referenced, e.g. from the structure tree);
 * - associated files (/AF, PDF 2.0 and PDF/A-3) of the catalog, pages, XObjects and any other
 *   dictionary, and the portfolio (catalog /Collection), whose cover pages then show as the
 *   document.
 * The files themselves, now unreferenced, are left out (it includes `removeUnused`). Files that
 * are still referenced for another purpose (3D and rich-media assets, launch actions) are kept.
 * Encrypted input is rejected (PdfEncryptedError), also next to `decrypt`.
 */
export function removeAttachments(): Plugin {
  const s = sweep((d, stream) => d.map.has('AF') || (!stream && (d.map.has('Annots') || nameOf(d.get('Subtype')) === 'FileAttachment')));
  return {
    ...gcStages(),
    scan: s.scan,
    async prepare(ctx) {
      const cat = await catalog(ctx);
      if (cat) {
        const names = await resolve(ctx, cat[1].get('Names'));
        if (names instanceof PdfDict && names.map.has('EmbeddedFiles')) await editSub(ctx, cat[0], 'Names', new Map([['EmbeddedFiles', null]]));
        remove(ctx, cat[0], cat[1], ['AF', 'Collection']);
      }
      const nums = await s.nums(ctx);
      const gone = new Set<number>();
      for (const n of nums) {
        const d = await ctx.getObject(n);
        if (d instanceof PdfDict && nameOf(d.get('Subtype')) === 'FileAttachment') gone.add(n);
      }
      const isGone = async (x: PdfObj): Promise<boolean> => {
        if (x instanceof PdfRef && gone.has(x.num)) return true;
        const a = await resolve(ctx, x);
        if (!(a instanceof PdfDict)) return false;
        const t = nameOf(a.get('Subtype'));
        if (t === 'FileAttachment') return true;
        const p = a.get('Parent');
        return t === 'Popup' && ((p instanceof PdfRef && gone.has(p.num)) || (p instanceof PdfDict && nameOf(p.get('Subtype')) === 'FileAttachment'));
      };
      for (const n of nums) {
        const d = await ctx.getObject(n);
        if (gone.has(n) || !(d instanceof PdfDict)) continue;
        remove(ctx, n, d, ['AF']);
        const annots = d.get('Annots');
        const arr = await resolve(ctx, annots);
        if (!Array.isArray(arr)) continue;
        const out: PdfObj[] = [];
        for (const x of arr) if (!(await isGone(x))) out.push(x);
        if (out.length === arr.length) continue;
        if (annots instanceof PdfRef) setObject(ctx, annots.num, out);
        else setEntry(ctx, n, 'Annots', out.length ? out : null);
      }
      for (const n of gone) setObject(ctx, n, null);
    },
  };
}
