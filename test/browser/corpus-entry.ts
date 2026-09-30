/** Browser side of the corpus runner: render pages of a PDF fetched from `url`, as RGBA (base64). */
import { openPdf } from '../../src/core/open.ts';
import { walkPages } from '../../src/core/pages.ts';
import { decryptPdf, isEncrypted } from '../../src/features/decrypt.ts';
import { BlobPartsSink } from '../../src/io/blob.ts';
import { renderPage } from '../../src/render/page.ts';

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

(globalThis as unknown as { leanCorpus: unknown }).leanCorpus = async (url: string, maxPages: number, scale: number, ms: number) => {
  let blob = await (await fetch(url)).blob();
  let doc;
  try {
    doc = await openPdf(blob);
    // Encrypted files with an empty user password are decrypted first.
    if (isEncrypted(doc)) {
      const sink = new BlobPartsSink();
      await decryptPdf(doc, sink);
      blob = sink.blob;
      doc = await openPdf(blob);
    }
  } catch (e) {
    return { error: message(e) };
  }
  let count = 0;
  for await (const _ of walkPages(doc)) count++;
  const pages = [];
  const canvas = new OffscreenCanvas(1, 1);
  for (let i = 0; i < Math.min(count, maxPages); i++) {
    const t0 = performance.now();
    try {
      const r = await renderPage(doc, i, canvas, { scale, signal: AbortSignal.timeout(ms) });
      const data = canvas.getContext('2d')!.getImageData(0, 0, r.width, r.height).data;
      pages.push({ width: r.width, height: r.height, warnings: r.warnings, ms: performance.now() - t0, rgba: toB64(new Uint8Array(data.buffer)) });
    } catch (e) {
      pages.push({ error: message(e), ms: performance.now() - t0 });
    }
  }
  return { count, pages };
};
