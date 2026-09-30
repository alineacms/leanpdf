import { isWhite, KW_ENDOBJ, lastIndexOf } from '../core/bytes.ts';
import { PdfEncryptedError } from '../core/errors.ts';
import { intOf, PdfDict } from '../core/objects.ts';
import { rewritePdf, type Plugin, type RewriteOptions, type RewriteReport } from '../core/rewrite.ts';
import { dictString } from '../core/serialize.ts';
import type { OutputSink, RandomAccessSource } from '../core/types.ts';

const CHUNK = 256 * 1024;

/**
 * Rewrite plugin that fixes stream framing: a /Length that does not match where `endstream` is
 * found, and streams missing `endstream` (the data then runs up to `endobj`, or up to the next
 * object). Such streams are rewritten with the right /Length and keywords, their data copied in
 * chunks. Well-formed streams are not touched, and streams another plugin earlier in the list
 * takes are not either. Encrypted input is rejected (PdfEncryptedError), also next to `decrypt`.
 */
export function repairStreams(): Plugin {
  return {
    setup(ctx) {
      if (ctx.doc.trailer.get('Encrypt') !== undefined) throw new PdfEncryptedError();
    },
    async transform(_num, hdr, span, ctx) {
      const d = hdr.value;
      if (!hdr.stream || !(d instanceof PdfDict)) return;
      const doc = ctx.doc;
      let start = span.dataStart;
      let end = span.dataEnd;
      if (end >= 0) {
        if (intOf(await doc.resolve(d.get('Length'))) === end - start) return;
      } else {
        // No `endstream` before the next object: the data ends at `endobj`, or at that object.
        start = hdr.dataStart;
        const base = Math.max(start, span.end - 4096);
        const tail = await doc.reader.raw(base, span.end - base);
        let p = lastIndexOf(tail, KW_ENDOBJ);
        if (p >= 0) {
          if (tail[p - 1] === 10) p--;
          if (tail[p - 1] === 13) p--;
        } else for (p = tail.length; p > 0 && isWhite(tail[p - 1]); ) p--;
        end = Math.max(start, base + p);
      }
      const length = Math.min(end, doc.reader.size) - start;
      ctx.warn(`Object ${hdr.num}: fixed the length of its stream data`);
      const reader = doc.reader;
      // Copied in chunks when its turn comes; exactly /Length bytes, even if a read comes up short.
      async function* data(): AsyncGenerator<Uint8Array> {
        for (let at = 0; at < length; at += CHUNK) {
          const n = Math.min(CHUNK, length - at);
          const b = await reader.raw(start + at, n);
          if (b.length === n) yield b;
          else {
            const padded = new Uint8Array(n);
            padded.set(b.subarray(0, n));
            yield padded;
          }
        }
      }
      return { stream: { dict: dictString(d, new Map([['Length', String(length)]])), data } };
    },
  };
}

/**
 * Rewrite a PDF without changing its content: damaged or missing cross-reference data is rebuilt
 * by scanning the file, wrong stream lengths and missing `endstream`/`endobj` keywords are fixed
 * (`repairStreams`), incremental updates are collapsed, and one fresh, consistent
 * cross-reference section is written. Everything else is copied byte for byte; nothing is
 * dropped. `report.xrefRepaired` says whether the cross-reference data needed rebuilding,
 * `report.warnings` what was fixed. Encrypted input is rejected (PdfEncryptedError). The sink is
 * closed on success and aborted on failure.
 */
export function repairPdf(source: RandomAccessSource, sink: OutputSink, options?: RewriteOptions): Promise<RewriteReport> {
  return rewritePdf(source, sink, [repairStreams()], options);
}
