import { ascii } from '../core/bytes.ts';
import { isFatal, PdfEncryptedError } from '../core/errors.ts';
import { Deflater } from '../core/flate.ts';
import { nameOf, PdfDict } from '../core/objects.ts';
import type { Plugin } from '../core/rewrite.ts';
import { dictString } from '../core/serialize.ts';

export interface RecompressStreamsOptions {
  /**
   * Also compress images stored without a filter. Default true. List `compressImages` before this
   * plugin so it sees the images first: the first plugin to take an object wins, and images it
   * then decides to keep as they are stay uncompressed.
   */
  images?: boolean;
}

export interface StreamsReport {
  /** Streams stored without a filter. */
  streamsSeen: number;
  streamsCompressed: number;
  bytesSaved: number;
}

const CHUNK = 256 * 1024;
/** Bytes `/Filter /FlateDecode` adds to the dictionary. */
const OVERHEAD = 21;

/**
 * Rewrite plugin that Flate-compresses streams stored without any filter: content streams,
 * fonts, ICC profiles, embedded files, forms, uncompressed images... A stream is replaced only
 * when that makes it smaller; its dictionary gets /Filter /FlateDecode and the new /Length (/DL
 * goes). Left alone: streams that already have a filter, cross-reference and object streams, XMP
 * metadata (PDF/A wants it readable), external-file streams (/F) and streams with a /DecodeParms
 * but no filter. Streams another plugin earlier in the list takes are not touched.
 *
 * Works one stream at a time (the rewrite's `concurrency` in parallel): the source is read in
 * chunks, and only the compressed result is held until it is written. Encrypted input is rejected
 * (PdfEncryptedError), also next to `decrypt`: decrypt first, in a separate rewrite.
 */
export function recompressStreams(options: RecompressStreamsOptions = {}): Plugin & { report: StreamsReport } {
  const images = options.images ?? true;
  const report: StreamsReport = { streamsSeen: 0, streamsCompressed: 0, bytesSaved: 0 };
  return {
    report,
    setup(ctx) {
      // Stream data is still encrypted when plugins see it, even next to `decrypt`.
      if (ctx.doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
    },
    transform(_num, hdr, span, ctx) {
      const d = hdr.value;
      if (!hdr.stream || span.dataEnd < 0 || !(d instanceof PdfDict)) return;
      for (const k of ['Filter', 'DecodeParms', 'F']) if (d.get(k) !== undefined && d.get(k) !== null) return;
      const type = nameOf(d.get('Type'));
      const subtype = nameOf(d.get('Subtype'));
      if (type === 'XRef' || type === 'ObjStm' || type === 'Metadata' || subtype === 'XML') return;
      if (!images && subtype === 'Image') return;
      report.streamsSeen++;
      const start = span.dataStart;
      const length = span.dataEnd - start;
      if (length <= OVERHEAD + 8) return;
      const reader = ctx.doc.reader;
      const task = async (): Promise<() => Uint8Array[] | null> => {
        let data: Uint8Array;
        try {
          const z = new Deflater();
          for (let at = 0; at < length; at += CHUNK) {
            const n = Math.min(CHUNK, length - at);
            const b = await reader.raw(start + at, n);
            if (b.length !== n) return () => null;
            await z.write(b);
          }
          data = await z.finish();
        } catch (e) {
          if (isFatal(e)) throw e;
          return () => null;
        }
        // Counted when written, so the report does not depend on timing.
        return () => {
          if (data.length + OVERHEAD >= length) return null;
          report.streamsCompressed++;
          report.bytesSaved += length - data.length;
          ctx.saved(length - data.length);
          const updates = new Map<string, string | null>([
            ['Filter', '/FlateDecode'],
            ['DecodeParms', null],
            ['DL', null],
            ['Length', String(data.length)],
          ]);
          return [ascii(`${dictString(d, updates)}\nstream\n`), data, ascii('\nendstream')];
        };
      };
      return { task: task() };
    },
  };
}
