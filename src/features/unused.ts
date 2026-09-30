import { ascii, EMPTY } from '../core/bytes.ts';
import { PdfEncryptedError } from '../core/errors.ts';
import { deflate } from '../core/flate.ts';
import { reachable } from '../core/gc.ts';
import { Lexer, T_NUM } from '../core/lexer.ts';
import { intOf, nameOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import type { ObjectAction, Plugin, RewriteContext } from '../core/rewrite.ts';
import { dictString } from '../core/serialize.ts';
import { E_COMPRESSED } from '../core/xref.ts';

/** Per-rewrite state shared by the plugins that drop objects. */
interface GcState {
  /** Objects edited through `setEntry`/`setObject` below: their copies in object streams are stale. */
  edited: Set<number>;
  /** Objects to leave out even while still referenced (references to them read as null). */
  severed: Set<number>;
  keep?: Promise<(num: number) => boolean>;
  /** Object streams already looked at. */
  seen: Set<number>;
  /** `selectPages` ran. */
  paged?: boolean;
}

const states = /* @__PURE__ */ new WeakMap<RewriteContext, GcState>();

/** @internal */
export function gcState(ctx: RewriteContext): GcState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { edited: new Set(), severed: new Set(), seen: new Set() }));
  return s;
}

/** @internal `ctx.setEntry`, remembering the edit so the stale copy in an object stream gets overwritten. */
export function setEntry(ctx: RewriteContext, num: number, key: string, value: PdfObj | null): void {
  gcState(ctx).edited.add(num);
  ctx.setEntry(num, key, value);
}

/** @internal `ctx.setObject`, remembering the edit. */
export function setObject(ctx: RewriteContext, num: number, value: PdfObj): void {
  gcState(ctx).edited.add(num);
  ctx.setObject(num, value);
}

/** @internal A copy of `d` with some entries replaced or (null) removed; untouched entries keep their bytes. */
export function patched(d: PdfDict, changes: Map<string, PdfObj | null>): PdfDict {
  const out = new PdfDict();
  for (const [k, v] of d.map) if (!changes.has(k)) out.set(k, v, d.raw.get(k)!);
  for (const [k, v] of changes) if (v !== null) out.set(k, v, EMPTY);
  return out;
}

/**
 * @internal Apply `changes` to the dictionary stored under `key` in object `owner`: in place when
 * it is an indirect object, else by replacing the owner's entry.
 */
export async function editSub(ctx: RewriteContext, owner: number, key: string, changes: Map<string, PdfObj | null>): Promise<void> {
  if (!changes.size) return;
  const od = await ctx.getObject(owner);
  const v = od instanceof PdfDict ? od.get(key) : undefined;
  if (v instanceof PdfRef) {
    if ((await ctx.getObject(v.num)) instanceof PdfDict) for (const [k, x] of changes) setEntry(ctx, v.num, k, x);
  } else if (v instanceof PdfDict) setEntry(ctx, owner, key, patched(v, changes));
}

/** @internal The catalog's object number and (edited) dictionary. */
export async function catalog(ctx: RewriteContext): Promise<[number, PdfDict] | undefined> {
  const r = ctx.trailer().get('Root');
  const d = r instanceof PdfRef ? await ctx.getObject(r.num) : undefined;
  return d instanceof PdfDict ? [(r as PdfRef).num, d] : undefined;
}

/** @internal Resolve with the rewrite's edits applied. */
export async function resolve(ctx: RewriteContext, o: PdfObj | undefined): Promise<PdfObj | undefined> {
  for (let i = 0; o instanceof PdfRef && i < 16; i++) o = await ctx.getObject(o.num);
  return o instanceof PdfRef ? undefined : o;
}

/**
 * @internal Editing plugins read the document's structure, which they cannot do while it is
 * encrypted, even alongside a decrypting plugin (that decrypts only as objects are written).
 */
export function plain(ctx: RewriteContext): void {
  if (ctx.doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
}

/** @internal Compute reachability once per rewrite and apply it. */
export function collect(ctx: RewriteContext): Promise<(num: number) => boolean> {
  const s = gcState(ctx);
  const skip = s.severed.size ? (n: number) => s.severed.has(n) : undefined;
  s.keep ??= reachable(ctx.doc, [...ctx.trailer().values()], (n) => ctx.getObject(n), skip);
  return s.keep.then((keep) => {
    ctx.setKeep(keep);
    return keep;
  });
}

const MAX_OBJSTM = 32 << 20;

/**
 * @internal Object streams are copied verbatim, so objects that were dropped, edited or superseded
 * would linger inside them. Rewrite such streams with those members overwritten (every slot stays
 * in place, so the cross-reference entries of the others stay valid), or drop them when no member
 * is left.
 */
async function scrub(num: number, hdr: ObjHeader, dataEnd: number, ctx: RewriteContext): Promise<ObjectAction> {
  const s = states.get(ctx);
  const d = hdr.value;
  if (!s?.keep || !hdr.stream || dataEnd < 0 || !(d instanceof PdfDict) || nameOf(d.get('Type')) !== 'ObjStm' || s.seen.has(num)) return;
  s.seen.add(num);
  const keep = await s.keep;
  const doc = ctx.doc;
  const n = intOf(await doc.resolve(d.get('N')));
  const first = intOf(await doc.resolve(d.get('First')));
  const data = await doc.streamData(hdr, MAX_OBJSTM);
  if (!data || n === undefined || first === undefined || n < 0 || first > data.length) return;
  const lex = new Lexer(data.subarray(0, first), 0, true);
  const pairs: number[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const t = lex.next();
    if (t.t !== T_NUM || !t.int) return;
    pairs.push(t.v as number);
  }
  const index = doc.index;
  // Where a reader looks for each member, by the same rule as PdfDocument.getObject: the slot the
  // cross-reference entry names, else the last slot holding that number.
  const last = new Map<number, number>();
  for (let i = 0; i < n; i++) last.set(pairs[2 * i], i);
  const live = (i: number): boolean => {
    const m = pairs[2 * i];
    if (index.get(m) !== E_COMPRESSED || index.a[m] !== num || !keep(m) || s.edited.has(m)) return false;
    const b = index.b[m];
    return (pairs[2 * b] === m ? b : last.get(m)) === i;
  };
  const size = data.length - first;
  const current: boolean[] = [];
  for (let i = 0; i < n; i++) current.push(live(i));
  if (current.every(Boolean)) return;
  // No live member left: everything in it was dropped or is written anew.
  if (!current.includes(true)) return { drop: true };
  const keepSlot = current.map((c, i) => c && pairs[2 * i + 1] >= 0 && pairs[2 * i + 1] < size);
  if (!keepSlot.includes(true)) return;
  // A member's value runs up to the next member's offset.
  const starts = [...new Set(pairs.filter((_, i) => i & 1)), size].sort((a, b) => a - b);
  const next = new Map<number, number>();
  for (let i = 0; i + 1 < starts.length; i++) next.set(starts[i], starts[i + 1]);
  const value = (i: number): Uint8Array => data.subarray(first + pairs[2 * i + 1], first + next.get(pairs[2 * i + 1])!);
  // Other slots must keep their positions, so a stale slot becomes a copy of the smallest live
  // member: every reader finds the same value whichever copy it picks, and none of them sees a
  // member without a matching cross-reference entry (qpdf warns about those).
  let filler = -1;
  for (let i = 0; i < n; i++) if (keepSlot[i] && (filler < 0 || value(i).length < value(filler).length)) filler = i;
  let head = '';
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const j = keepSlot[i] ? i : filler;
    const v = value(j);
    head += `${pairs[2 * j]} ${pos} `;
    parts.push(v, ascii('\n'));
    pos += v.length + 1;
  }
  head += '\n';
  const out = await deflate([ascii(head), ...parts]);
  const updates = new Map<string, string | null>([
    ['First', String(head.length)],
    ['Filter', '/FlateDecode'],
    ['DecodeParms', null],
    ['DL', null],
    ['Length', String(out.length)],
  ]);
  return { body: [ascii(`${dictString(d, updates)}\nstream\n`), out, ascii('\nendstream')] };
}

/** @internal The finalize and transform stages of `removeUnused`, for plugins that drop objects. */
export const gcStages = (): Pick<Plugin, 'setup' | 'finalize' | 'transform'> => ({
  setup: plain,
  finalize: (ctx) => collect(ctx).then(() => {}),
  transform: (num, hdr, span, ctx) => scrub(num, hdr, span.dataEnd, ctx),
});

/**
 * Rewrite plugin that leaves out every object nothing references any more, the way a garbage
 * collector would. Reachability is computed from the trailer (/Root, /Info, and anything else it
 * references) after all other plugins made their edits, whatever the plugin order, so objects
 * other plugins detached (pages, metadata, attachments, ...) go too. An object stream is kept
 * while any of its members is live; if it also holds members that are unused, edited (by these
 * editing plugins) or superseded by an incremental update, it is rewritten with those slots
 * overwritten, so their old contents do not linger in the file.
 *
 * Costs one visit of every reachable object, and one more decode of each object stream.
 * `stripMetadata`, `removeJavaScript`, `removeAttachments` and `selectPages` already include it.
 * Encrypted input is rejected (PdfEncryptedError), also next to `decrypt`: decrypt first, in a
 * separate rewrite. The same goes for all editing plugins.
 */
export function removeUnused(): Plugin {
  return gcStages();
}
