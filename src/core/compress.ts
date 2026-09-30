import { PdfDocument, type ObjSpan } from './document.ts';
import { isFatal, PdfEncryptedError } from './errors.ts';
import { buildImageObject, buildMaskObject, checkOutput, classifyImage, loadImage, shrinkMask, type ImagePlan } from './image.ts';
import { fitInside } from './resize.ts';
import { nameOf, PdfDict, PdfRef } from './objects.ts';
import type { ObjHeader } from './objread.ts';
import { SourceReader } from './reader.ts';
import type { CompressOptions, CompressReport, OutputSink, RandomAccessSource, RecompressOptions } from './types.ts';
import { OutputWriter, writeXrefStream, writeXrefTable, type XrefEntryFn } from './writer.ts';
import { E_COMPRESSED, E_FREE, E_OFFSET } from './xref.ts';

interface Plan {
  num: number;
  kind: 'copy' | 'image' | 'drop';
  span?: ObjSpan;
  task?: Promise<ImageResult>;
}

type ImageResult = { parts: Uint8Array[]; saved: number } | { reason: string } | { fatal: unknown };

const DEFAULTS = {
  maxWidth: 1600,
  maxHeight: 1600,
  jpegQuality: 0.75,
  preserveGray: true,
  minImageBytes: 20_000,
  minSavingsRatio: 0.9,
  concurrency: 1,
};

/**
 * Recompress the raster images of a PDF. Reads `source` with bounded random access and writes a
 * complete new file to `sink` in one forward pass; unchanged objects are copied byte for byte.
 * The sink is closed on success and aborted (if it supports it) on failure.
 */
export async function compressPdf(source: RandomAccessSource, sink: OutputSink, options: CompressOptions): Promise<CompressReport> {
  try {
    const report = await run(source, sink, options);
    await sink.close();
    return report;
  } catch (e) {
    await sink.abort?.(e).catch(() => {});
    throw e;
  }
}

async function run(source: RandomAccessSource, sink: OutputSink, options: CompressOptions): Promise<CompressReport> {
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const v = options[k];
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  if (!(o.maxWidth >= 1 && o.maxHeight >= 1)) throw new RangeError('maxWidth and maxHeight must be >= 1');
  if (!(o.jpegQuality > 0 && o.jpegQuality <= 1)) throw new RangeError('jpegQuality must be in (0, 1]');
  if (!(o.minSavingsRatio > 0)) throw new RangeError('minSavingsRatio must be > 0');
  const concurrency = Math.max(1, Math.floor(o.concurrency));
  const { codec, signal, onProgress } = options;
  const recompress: RecompressOptions = {
    maxWidth: Math.floor(o.maxWidth),
    maxHeight: Math.floor(o.maxHeight),
    jpegQuality: o.jpegQuality,
    preserveGray: o.preserveGray,
  };

  signal?.throwIfAborted();
  const reader = new SourceReader(source);
  const doc = await PdfDocument.open(reader, signal);
  if (doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
  const index = doc.index;
  const report: CompressReport = {
    imagesSeen: 0,
    imagesRecompressed: 0,
    imagesSkipped: {},
    inputBytes: source.size,
    outputBytes: 0,
    signaturesInvalidated: false,
    xrefRepaired: doc.repaired,
    warnings: [...doc.warnings],
  };
  const skip = (reason: string): void => {
    report.imagesSkipped[reason] = (report.imagesSkipped[reason] ?? 0) + 1;
  };
  const order = index.sortedOffsets();

  // Pass 1: headers only. Find soft masks (they must stay gray and lossless), signatures, and
  // the objects we drop: old xref streams and a now-stale linearization dictionary.
  const softMasks = new Set<number>();
  const dropped = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    if (i % 256 === 0) signal?.throwIfAborted();
    const hdr = await doc.header(order[i]);
    const d = hdr?.value;
    if (!(d instanceof PdfDict)) continue;
    const sm = d.get('SMask');
    if (sm instanceof PdfRef) softMasks.add(sm.num);
    if (d.get('ByteRange') !== undefined && d.get('Contents') !== undefined) report.signaturesInvalidated = true;
    if (hdr!.stream && nameOf(d.get('Type')) === 'XRef') dropped.add(order[i]);
    if (i === 0 && !hdr!.stream && d.get('Linearized') !== undefined) dropped.add(order[i]);
  }
  const root = await doc.resolve(doc.trailer.get('Root'));
  const form = root instanceof PdfDict ? await doc.resolve(root.get('AcroForm')) : undefined;
  const sigFlags = form instanceof PdfDict ? await doc.resolve(form.get('SigFlags')) : undefined;
  if (typeof sigFlags === 'number' && sigFlags & 1) report.signaturesInvalidated = true;
  if (report.signaturesInvalidated) report.warnings.push('The document is digitally signed; the signatures will no longer validate');

  // Object streams stay verbatim, so their members keep their compressed entries.
  let useXrefStream = false;
  for (let n = 0; n < index.size && !useXrefStream; n++) {
    if (index.type[n] === E_COMPRESSED && index.get(index.a[n]) === E_OFFSET) useXrefStream = true;
  }

  // Pass 2: write every live object in file order.
  const sections = [...doc.sections, reader.size].sort((a, b) => a - b);
  const newOffset = new Float64Array(index.size).fill(-1);
  const w = new OutputWriter(sink, source);
  const version = useXrefStream && doc.version < '1.5' ? '1.5' : doc.version;
  await w.write(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);

  let processed = 0;
  let bytesSaved = 0;
  const progress = (force: boolean): void => {
    if (onProgress && (force || processed % 512 === 0)) {
      onProgress({ processedObjects: processed, totalObjects: order.length, bytesSaved });
    }
  };

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

  const processImage = async (hdr: ObjHeader, span: ObjSpan, plan: ImagePlan): Promise<ImageResult> => {
    try {
      const input = await loadImage(doc, span, plan);
      if (typeof input === 'string') return { reason: input };
      let out;
      try {
        out = await codec.recompress(input, recompress);
      } catch {
        return { reason: 'codecError' };
      }
      if (!out) return { reason: 'codecDeclined' };
      const info = checkOutput(out.data);
      if (!info) return { reason: 'codecOutputInvalid' };
      const oldLength = span.dataEnd - span.dataStart;
      if (out.data.length > oldLength * o.minSavingsRatio) return { reason: 'noGain' };
      const keepColorSpace = plan.icc && plan.comps === info.components;
      const parts = buildImageObject(hdr.num, hdr.gen, hdr.value as PdfDict, out.data, info, keepColorSpace);
      return { parts, saved: oldLength - out.data.length };
    } catch (e) {
      return isFatal(e) ? { fatal: e } : { reason: 'error' };
    }
  };

  const processMask = async (hdr: ObjHeader, span: ObjSpan, plan: ImagePlan, ow: number, oh: number): Promise<ImageResult> => {
    try {
      const data = await shrinkMask(doc, span, plan, ow, oh);
      if (typeof data === 'string') return { reason: data };
      const oldLength = span.dataEnd - span.dataStart;
      if (data.length > oldLength * o.minSavingsRatio) return { reason: 'noGain' };
      return { parts: buildMaskObject(hdr.num, hdr.gen, hdr.value as PdfDict, data, ow, oh), saved: oldLength - data.length };
    } catch (e) {
      return isFatal(e) ? { fatal: e } : { reason: 'error' };
    }
  };

  const analyze = async (i: number): Promise<Plan> => {
    const num = order[i];
    if (dropped.has(num)) return { num, kind: 'drop' };
    const boundary = boundaryAfter(i);
    const hdr = await doc.header(num);
    if (!hdr) {
      // Unparseable: copy verbatim up to the next known object.
      const start = index.a[num];
      const sep = !(await doc.endsWithWhite(boundary));
      return { num, kind: 'copy', span: { start, end: boundary, dataStart: -1, dataEnd: -1, addEndobj: false, sep } };
    }
    const span = await doc.span(hdr, boundary);
    if (hdr.stream && span.dataEnd >= 0) {
      const plan = await classifyImage(doc, hdr.value as PdfDict, span.dataEnd - span.dataStart, o.minImageBytes, softMasks.has(num));
      if (plan !== null) {
        report.imagesSeen++;
        if (typeof plan === 'string') skip(plan);
        else if (!plan.mask) return { num, kind: 'image', span, task: processImage(hdr, span, plan) };
        else {
          // Soft masks shrink to the same box as their images; masks that already fit stay as they are.
          const [ow, oh] = fitInside(plan.width, plan.height, recompress.maxWidth, recompress.maxHeight);
          if (ow < plan.width || oh < plan.height || plan.chain === 'raw') return { num, kind: 'image', span, task: processMask(hdr, span, plan, ow, oh) };
          skip('softMask');
        }
      }
    }
    return { num, kind: 'copy', span };
  };

  const copy = async (num: number, span: ObjSpan): Promise<void> => {
    newOffset[num] = w.pos;
    await w.copy(span.start, span.end - span.start);
    if (span.addEndobj) await w.write('\nendobj\n');
    else if (span.sep) await w.write('\n');
  };

  const queue: Plan[] = [];
  let next = 0;
  let inflight = 0;
  while (next < order.length || queue.length) {
    signal?.throwIfAborted();
    while (next < order.length && inflight < concurrency && queue.length < 64) {
      const plan = await analyze(next++);
      if (plan.task) inflight++;
      queue.push(plan);
    }
    const plan = queue.shift()!;
    if (plan.kind === 'image') {
      const r = await plan.task!;
      inflight--;
      if ('fatal' in r) throw r.fatal;
      if ('reason' in r) {
        skip(r.reason);
        await copy(plan.num, plan.span!);
      } else {
        newOffset[plan.num] = w.pos;
        for (const p of r.parts) await w.write(p);
        report.imagesRecompressed++;
        bytesSaved += r.saved;
      }
      processed++;
      progress(true);
      continue;
    }
    if (plan.kind === 'copy') await copy(plan.num, plan.span!);
    processed++;
    progress(false);
  }

  const entry: XrefEntryFn = (n) => {
    const t = index.get(n);
    if (n > 0 && t === E_OFFSET && newOffset[n] >= 0) return [1, newOffset[n], index.b[n]];
    if (t === E_COMPRESSED && newOffset[index.a[n]] >= 0) return [2, index.a[n], index.b[n]];
    return [0, 0, t === E_FREE ? index.b[n] : 0];
  };
  // Keep object numbers the source reserved (so no dangling reference can hit the new xref
  // stream), but don't let an absurd /Size bloat the table.
  const size = Math.max(index.size, Math.min(doc.declaredSize, index.size + 4096));
  if (useXrefStream) await writeXrefStream(w, size, entry, doc.trailer);
  else await writeXrefTable(w, size, entry, doc.trailer);
  await w.flush();
  report.outputBytes = w.pos;
  progress(true);
  return report;
}
