/**
 * Web Worker for the browser end-to-end test: compresses the posted PDF Blob with compressPdfBlob
 * (default BrowserImageCodec) and transfers the output bytes back.
 */
import { compressPdfBlob, type CompressOptions, type RewriteProgress } from '../../src/index.ts';

type Opts = Omit<CompressOptions, 'codec' | 'signal' | 'onProgress'>;

self.onmessage = async (e: MessageEvent<{ file: Blob; opts: Opts }>) => {
  const events: RewriteProgress[] = [];
  try {
    const t0 = performance.now();
    const { blob, report } = await compressPdfBlob(e.data.file, { ...e.data.opts, onProgress: (p) => events.push({ ...p }) });
    const ms = performance.now() - t0;
    const buf = await blob.arrayBuffer();
    self.postMessage({ ok: true, report, events, ms, blobType: blob.type, buf }, { transfer: [buf] });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
