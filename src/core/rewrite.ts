import { ascii } from './bytes.ts';
import { PdfDocument, type ObjSpan } from './document.ts';
import { PdfEncryptedError } from './errors.ts';
import { nameOf, PdfDict, PdfRef, type PdfObj } from './objects.ts';
import type { ObjHeader } from './objread.ts';
import { SourceReader } from './reader.ts';
import { dictString, serialize } from './serialize.ts';
import type { OutputSink, ProgressEvent, RandomAccessSource } from './types.ts';
import { OutputWriter, writeXrefStream, writeXrefTable, type XrefEntryFn } from './writer.ts';
import { E_COMPRESSED, E_FREE, E_OFFSET } from './xref.ts';

/**
 * What a plugin does with one uncompressed object in the write pass: undefined leaves it to the
 * next plugin (and finally copies it), `body` replaces its value (everything between `N G obj`
 * and `endobj`), `task` computes a replacement asynchronously while later objects are analyzed.
 */
export type ObjectAction = undefined | { drop: true } | { body: Uint8Array[] } | { task: Promise<TaskResult> };

/** A task's replacement (null keeps the object), or a function producing it when the object is written. */
export type TaskResult = Uint8Array[] | null | (() => Uint8Array[] | null);

/** What plugins can do to the document. Edits apply wherever an object is stored. */
export interface RewriteContext {
  readonly doc: PdfDocument;
  /** Set a dictionary entry of object `num` (null removes it). A stream keeps its data. */
  setEntry(num: number, key: string, value: PdfObj | null): void;
  /** Replace the whole value of a non-stream object. */
  setObject(num: number, value: PdfObj): void;
  /** Add a new object; returns a reference to it. */
  addObject(value: PdfObj): PdfRef;
  /** Set a trailer entry (Root, Info or ID); null removes it. */
  setTrailer(key: 'Root' | 'Info' | 'ID', value: PdfObj | null): void;
  /** Leave out every object for which `keep` returns false. */
  setKeep(keep: (num: number) => boolean): void;
  /** An object's value with the edits made so far. */
  getObject(num: number): Promise<PdfObj | undefined>;
  /** The trailer entries with the edits made so far. */
  trailer(): Map<string, PdfObj>;
  /** Count bytes saved, for progress events. */
  saved(bytes: number): void;
  warn(message: string): void;
}

/**
 * A step of a rewrite. Stages run in order for all plugins: setup, scan (each uncompressed
 * object's header), prepare (make edits), finalize (after all edits, e.g. reachability),
 * transform (per object, first action wins).
 */
export interface Plugin {
  /** Set when the plugin decrypts, so encrypted input is accepted. */
  decrypts?: boolean;
  setup?(ctx: RewriteContext): void | Promise<void>;
  scan?(num: number, hdr: ObjHeader, ctx: RewriteContext): void;
  prepare?(ctx: RewriteContext): void | Promise<void>;
  finalize?(ctx: RewriteContext): void | Promise<void>;
  transform?(num: number, hdr: ObjHeader, span: ObjSpan, ctx: RewriteContext): ObjectAction | Promise<ObjectAction>;
}

export interface RewriteOptions {
  signal?: AbortSignal;
  /** Replacement tasks (e.g. images) in flight at once. Default 1, which bounds memory. */
  concurrency?: number;
  onProgress?: (e: ProgressEvent) => void;
}

export interface RewriteReport {
  inputBytes: number;
  outputBytes: number;
  /** The input carried a digital signature; any rewrite invalidates it. */
  signaturesInvalidated: boolean;
  /** The cross-reference data was damaged and had to be rebuilt. */
  xrefRepaired: boolean;
  warnings: string[];
}

type Plan = {
  num: number;
  drop?: boolean;
  span?: ObjSpan;
  body?: Uint8Array[];
  /** New dictionary for a stream whose data is copied verbatim. */
  streamDict?: string;
  task?: Promise<{ ok: TaskResult } | { err: unknown }>;
};

/** A dictionary with edits applied; edited keys keep their position, new keys go last. */
function edited(d: PdfDict, e: Map<string, PdfObj | null>): PdfDict {
  const out = new PdfDict();
  for (const [k, v] of d.map) {
    if (!e.has(k)) out.set(k, v, d.raw.get(k)!);
    else if (e.get(k) !== null) out.set(k, e.get(k)!, ascii(serialize(e.get(k)!)));
  }
  for (const [k, v] of e) if (v !== null && !d.map.has(k)) out.set(k, v, ascii(serialize(v)));
  return out;
}

/**
 * Rewrite a PDF in one forward pass: every live object in source order, copied byte for byte
 * unless a plugin changes it, then one fresh cross-reference section. Incremental updates
 * collapse; old xref streams and a stale linearization dictionary are dropped; object streams are
 * copied verbatim. The sink is closed on success and aborted (if it can be) on failure.
 */
export async function rewritePdf(
  input: RandomAccessSource | PdfDocument,
  sink: OutputSink,
  plugins: Plugin[] = [],
  opts: RewriteOptions = {},
): Promise<RewriteReport> {
  try {
    const report = await run(input, sink, plugins, opts);
    await sink.close();
    return report;
  } catch (e) {
    await sink.abort?.(e).catch(() => {});
    throw e;
  }
}

async function run(input: RandomAccessSource | PdfDocument, sink: OutputSink, plugins: Plugin[], opts: RewriteOptions): Promise<RewriteReport> {
  const { signal, onProgress } = opts;
  signal?.throwIfAborted();
  const doc = input instanceof PdfDocument ? input : await PdfDocument.open(new SourceReader(input), signal);
  if (doc.trailer.get('Encrypt') !== undefined && !plugins.some((p) => p.decrypts)) throw new PdfEncryptedError();
  const source = doc.reader.src;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const index = doc.index;
  const reader = doc.reader;
  const order = index.sortedOffsets();
  const warnings = [...doc.warnings];

  // Edits made by plugins.
  const entryEdits = new Map<number, Map<string, PdfObj | null>>();
  const objects = new Map<number, PdfObj>();
  const trailerEdits = new Map<string, PdfObj | null>();
  let keep: (num: number) => boolean = () => true;
  let size = Math.max(index.size, Math.min(doc.declaredSize, index.size + 4096));
  let bytesSaved = 0;

  const effective = async (num: number): Promise<PdfObj | undefined> => {
    if (objects.has(num)) return objects.get(num);
    const v = await doc.getObject(num);
    const e = entryEdits.get(num);
    return e && v instanceof PdfDict ? edited(v, e) : v;
  };
  const trailerNow = (): Map<string, PdfObj> => {
    const t = new Map(doc.trailer.map);
    for (const [k, v] of trailerEdits) if (v === null) t.delete(k);
    else t.set(k, v);
    return t;
  };
  const ctx: RewriteContext = {
    doc,
    setEntry(num, key, value) {
      let e = entryEdits.get(num);
      if (!e) entryEdits.set(num, (e = new Map()));
      e.set(key, value);
    },
    setObject: (num, value) => void objects.set(num, value),
    addObject(value) {
      objects.set(size, value);
      return new PdfRef(size++, 0);
    },
    setTrailer: (key, value) => void trailerEdits.set(key, value),
    setKeep: (k) => void (keep = k),
    getObject: effective,
    trailer: trailerNow,
    saved: (n) => void (bytesSaved += n),
    warn: (m) => void warnings.push(m),
  };

  for (const p of plugins) await p.setup?.(ctx);

  // Pass 1: headers only.
  let signed = false;
  const dropped = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    if (i % 256 === 0) signal?.throwIfAborted();
    const hdr = await doc.header(order[i]);
    const d = hdr?.value;
    if (!(d instanceof PdfDict)) continue;
    if (d.get('ByteRange') !== undefined && d.get('Contents') !== undefined) signed = true;
    if (hdr!.stream && nameOf(d.get('Type')) === 'XRef') dropped.add(order[i]);
    if (i === 0 && !hdr!.stream && d.get('Linearized') !== undefined) dropped.add(order[i]);
    for (const p of plugins) p.scan?.(order[i], hdr!, ctx);
  }
  const root = await doc.resolve(doc.trailer.get('Root'));
  const form = root instanceof PdfDict ? await doc.resolve(root.get('AcroForm')) : undefined;
  const sigFlags = form instanceof PdfDict ? await doc.resolve(form.get('SigFlags')) : undefined;
  if (typeof sigFlags === 'number' && sigFlags & 1) signed = true;
  if (signed) warnings.push('The document is digitally signed; the signatures will no longer validate');
  for (const p of plugins) await p.prepare?.(ctx);
  for (const p of plugins) await p.finalize?.(ctx);

  const live = (n: number): boolean => !dropped.has(n) && keep(n);
  const rewritten = (n: number): boolean => objects.has(n) || entryEdits.has(n);
  // Object streams stay verbatim, so their untouched members keep compressed entries.
  const compressedLive = (n: number): boolean =>
    index.type[n] === E_COMPRESSED && !rewritten(n) && live(n) && index.get(index.a[n]) === E_OFFSET && live(index.a[n]);
  let useXrefStream = false;
  for (let n = 0; n < index.size && !useXrefStream; n++) if (compressedLive(n)) useXrefStream = true;

  // Pass 2: write every live object in file order.
  const sections = [...doc.sections, reader.size].sort((a, b) => a - b);
  const newOffset = new Float64Array(size).fill(-1);
  const w = new OutputWriter(sink, source);
  const version = useXrefStream && doc.version < '1.5' ? '1.5' : doc.version;
  await w.write(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);

  /** An object ends before the next object or xref section, whichever comes first. */
  const boundaryAfter = (i: number): number => {
    const start = index.a[order[i]];
    const b = i + 1 < order.length ? index.a[order[i + 1]] : reader.size;
    let lo = 0;
    let hi = sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sections[mid] > start) hi = mid;
      else lo = mid + 1;
    }
    return Math.min(b, sections[lo]);
  };

  const analyze = async (i: number): Promise<Plan> => {
    const num = order[i];
    if (!live(num)) return { num, drop: true };
    if (objects.has(num)) return { num, body: [ascii(serialize(objects.get(num)!))] };
    const boundary = boundaryAfter(i);
    let hdr = await doc.header(num);
    if (!hdr) {
      // Unparseable: copy verbatim up to the next known object.
      const start = index.a[num];
      const sep = !(await doc.endsWithWhite(boundary));
      return { num, span: { start, end: boundary, dataStart: -1, dataEnd: -1, addEndobj: false, sep } };
    }
    const span = await doc.span(hdr, boundary);
    const e = entryEdits.get(num);
    if (e && hdr.value instanceof PdfDict) hdr = { ...hdr, value: edited(hdr.value, e) };
    for (const p of plugins) {
      const a = await p.transform?.(num, hdr, span, ctx);
      if (!a) continue;
      if ('drop' in a) return { num, drop: true };
      if ('body' in a) return { num, body: a.body };
      // If the task keeps the object, it is written as it would have been without the plugin.
      const fallback = e ? editedPlan(num, hdr, span) : { num, span };
      return { ...fallback, task: a.task.then((ok) => ({ ok }), (err: unknown) => ({ err })) };
    }
    return e ? editedPlan(num, hdr, span) : { num, span };
  };

  const dictFor = (hdr: ObjHeader): string => dictString(hdr.value as PdfDict, new Map());
  const editedPlan = (num: number, hdr: ObjHeader, span: ObjSpan): Plan => {
    if (!(hdr.value instanceof PdfDict)) return { num, span };
    if (!hdr.stream) return { num, body: [ascii(dictFor(hdr))] };
    if (span.dataEnd < 0) {
      warnings.push(`Object ${num}: could not find the end of its stream, so it was copied without edits`);
      return { num, span };
    }
    return { num, span, streamDict: dictFor(hdr) };
  };

  const writeBody = async (num: number, gen: number, body: Uint8Array[]): Promise<void> => {
    newOffset[num] = w.pos;
    await w.write(`${num} ${gen} obj\n`);
    for (const p of body) await w.write(p);
    await w.write('\nendobj\n');
  };

  const writePlan = async (p: Plan): Promise<void> => {
    if (p.task) {
      const r = await p.task;
      if ('err' in r) throw r.err;
      const b = typeof r.ok === 'function' ? r.ok() : r.ok;
      if (b) return writeBody(p.num, index.b[p.num], b);
    }
    if (p.drop) return;
    if (p.body) return writeBody(p.num, index.b[p.num], p.body);
    const span = p.span!;
    newOffset[p.num] = w.pos;
    if (p.streamDict !== undefined && span.dataEnd >= 0) {
      await w.write(`${p.num} ${index.b[p.num]} obj\n${p.streamDict}\nstream\n`);
      await w.copy(span.dataStart, span.dataEnd - span.dataStart);
      await w.write('\nendstream\nendobj\n');
      return;
    }
    await w.copy(span.start, span.end - span.start);
    if (span.addEndobj) await w.write('\nendobj\n');
    else if (span.sep) await w.write('\n');
  };

  const queue: Plan[] = [];
  let next = 0;
  let inflight = 0;
  let done = 0;
  while (next < order.length || queue.length) {
    signal?.throwIfAborted();
    while (next < order.length && inflight < concurrency && queue.length < 64) {
      const p = await analyze(next++);
      if (p.task) inflight++;
      queue.push(p);
    }
    const p = queue.shift()!;
    await writePlan(p);
    if (p.task) inflight--;
    done++;
    if (onProgress && (p.task || done % 512 === 0)) onProgress({ processedObjects: done, totalObjects: order.length, bytesSaved });
  }

  // Edited objects from object streams, and new objects, go after everything else.
  for (let n = 1; n < size; n++) {
    if (newOffset[n] >= 0 || !rewritten(n) || !live(n)) continue;
    if (!objects.has(n) && index.get(n) !== E_COMPRESSED) continue;
    const v = await effective(n);
    if (v !== undefined) await writeBody(n, 0, [ascii(serialize(v))]);
  }

  const entry: XrefEntryFn = (n) => {
    if (n > 0 && newOffset[n] >= 0) return [1, newOffset[n], index.get(n) === E_OFFSET ? index.b[n] : 0];
    if (compressedLive(n)) return [2, index.a[n], index.b[n]];
    return [0, 0, index.get(n) === E_FREE ? index.b[n] : 0];
  };
  const trailer = new PdfDict();
  for (const [k, v] of trailerNow()) trailer.set(k, v, trailerEdits.has(k) ? ascii(serialize(v)) : doc.trailer.raw.get(k)!);
  if (useXrefStream) await writeXrefStream(w, size, entry, trailer);
  else await writeXrefTable(w, size, entry, trailer);
  await w.flush();
  onProgress?.({ processedObjects: order.length, totalObjects: order.length, bytesSaved });
  return { inputBytes: source.size, outputBytes: w.pos, signaturesInvalidated: signed, xrefRepaired: doc.repaired, warnings };
}
