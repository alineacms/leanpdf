import { ascii, latin1 } from '../core/bytes.ts';
import { PdfDocument } from '../core/document.ts';
import { PdfEncryptedError } from '../core/errors.ts';
import { encodeName, intOf, nameOf, PdfDict, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { SourceReader } from '../core/reader.ts';
import { encodeText, textOf } from '../core/strings.ts';
import type { OutputSink, RandomAccessSource } from '../core/types.ts';
import { OutputWriter, writeXrefTable } from '../core/writer.ts';
import { findHeader } from '../core/xref.ts';
import { InputPass, KEEP, Out, PAGES } from './merge-input.ts';
import { refText, renum, ser } from './merge-syntax.ts';

export interface MergeProgress {
  /** Index of the input being copied. */
  input: number;
  inputCount: number;
  /** Objects of this input written so far, and how many it contributes. */
  processedObjects: number;
  totalObjects: number;
}

export interface MergeOptions {
  signal?: AbortSignal;
  onProgress?: (e: MergeProgress) => void;
  /**
   * Pages to take from each input: 0-based page indices in output order (repeats allowed). A
   * missing or undefined entry takes all pages of that input; an empty array takes none.
   */
  pages?: (number[] | undefined)[];
}

export interface MergeReport {
  /** Total size of the inputs. */
  inputBytes: number;
  outputBytes: number;
  pageCount: number;
  /** Human readable notes, prefixed with "Input N:" (1-based) where they concern one input. */
  warnings: string[];
}

/** Catalog entries taken over from the first input. */
const FIRST_KEYS = ['Lang', 'ViewerPreferences', 'PageLayout', 'PageMode', 'OutputIntents'];

interface OutlineItem {
  num: number;
  title: string;
  /** /First and /Last of the input's own outline, or ''. */
  sub: string;
  /** Its /Count: the items it shows (open), or minus its top-level items (closed). */
  count: number;
  page: number;
}

/** Document-level structures collected across the inputs. */
class Merged {
  first = '';
  info = 0;
  items: OutlineItem[] = [];
  fields: string[] = [];
  fieldNames = new Set<string>();
  dr = new Map<string, Map<string, string>>();
  da = '';
  need = false;
  co: string[] = [];
  ocgs: string[] = [];
  off: string[] = [];
  order: string[] = [];
}

/**
 * Concatenate PDFs into one, streaming: each input is read in turn, only the objects its selected
 * pages need are written (renumbered at the token level; stream data is copied with
 * `sink.copyRange`, never loaded), under a fresh catalog and a flat page tree. Inherited page
 * attributes are pushed down into each page.
 *
 * Kept: the first input's /Lang, /ViewerPreferences, /PageLayout, /PageMode, /OutputIntents and
 * trailer /Info; the outlines, each input's under one top-level item (titled with its /Info
 * /Title, else "Document N") unless only one input contributes pages; form fields (/AcroForm
 * /Fields, /DR, /DA, /CO, /NeedAppearances; top-level fields whose names an earlier input already
 * uses get a "_2", "_3", ... suffix); optional content (/OCProperties /OCGs, the default /OFF
 * state and /Order). Named destinations of links and outline items become explicit ones; /Dest
 * entries and GoTo actions that lead to a page that is left out are removed, other references to
 * objects that are not written become null. Dropped: /Names (so embedded files and document
 * JavaScript), /Dests, /OpenAction, /AA, /Metadata (XMP may claim PDF/A conformance),
 * /StructTreeRoot and /MarkInfo (pages keep their content but lose their tags), /PageLabels,
 * /Threads and page /B, /AcroForm /XFA and /SigFlags, and anything else in the catalogs.
 *
 * The output is a classic xref table; the version is the highest of the inputs (at least 1.4).
 * Encrypted inputs throw `PdfEncryptedError`; signed inputs produce a warning. The sink is closed
 * on success and aborted (if it can be) on failure. Memory: per input, one Int32Array slot per
 * object plus the selected pages; outline, form and layer lists grow with their entries.
 */
export async function mergePdfs(
  inputs: (RandomAccessSource | PdfDocument)[],
  sink: OutputSink,
  opts: MergeOptions = {},
): Promise<MergeReport> {
  try {
    const report = await run(inputs, sink, opts);
    await sink.close();
    return report;
  } catch (e) {
    await sink.abort?.(e).catch(() => {});
    throw e;
  }
}

async function run(inputs: (RandomAccessSource | PdfDocument)[], sink: OutputSink, opts: MergeOptions): Promise<MergeReport> {
  const { signal, onProgress } = opts;
  signal?.throwIfAborted();
  if (!inputs.length) throw new RangeError('mergePdfs needs at least one input');
  let version = '1.4';
  for (const x of inputs) {
    const v = x instanceof PdfDocument ? x.version : (await findHeader(new SourceReader(x))).version;
    if (v > version) version = v;
  }
  const first = inputs[0];
  const w = new OutputWriter(sink, first instanceof PdfDocument ? first.reader.src : first);
  const out = new Out(w);
  await w.write(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  const m = new Merged();
  const kids: number[] = [];
  const warnings: string[] = [];
  let inputBytes = 0;
  let catVersion = version;
  let seed = '';

  for (let i = 0; i < inputs.length; i++) {
    signal?.throwIfAborted();
    const x = inputs[i];
    const doc = x instanceof PdfDocument ? x : await PdfDocument.open(new SourceReader(x), signal);
    if (doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
    const warn = (msg: string): void => void warnings.push(`Input ${i + 1}: ${msg}`);
    doc.warnings.forEach(warn);
    inputBytes += doc.reader.size;
    const sel = opts.pages?.[i];
    seed += `${doc.reader.size} ${latin1(doc.trailer.raw.get('ID') ?? ascii('')).slice(0, 80)} ${sel ?? ''}\n`;

    const p = await InputPass.create(doc, sel, warn, signal);
    const cat = p.catalog;
    if (i === 0) {
      for (const k of FIRST_KEYS) p.visit(cat.get(k));
      p.visit(doc.trailer.get('Info'));
    }
    const outline = p.pageCount ? await markOutline(p) : undefined;
    await p.drain();
    const af = await doc.resolve(cat.get('AcroForm'));
    const fields = p.pageCount && af instanceof PdfDict ? await markForm(p, af) : [];
    const sigFlags = af instanceof PdfDict ? await doc.resolve(af.get('SigFlags')) : undefined;
    if (p.signed || (typeof sigFlags === 'number' && sigFlags & 1)) warn('it is digitally signed; its signatures will not validate in the merged file');

    p.number(out);
    for (const k of p.kids) kids.push(k);
    if (i === 0) {
      for (const k of FIRST_KEYS) {
        const raw = cat.raw.get(k);
        if (raw?.length) m.first += `${encodeName(k)} ${renum(raw, p)}\n`;
      }
      const info = doc.trailer.get('Info');
      if (info instanceof PdfRef) m.info = p.out(info.num);
    }
    if (p.pageCount) {
      m.items.push(await outlineItem(p, i, outline));
      if (fields.length) await addForm(p, af as PdfDict, fields, m);
      await addLayers(p, m);
    }
    const cv = nameOf(await doc.resolve(cat.get('Version')));
    if (cv && /^\d\.\d$/.test(cv) && cv > catVersion) catVersion = cv;
    await p.write(out, (done, total) => onProgress?.({ input: i, inputCount: inputs.length, processedObjects: done, totalObjects: total }));
  }

  let extra = '';
  const items = m.items;
  if (items.length === 1 && items[0].sub) {
    // One input: its outline as it was.
    const it = items[0];
    await out.obj(it.num, `<< /Type /Outlines${it.sub} /Count ${Math.abs(it.count)} >>`);
    extra += `/Outlines ${it.num} 0 R\n`;
  } else if (items.some((it) => it.sub)) {
    const root = out.alloc();
    for (const it of items) if (!it.num) it.num = out.alloc();
    let total = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      total += 1 + Math.max(0, it.count);
      const prev = k ? ` /Prev ${items[k - 1].num} 0 R` : '';
      const next = k + 1 < items.length ? ` /Next ${items[k + 1].num} 0 R` : '';
      const sub = it.sub ? `${it.sub} /Count ${it.count}` : '';
      await out.obj(it.num, `<< /Title ${it.title} /Parent ${root} 0 R${prev}${next}${sub} /Dest [${it.page} 0 R /Fit] >>`);
    }
    await out.obj(root, `<< /Type /Outlines /First ${items[0].num} 0 R /Last ${items[items.length - 1].num} 0 R /Count ${total} >>`);
    extra += `/Outlines ${root} 0 R\n`;
  }
  if (m.fields.length) {
    const dr = [...m.dr].map(([c, e]) => `${encodeName(c)} <<${[...e].map(([k, v]) => `${encodeName(k)} ${v}`).join(' ')}>>`);
    extra +=
      `/AcroForm << /Fields [${m.fields.join(' ')}]${dr.length ? ` /DR <<${dr.join(' ')}>>` : ''}${m.da ? ` /DA ${m.da}` : ''}` +
      `${m.need ? ' /NeedAppearances true' : ''}${m.co.length ? ` /CO [${m.co.join(' ')}]` : ''} >>\n`;
  }
  if (m.ocgs.length) {
    extra +=
      `/OCProperties << /OCGs [${m.ocgs.join(' ')}] /D <<${m.order.length ? ` /Order [${m.order.join(' ')}]` : ''}` +
      `${m.off.length ? ` /OFF [${m.off.join(' ')}]` : ''} >> >>\n`;
  }
  if (catVersion > version) extra += `/Version /${catVersion}\n`;
  await out.obj(1, `<< /Type /Catalog /Pages ${PAGES} 0 R\n${m.first}${extra}>>`);
  await out.obj(PAGES, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);

  const trailer = new PdfDict();
  trailer.set('Root', new PdfRef(1, 0), ascii('1 0 R'));
  if (m.info) trailer.set('Info', new PdfRef(m.info, 0), ascii(`${m.info} 0 R`));
  const id = new PdfString(ascii(fileId(`${seed}${kids.length} ${w.pos}`)));
  trailer.set('ID', [id, id], ascii(''));
  const offsets = out.offsets;
  await writeXrefTable(w, out.next, (n) => (n < offsets.length && offsets[n] > 0 ? [1, offsets[n], 0] : [0, 0, 0]), trailer);
  await w.flush();
  if (!kids.length) warnings.push('The merged document has no pages');
  return { inputBytes, outputBytes: w.pos, pageCount: kids.length, warnings };
}

/** Keep the input's outline items; its outline root is written later as the input's own item. */
async function markOutline(p: InputPass): Promise<PdfDict | undefined> {
  const ol = p.catalog.get('Outlines');
  const d = await p.doc.resolve(ol);
  if (!(ol instanceof PdfRef && d instanceof PdfDict && d.get('First') instanceof PdfRef) || ol.num >= p.map.length || p.map[ol.num]) return;
  p.map[ol.num] = KEEP;
  p.deferred.add(ol.num);
  p.visit(d.get('First'));
  p.visit(d.get('Last'));
  return d;
}

async function outlineItem(p: InputPass, i: number, root: PdfDict | undefined): Promise<OutlineItem> {
  const doc = p.doc;
  const info = await doc.resolve(doc.trailer.get('Info'));
  const t = info instanceof PdfDict ? await doc.resolve(info.get('Title')) : undefined;
  const title = t instanceof PdfString && textOf(t)?.trim() ? latin1(t.raw) : `(Document ${i + 1})`;
  const item = { num: 0, title, sub: '', count: 0, page: p.kids[0] };
  const ol = p.catalog.get('Outlines') as PdfRef;
  if (!root || !p.out(ol.num)) return item;
  const first = root.get('First') as PdfRef;
  if (!p.out(first.num)) {
    p.deferred.delete(ol.num);
    return item;
  }
  let count = intOf(await doc.resolve(root.get('Count'))) ?? 0;
  if (count <= 0) {
    // Closed: minus the number of top-level items.
    const seen = new Set<number>();
    for (let it: PdfObj | undefined = first; it instanceof PdfRef && !seen.has(it.num) && seen.size < 1e5; ) {
      seen.add(it.num);
      const d = await doc.resolve(it);
      it = d instanceof PdfDict ? d.get('Next') : undefined;
    }
    count = -seen.size;
  }
  item.num = p.out(ol.num);
  item.sub = ` /First ${ser(first, p)} /Last ${ser(root.get('Last') ?? first, p)}`;
  item.count = count;
  return item;
}

/** Top-level fields that the selected pages' widgets lead to; their /DR entries are kept too. */
async function markForm(p: InputPass, af: PdfDict): Promise<PdfRef[]> {
  const doc = p.doc;
  const all = await doc.resolve(af.get('Fields'));
  const seen = new Set<number>();
  const fields: PdfRef[] = [];
  if (Array.isArray(all)) {
    for (const f of all) {
      if (f instanceof PdfRef && p.map[f.num] === KEEP && !seen.has(f.num)) {
        seen.add(f.num);
        fields.push(f);
      }
    }
  }
  if (fields.length) {
    const dr = await doc.resolve(af.get('DR'));
    if (dr instanceof PdfDict) {
      for (const v of dr.map.values()) {
        const s = await doc.resolve(v);
        if (s instanceof PdfDict) for (const x of s.map.values()) p.visit(x);
      }
    }
    await p.drain();
  }
  return fields;
}

async function addForm(p: InputPass, af: PdfDict, fields: PdfRef[], m: Merged): Promise<void> {
  const doc = p.doc;
  const names: (string | undefined)[] = [];
  const own = new Set<string>();
  for (const f of fields) {
    const d = await doc.resolve(f);
    const t = textOf(d instanceof PdfDict ? await doc.resolve(d.get('T')) : undefined);
    names.push(t);
    if (t !== undefined) own.add(t);
  }
  const renamed = new Map<string, string>();
  fields.forEach((f, k) => {
    const t = names[k];
    if (t !== undefined && m.fieldNames.has(t)) {
      let n = renamed.get(t);
      for (let j = 2; n === undefined; j++) if (!m.fieldNames.has(`${t}_${j}`) && !own.has(`${t}_${j}`)) n = `${t}_${j}`;
      renamed.set(t, n);
      own.add(n);
      p.renames.set(f.num, encodeText(n));
    }
    m.fields.push(refText(p, f.num));
  });
  for (const t of own) m.fieldNames.add(t);
  const dr = await doc.resolve(af.get('DR'));
  if (dr instanceof PdfDict) {
    for (const [c, v] of dr.map) {
      const s = await doc.resolve(v);
      if (!(s instanceof PdfDict)) continue;
      let e = m.dr.get(c);
      if (!e) m.dr.set(c, (e = new Map()));
      for (const [k, x] of s.map) if (!e.has(k)) e.set(k, ser(x, p));
    }
  }
  const da = await doc.resolve(af.get('DA'));
  if (!m.da && da instanceof PdfString) m.da = latin1(da.raw);
  if ((await doc.resolve(af.get('NeedAppearances'))) === true) m.need = true;
  const co = await doc.resolve(af.get('CO'));
  if (Array.isArray(co)) for (const x of co) if (x instanceof PdfRef && p.out(x.num)) m.co.push(refText(p, x.num));
}

/** Optional content groups the kept content uses, their default off state and panel order. */
async function addLayers(p: InputPass, m: Merged): Promise<void> {
  const doc = p.doc;
  const oc = await doc.resolve(p.catalog.get('OCProperties'));
  if (!(oc instanceof PdfDict)) return;
  const all = await doc.resolve(oc.get('OCGs'));
  const ocgs = Array.isArray(all) ? all.filter((x): x is PdfRef => x instanceof PdfRef && p.out(x.num) > 0) : [];
  for (const r of ocgs) m.ocgs.push(refText(p, r.num));
  const d = await doc.resolve(oc.get('D'));
  if (!ocgs.length || !(d instanceof PdfDict)) return;
  const on = await doc.resolve(d.get('ON'));
  const off = await doc.resolve(d.get('OFF'));
  const has = (a: PdfObj | undefined, r: PdfRef): boolean => Array.isArray(a) && a.some((x) => x instanceof PdfRef && x.num === r.num);
  const baseOff = nameOf(await doc.resolve(d.get('BaseState'))) === 'OFF';
  for (const r of ocgs) if (baseOff ? !has(on, r) : has(off, r)) m.off.push(refText(p, r.num));
  const order = await doc.resolve(d.get('Order'));
  if (Array.isArray(order)) m.order.push(...orderItems(order, p));
}

/** An /Order array without the groups that are not kept (and sub-lists left without groups). */
function orderItems(a: PdfObj[], p: InputPass, depth = 0): string[] {
  const out: string[] = [];
  for (const x of a) {
    if (x instanceof PdfRef) {
      if (p.out(x.num)) out.push(refText(p, x.num));
    } else if (Array.isArray(x) && depth < 16) {
      const sub = orderItems(x, p, depth + 1);
      if (sub.some((s) => s[0] === '[' || s.endsWith(' R'))) out.push(`[${sub.join(' ')}]`);
    } else if (x instanceof PdfString) out.push(latin1(x.raw));
  }
  return out;
}

/** A 16-byte hex string derived from `seed` (four FNV-1a variants). */
function fileId(seed: string): string {
  let hex = '';
  for (let k = 0; k < 4; k++) {
    let h = 0x811c9dc5 ^ (k * 0x9e3779b1);
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, '0');
  }
  return `<${hex}>`;
}
