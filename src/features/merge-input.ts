import { latin1 } from '../core/bytes.ts';
import type { PdfDocument } from '../core/document.ts';
import { intOf, nameOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import { stringBytes } from '../core/strings.ts';
import type { OutputWriter } from '../core/writer.ts';
import { E_COMPRESSED, E_OFFSET } from '../core/xref.ts';
import { namedDests, renum, ser, type Numbering } from './merge-syntax.ts';

/** Marking states before numbering. */
export const KEEP = 1;
const BLOCKED = -1;
/** Output number of the merged page tree root (1 is the catalog). */
export const PAGES = 2;

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
/** Objects never carried along: the page tree, catalogs and the structure tree. */
const BLOCKED_TYPES = ['Page', 'Pages', 'Catalog', 'StructTreeRoot', 'StructElem'];

type Inherited = Map<string, { v: PdfObj; raw: Uint8Array }>;

interface PageEntry {
  /** Source object number; 0 for a (malformed) direct page dictionary. */
  num: number;
  /** Attributes inherited from the ancestors, with their source bytes. */
  inh: Inherited;
  dict?: PdfDict;
}

/** The output side shared by all inputs: the writer, object numbers and their offsets. */
export class Out {
  readonly w: OutputWriter;
  next = PAGES + 1;
  offsets = new Float64Array(1024);

  constructor(w: OutputWriter) {
    this.w = w;
  }

  alloc(): number {
    return this.next++;
  }

  async begin(num: number): Promise<void> {
    if (num >= this.offsets.length) {
      const o = new Float64Array(Math.max(num + 1, this.offsets.length * 2));
      o.set(this.offsets);
      this.offsets = o;
    }
    this.offsets[num] = this.w.pos;
    await this.w.write(`${num} 0 obj\n`);
  }

  async obj(num: number, body: string): Promise<void> {
    await this.begin(num);
    await this.w.write(`${body}\nendobj\n`);
  }
}

/**
 * One input's pass: find the objects its selected pages need, give them numbers in the output and
 * write them in one forward pass. Memory: an Int32Array slot per source object, the selected pages
 * and a work list.
 */
export class InputPass implements Numbering {
  readonly doc: PdfDocument;
  readonly catalog: PdfDict;
  /** Source number -> KEEP / BLOCKED / 0 while marking; the output number (or 0) after `number`. */
  readonly map: Int32Array;
  /** Output numbers of the selected pages, in order. */
  readonly kids: number[] = [];
  /** Source objects written by the caller instead (e.g. the outline root). */
  readonly deferred = new Set<number>();
  /** New /T values of renamed top-level form fields, by source number. */
  readonly renames = new Map<number, string>();
  /** A signature dictionary was reached. */
  signed = false;
  private readonly warn: (m: string) => void;
  private readonly signal?: AbortSignal;
  private chosen: PageEntry[] = [];
  private readonly pageOf = new Map<number, PageEntry>();
  private readonly annots = new Set<number>();
  private readonly extra: [PageEntry, number][] = [];
  private stack: number[] = [];
  private readonly dests = new Map<string, PdfObj | null>();
  private destRoots?: [PdfObj | undefined, PdfObj | undefined];
  private leaf?: [number, Map<string, PdfObj>];

  private constructor(doc: PdfDocument, catalog: PdfDict, warn: (m: string) => void, signal?: AbortSignal) {
    this.doc = doc;
    this.catalog = catalog;
    this.map = new Int32Array(doc.index.size);
    this.warn = warn;
    this.signal = signal;
  }

  /** List the pages, apply the selection and mark what the selected pages reference. */
  static async create(doc: PdfDocument, sel: number[] | undefined, warn: (m: string) => void, signal?: AbortSignal): Promise<InputPass> {
    const root = doc.trailer.get('Root');
    const p = new InputPass(doc, (await doc.resolve(root)) as PdfDict, warn, signal);
    if (root instanceof PdfRef && root.num < p.map.length) p.map[root.num] = BLOCKED;
    const pages = await p.listPages();
    p.chosen = sel
      ? sel.map((k) => {
          if (!(Number.isInteger(k) && k >= 0 && k < pages.length)) throw new RangeError(`Page ${k} does not exist (the input has ${pages.length} pages)`);
          return pages[k];
        })
      : pages;
    // Two rounds: marking needs every kept annotation first (widgets elsewhere are left out).
    for (let round = 0; round < 2; round++) {
      const seen = new Set<number>();
      for (const e of p.chosen) {
        if (e.num) {
          if (seen.has(e.num)) continue;
          seen.add(e.num);
          p.pageOf.set(e.num, e);
          p.map[e.num] = KEEP;
        }
        const d = e.dict ?? (await doc.getObject(e.num));
        if (!(d instanceof PdfDict)) continue;
        if (round) {
          for (const [k, v] of d.map) if (k !== 'Parent' && k !== 'B') p.visit(v);
          for (const [k, x] of e.inh) if (d.get(k) == null) p.visit(x.v);
        } else {
          const annots = await doc.resolve(d.get('Annots'));
          if (Array.isArray(annots)) for (const a of annots) if (a instanceof PdfRef) p.annots.add(a.num);
        }
      }
    }
    return p;
  }

  get pageCount(): number {
    return this.chosen.length;
  }

  /** Page tree leaves in order; every page tree node is marked BLOCKED. */
  private async listPages(): Promise<PageEntry[]> {
    const { doc, map } = this;
    const out: PageEntry[] = [];
    const top = this.catalog.get('Pages');
    const stack: { kids: PdfObj[]; i: number; inh: Inherited }[] = [{ kids: top === undefined ? [] : [top], i: 0, inh: new Map() }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i >= f.kids.length) {
        stack.pop();
        continue;
      }
      const kid = f.kids[f.i++];
      const num = kid instanceof PdfRef ? kid.num : 0;
      if (num) {
        if (num >= map.length || map[num]) continue;
        map[num] = BLOCKED;
      }
      const node = await doc.resolve(kid);
      if (!(node instanceof PdfDict)) continue;
      const kids = await doc.resolve(node.get('Kids'));
      const type = nameOf(node.get('Type'));
      if (type !== 'Pages' && (type === 'Page' || !Array.isArray(kids))) {
        out.push({ num, inh: f.inh, dict: num ? undefined : node });
        continue;
      }
      if (!Array.isArray(kids) || stack.length >= 256) continue;
      let inh = f.inh;
      for (const k of INHERITED) {
        const raw = node.raw.get(k);
        if (!raw?.length) continue;
        if (inh === f.inh) inh = new Map(inh);
        inh.set(k, { v: node.get(k)!, raw });
      }
      stack.push({ kids, i: 0, inh });
    }
    return out;
  }

  /** Mark the objects `o` references (they are read by `drain`). */
  visit(o: PdfObj | undefined): void {
    if (o instanceof PdfRef) {
      const n = o.num;
      const t = this.doc.index.type[n];
      if (n < this.map.length && !this.map[n] && (t === E_OFFSET || t === E_COMPRESSED)) {
        this.map[n] = KEEP;
        this.stack.push(n);
      }
    } else if (Array.isArray(o)) for (const x of o) this.visit(x);
    else if (o instanceof PdfDict) for (const v of o.map.values()) this.visit(v);
  }

  /**
   * Read every marked object and mark what it references, level by level in file order (so reads
   * stay mostly sequential). Objects of unselected pages are blocked: page tree nodes, annotations
   * whose /P is such a page, widgets not on a selected page, and the structure tree.
   */
  async drain(): Promise<void> {
    const { doc, map } = this;
    const { type: t, a, b } = doc.index;
    const key = (n: number): number => (t[n] === E_OFFSET ? a[n] : a[a[n]] + 0.5);
    let count = 0;
    while (this.stack.length) {
      const batch = this.stack.sort((x, y) => key(x) - key(y) || b[x] - b[y]);
      this.stack = [];
      for (const n of batch) {
        if (++count % 256 === 0) this.signal?.throwIfAborted();
        const h = t[n] === E_OFFSET ? await doc.header(n) : null;
        const v = h ? h.value : await doc.getObject(n);
        if (!(v instanceof PdfDict)) {
          this.visit(v);
          continue;
        }
        const type = nameOf(v.get('Type'));
        const parent = v.get('P');
        if (
          BLOCKED_TYPES.includes(type!) ||
          (h?.stream && (type === 'XRef' || type === 'ObjStm')) ||
          (!type && v.get('S') instanceof PdfName && parent instanceof PdfRef && (v.get('K') ?? v.get('Pg')) !== undefined) ||
          (!this.annots.has(n) && ((parent instanceof PdfRef && map[parent.num] === BLOCKED) || nameOf(v.get('Subtype')) === 'Widget'))
        ) {
          map[n] = BLOCKED;
          continue;
        }
        if (v.get('ByteRange') !== undefined && v.get('Contents') !== undefined) this.signed = true;
        for (const [k, x] of v.map) if (!(h?.stream && k === 'Length')) this.visit(x);
      }
    }
  }

  /** Give the marked objects consecutive output numbers; repeated pages get fresh ones. */
  number(out: Out): void {
    const map = this.map;
    for (let n = 1; n < map.length; n++) map[n] = map[n] === KEEP ? out.alloc() : 0;
    const seen = new Set<number>();
    for (const e of this.chosen) {
      if (e.num && !seen.has(e.num)) {
        seen.add(e.num);
        this.kids.push(map[e.num]);
      } else {
        const k = out.alloc();
        this.kids.push(k);
        this.extra.push([e, k]);
      }
    }
  }

  out(num: number): number {
    return num > 0 && num < this.map.length && this.map[num] > 0 ? this.map[num] : 0;
  }

  dest(name: PdfObj | undefined): PdfObj | undefined {
    const k = destKey(name);
    return k === undefined ? undefined : (this.dests.get(k) ?? undefined);
  }

  /** Write every numbered object: uncompressed ones in file order, then object stream members. */
  async write(out: Out, progress: (done: number, total: number) => void): Promise<void> {
    const { doc, map } = this;
    const index = doc.index;
    let total = 0;
    let comp = 0;
    for (let n = 1; n < map.length; n++) {
      if (map[n] <= 0) continue;
      total++;
      if (index.type[n] === E_COMPRESSED) comp++;
    }
    let done = 0;
    const tick = (): void => {
      if (++done % 256 === 0) {
        this.signal?.throwIfAborted();
        progress(done, total);
      }
    };
    const order = index.sortedOffsets();
    const sections = [...doc.sections, doc.reader.size].sort((x, y) => x - y);
    for (let i = 0; i < order.length; i++) {
      const n = order[i];
      if (map[n] <= 0 || this.deferred.has(n)) continue;
      tick();
      const h = await doc.header(n);
      if (h?.stream && !this.pageOf.has(n)) await this.stream(out, n, h, boundary(order, i, sections, doc));
      else await this.value(out, n, h?.value);
    }
    // Object stream members, grouped by stream so each is decoded once.
    const members = new Uint32Array(comp);
    comp = 0;
    for (let n = 1; n < map.length; n++) if (map[n] > 0 && index.type[n] === E_COMPRESSED) members[comp++] = n;
    members.sort((x, y) => index.a[x] - index.a[y] || index.b[x] - index.b[y]);
    for (const n of members) {
      if (this.deferred.has(n)) continue;
      tick();
      await this.value(out, n, await doc.getObject(n));
    }
    for (const [e, k] of this.extra) await this.value(out, e.num, e.dict ?? (await doc.getObject(e.num)), k, e);
    progress(total, total);
  }

  private async stream(out: Out, n: number, h: ObjHeader, bound: number): Promise<void> {
    const span = await this.doc.span(h, bound);
    let s = span.dataStart;
    let e = span.dataEnd;
    if (e < 0) {
      // No `endstream`: trust a /Length that fits, else take everything up to the next object.
      const len = intOf(await this.doc.resolve((h.value as PdfDict).get('Length')));
      s = h.dataStart;
      e = len !== undefined && len >= 0 && s + len <= bound ? s + len : Math.max(s, bound);
      this.warn(`object ${n}: the end of its stream was not found`);
    }
    await out.begin(this.map[n]);
    await out.w.write(`${ser(h.value, this, new Map([['Length', String(e - s)]]))}\nstream\n`);
    await out.w.copy(s, e - s, this.doc.reader.src);
    await out.w.write('\nendstream\nendobj\n');
  }

  /** Write the non-stream object `n` (as `num`, for extra copies of a page). */
  private async value(out: Out, n: number, v: PdfObj | undefined, num = this.map[n], page = this.pageOf.get(n)): Promise<void> {
    if (v === undefined) this.warn(`object ${n} could not be read; it was replaced by null`);
    const names: (PdfString | PdfName)[] = [];
    namedDests(v, names);
    for (const x of names) await this.resolveDest(x);
    let body: string;
    if (page && v instanceof PdfDict) {
      const edits = new Map<string, string | null>([['Parent', `${PAGES} 0 R`], ['B', null]]);
      if (nameOf(v.get('Type')) !== 'Page') edits.set('Type', '/Page');
      for (const [k, x] of page.inh) if (v.get(k) == null) edits.set(k, renum(x.raw, this));
      if (!edits.has('MediaBox') && v.get('MediaBox') == null) edits.set('MediaBox', '[0 0 612 792]');
      body = ser(v, this, edits);
    } else {
      const t = this.renames.get(n);
      body = ser(v, this, t !== undefined && v instanceof PdfDict ? new Map([['T', t]]) : undefined);
    }
    await out.obj(num, body);
  }

  /** Look up a named destination (catalog /Dests, then the /Names /Dests tree) and cache it. */
  private async resolveDest(name: PdfString | PdfName): Promise<void> {
    const key = destKey(name)!;
    if (this.dests.has(key)) return;
    const doc = this.doc;
    if (!this.destRoots) {
      const names = await doc.resolve(this.catalog.get('Names'));
      this.destRoots = [await doc.resolve(this.catalog.get('Dests')), names instanceof PdfDict ? names.get('Dests') : undefined];
    }
    const [old, tree] = this.destRoots;
    let d = old instanceof PdfDict ? old.get(key) : undefined;
    if (d === undefined) d = await this.nameTree(tree, key);
    d = await doc.resolve(d);
    if (d instanceof PdfDict) d = await doc.resolve(d.get('D'));
    this.dests.set(key, Array.isArray(d) ? d : null);
  }

  /** Find `key` in a name tree, following /Limits. The last leaf read is kept as a map. */
  private async nameTree(node: PdfObj | undefined, key: string): Promise<PdfObj | undefined> {
    const doc = this.doc;
    const str = (o: PdfObj | undefined): string | undefined => (o instanceof PdfString ? latin1(stringBytes(o)) : undefined);
    for (let depth = 0; depth < 32 && node !== undefined; depth++) {
      const num = node instanceof PdfRef ? node.num : -1;
      if (this.leaf?.[0] === num) return this.leaf[1].get(key);
      const d = await doc.resolve(node);
      if (!(d instanceof PdfDict)) return;
      const names = await doc.resolve(d.get('Names'));
      if (Array.isArray(names)) {
        const m = new Map<string, PdfObj>();
        for (let i = 0; i + 1 < names.length; i += 2) {
          const k = str(names[i] instanceof PdfRef ? await doc.resolve(names[i]) : names[i]);
          if (k !== undefined && !m.has(k)) m.set(k, names[i + 1]);
        }
        this.leaf = [num, m];
        return m.get(key);
      }
      const kids = await doc.resolve(d.get('Kids'));
      node = undefined;
      if (Array.isArray(kids)) {
        for (const kid of kids) {
          const kd = await doc.resolve(kid);
          const lim = kd instanceof PdfDict ? await doc.resolve(kd.get('Limits')) : undefined;
          const lo = Array.isArray(lim) ? str(lim[0]) : undefined;
          const hi = Array.isArray(lim) ? str(lim[1]) : undefined;
          if (lo !== undefined && hi !== undefined && key >= lo && key <= hi) {
            node = kid;
            break;
          }
        }
      }
    }
    return undefined;
  }
}

function destKey(o: PdfObj | undefined): string | undefined {
  return o instanceof PdfName ? o.name : o instanceof PdfString ? latin1(stringBytes(o)) : undefined;
}

/** An object ends before the next object or cross-reference section, whichever comes first. */
function boundary(order: Uint32Array, i: number, sections: number[], doc: PdfDocument): number {
  const a = doc.index.a;
  const start = a[order[i]];
  let end = i + 1 < order.length ? a[order[i + 1]] : doc.reader.size;
  for (const s of sections) {
    if (s > start) {
      end = Math.min(end, s);
      break;
    }
  }
  return end;
}
