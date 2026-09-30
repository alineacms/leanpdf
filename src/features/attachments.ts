import { EMPTY } from '../core/bytes.ts';
import { readStream } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { PdfError } from '../core/errors.ts';
import { intOf, nameOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import { walkPages } from '../core/pages.ts';
import { parsePdfDate } from './info.ts';
import { arrayOf, assertNotEncrypted, catalogOf, dictOf, textAt, walkTree } from './names.ts';

/** Identifies an attachment's data for `readAttachment` / `attachmentStream`. Treat as opaque. */
export interface AttachmentHandle {
  /** Object number of the embedded file stream. */
  readonly stream: number;
}

/** An embedded file. */
export interface Attachment {
  /** Key in the /EmbeddedFiles name tree; for annotation attachments, the file name. */
  name: string;
  /** File name from the file specification (/UF, else /F), or `name`. May contain a path. */
  filename: string;
  description?: string;
  /** Uncompressed size in bytes, when the file declares it (/Params /Size or /DL). */
  size?: number;
  /** MIME type (/Subtype of the embedded file stream), e.g. 'application/pdf'. */
  mimeType?: string;
  created?: Date;
  modified?: Date;
  /** Relationship to the document (/AFRelationship, PDF/A-3), e.g. 'Source' or 'Alternative'. */
  relationship?: string;
  /** For FileAttachment annotations: 0-based index of the page they are on. */
  pageIndex?: number;
  handle: AttachmentHandle;
}

const CHUNK = 256 * 1024;
/** Compressed input fed to the decompressor at a time. */
const IN_CHUNK = 64 * 1024;

/** A file specification with embedded data as an Attachment, or null (external files). */
async function fromFilespec(doc: PdfDocument, fs: PdfObj | undefined, name: string | undefined): Promise<Attachment | null> {
  const spec = await dictOf(doc, fs);
  const ef = spec && (await dictOf(doc, spec.get('EF')));
  if (!spec || !ef) return null;
  let ref: PdfObj | undefined;
  for (const k of ['UF', 'F', 'DOS', 'Mac', 'Unix']) if (ef.get(k) instanceof PdfRef) (ref ??= ef.get(k));
  const stm = ref instanceof PdfRef ? await dictOf(doc, ref) : undefined;
  if (!(ref instanceof PdfRef) || !stm) return null;
  let filename: string | undefined;
  for (const k of ['UF', 'F', 'Unix', 'Mac', 'DOS']) if (filename === undefined) filename = await textAt(doc, spec.get(k));
  const att: Attachment = { name: name ?? filename ?? '', filename: filename ?? name ?? '', handle: { stream: ref.num } };
  const desc = await textAt(doc, spec.get('Desc'));
  if (desc !== undefined) att.description = desc;
  const params = await dictOf(doc, stm.get('Params'));
  const size = intOf(await doc.resolve(params?.get('Size'))) ?? intOf(await doc.resolve(stm.get('DL')));
  if (size !== undefined && size >= 0) att.size = size;
  const mime = nameOf(await doc.resolve(stm.get('Subtype')));
  if (mime) att.mimeType = mime;
  const created = parsePdfDate(await textAt(doc, params?.get('CreationDate')));
  if (created) att.created = created;
  const modified = parsePdfDate(await textAt(doc, params?.get('ModDate')));
  if (modified) att.modified = modified;
  const rel = nameOf(await doc.resolve(spec.get('AFRelationship')));
  if (rel) att.relationship = rel;
  return att;
}

/**
 * All embedded files: the document's /EmbeddedFiles name tree first, then FileAttachment
 * annotations page by page. A file referenced from several places is listed once (first
 * occurrence). External file references (no embedded data) are left out.
 * Throws PdfEncryptedError for encrypted documents.
 */
export async function listAttachments(doc: PdfDocument): Promise<Attachment[]> {
  assertNotEncrypted(doc);
  const out: Attachment[] = [];
  const seen = new Set<number>();
  const add = (a: Attachment | null): void => {
    if (a && !seen.has(a.handle.stream)) {
      seen.add(a.handle.stream);
      out.push(a);
    }
  };
  const names = await dictOf(doc, (await catalogOf(doc))?.get('Names'));
  await walkTree(doc, names?.get('EmbeddedFiles'), 'Names', async (k, v) => {
    add(await fromFilespec(doc, v, (await textAt(doc, k)) ?? ''));
  });
  for await (const p of walkPages(doc)) {
    for (const a of (await arrayOf(doc, p.dict.get('Annots'))) ?? []) {
      const d = await dictOf(doc, a);
      if (!d || nameOf(await doc.resolve(d.get('Subtype'))) !== 'FileAttachment') continue;
      const att = await fromFilespec(doc, d.get('FS'), undefined);
      if (!att) continue;
      att.pageIndex = p.index;
      if (att.description === undefined) {
        const c = await textAt(doc, d.get('Contents'));
        if (c) att.description = c;
      }
      add(att);
    }
  }
  return out;
}

/** Does the data start with a zlib header (else it is raw deflate)? */
const isZlib = (h: Uint8Array): boolean => h.length >= 2 && (h[0] & 0x0f) === 8 && ((h[0] << 8) | h[1]) % 31 === 0;

/** Source bytes [pos, end) as a pull stream of bounded chunks. */
function rangeStream(doc: PdfDocument, pos: number, end: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        const b = pos < end ? await doc.reader.raw(pos, Math.min(CHUNK, end - pos)) : EMPTY;
        if (!b.length) return ctrl.close();
        pos += b.length;
        ctrl.enqueue(b);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Inflate source bytes [pos, end) on demand: input is fed to the decompressor only while the
 * consumer waits for output, so memory stays bounded even where `pipeThrough` would read the
 * whole input ahead (Node and Bun do).
 */
async function inflateStream(doc: PdfDocument, pos: number, end: number): Promise<ReadableStream<Uint8Array>> {
  const ds = new DecompressionStream(isZlib(await doc.reader.read(pos, 2)) ? 'deflate' : ('deflate-raw' as CompressionFormat));
  const w = ds.writable.getWriter();
  const r = ds.readable.getReader();
  let writing: Promise<void> | undefined;
  let closed = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        const read = r.read();
        let got = false;
        read.then(
          () => (got = true),
          () => (got = true),
        );
        while (!got) {
          if (!writing && !closed) {
            const b = pos < end ? await doc.reader.raw(pos, Math.min(IN_CHUNK, end - pos)) : EMPTY;
            pos += b.length;
            if (b.length) {
              writing = w.write(b as Uint8Array<ArrayBuffer>).then(
                () => void (writing = undefined),
                () => void ((writing = undefined), (closed = true)),
              );
            } else {
              closed = true;
              w.close().catch(() => {});
            }
          }
          await Promise.race(writing ? [read, writing] : [read]).catch(() => {});
        }
        const res = await read;
        if (res.done) ctrl.close();
        else ctrl.enqueue(res.value);
      },
      cancel(reason) {
        r.cancel(reason).catch(() => {});
        w.abort(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

/** Open the decoded data of an embedded file stream as a byte stream. */
async function open(doc: PdfDocument, num: number): Promise<{ stream: ReadableStream<Uint8Array>; expected?: number }> {
  assertNotEncrypted(doc);
  const hdr = await doc.header(num);
  if (!hdr || !hdr.stream) throw new PdfError(`Attachment data (object ${num}) is missing or not a stream`);
  const d = hdr.value as PdfDict;
  const span = await doc.span(hdr, doc.reader.size);
  if (span.dataEnd < 0) throw new PdfError(`Attachment data (object ${num}) has no end`);
  const f = await doc.resolve(d.get('Filter'));
  const filters = Array.isArray(f) ? f : f === undefined || f === null ? [] : [f];
  const first = filters.length === 1 ? nameOf(await doc.resolve(filters[0])) : undefined;
  let dp = await doc.resolve(d.get('DecodeParms'));
  if (Array.isArray(dp)) dp = await doc.resolve(dp[0]);
  const predictor = dp instanceof PdfDict ? (intOf(await doc.resolve(dp.get('Predictor'))) ?? 1) : 1;
  const params = await dictOf(doc, d.get('Params'));
  const expected = intOf(await doc.resolve(params?.get('Size'))) ?? intOf(await doc.resolve(d.get('DL')));
  if (!filters.length) return { stream: rangeStream(doc, span.dataStart, span.dataEnd) };
  if ((first === 'FlateDecode' || first === 'Fl') && predictor === 1) return { stream: await inflateStream(doc, span.dataStart, span.dataEnd), expected };
  // Other filters (and predictors) are decoded in memory.
  const data = await readStream(doc, hdr, 2 ** 31);
  if (!data) throw new PdfError(`Attachment data (object ${num}) uses a filter that cannot be decoded`);
  let at = 0;
  return {
    stream: new ReadableStream<Uint8Array>(
      {
        pull(ctrl) {
          if (at >= data.length) return ctrl.close();
          ctrl.enqueue(data.subarray(at, (at += CHUNK)));
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

const handleOf = (att: Attachment | AttachmentHandle): number => ('handle' in att ? att.handle : att).stream;

/**
 * The decoded contents of an attachment as a stream of chunks, read from the source as the
 * consumer pulls (Flate data is inflated incrementally; other filters are decoded in memory).
 * The stream errors with a PdfError when the data is missing or undecodable, or when Flate data
 * turns out corrupt before the declared size was reached. With no declared size, a Flate error
 * ends the stream normally after whatever decoded (trailing junk is common and harmless).
 * Throws (through the stream) PdfEncryptedError for encrypted documents.
 */
export function attachmentStream(doc: PdfDocument, att: Attachment | AttachmentHandle): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let expected: number | undefined;
  let delivered = 0;
  const num = handleOf(att);
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        if (!reader) {
          const o = await open(doc, num);
          reader = o.stream.getReader();
          expected = o.expected;
        }
        let r: Awaited<ReturnType<typeof reader.read>>;
        try {
          r = await reader.read();
        } catch (e) {
          if (e instanceof Error && (e.name === 'SourceReadError' || e.name === 'AbortError')) throw e;
          if (expected === undefined ? delivered > 0 : delivered >= expected) return ctrl.close();
          throw new PdfError(`Attachment data (object ${num}) is corrupt`);
        }
        if (r.done) return ctrl.close();
        delivered += r.value.length;
        ctrl.enqueue(r.value);
      },
      cancel(reason) {
        return reader?.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** The decoded contents of an attachment, in memory. See `attachmentStream` for errors. */
export async function readAttachment(doc: PdfDocument, att: Attachment | AttachmentHandle): Promise<Uint8Array> {
  const r = attachmentStream(doc, att).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) out.set(p, (n += p.length) - p.length);
  return out;
}
