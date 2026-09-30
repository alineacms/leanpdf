/**
 * Browser side of the codec contract. Bundled by browser.test.ts and loaded twice: as a module
 * script on the page (exposes `globalThis.__contract`) and as a module Web Worker (answers
 * postMessage requests). Both run the same suite against BrowserImageCodec.
 */
import { BrowserImageCodec } from '../../src/index.ts';
import { BROWSER_CAPABILITIES, describeJpeg, JPEG_SPECS, runContract, type CaseResult, type DecodedImage, type InfoValue } from './contract.ts';

async function decode(jpeg: Uint8Array): Promise<DecodedImage> {
  const bmp = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: d.width, height: d.height, channels: 4, data: d.data };
  } finally {
    bmp.close();
  }
}

async function fixtures(base: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const s of JPEG_SPECS) {
    const r = await fetch(`${base}/fixtures/${s.name}.jpg`);
    if (!r.ok) throw new Error(`fixture ${s.name}: HTTP ${r.status}`);
    out[s.name] = new Uint8Array(await r.arrayBuffer());
  }
  return out;
}

export async function run(base: string): Promise<CaseResult[]> {
  return runContract({ codec: new BrowserImageCodec(), capabilities: BROWSER_CAPABILITIES, decode, jpegFixtures: await fixtures(base) });
}

/** Observations about this browser's image primitives, for the report (not assertions). */
export async function probe(): Promise<Record<string, InfoValue>> {
  const r: Record<string, InfoValue> = {};
  // 1-px checkerboard, 256x128, so a box/bilinear filter lands near 128 and nearest-neighbour on 0/255.
  const src = new ImageData(256, 128);
  for (let i = 0; i < 256 * 128; i++) {
    const v = ((i % 256) + Math.floor(i / 256)) & 1 ? 255 : 0;
    src.data.set([v, v, v, 255], i * 4);
  }
  const deviation = async (q: ResizeQuality): Promise<number> => {
    const bmp = await createImageBitmap(src, { resizeWidth: 64, resizeHeight: 32, resizeQuality: q });
    r[`resize_${q}_size`] = `${bmp.width}x${bmp.height}`;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - 128);
    return Math.round((s / (d.length / 4)) * 10) / 10;
  };
  for (const q of ['pixelated', 'low', 'medium', 'high'] as ResizeQuality[]) r[`resize_${q}_meanAbsFrom128`] = await deviation(q);

  // What convertToBlob('image/jpeg') writes.
  const c = new OffscreenCanvas(64, 48);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 64, 48);
  g.addColorStop(0, '#c33');
  g.addColorStop(1, '#3c9');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 48);
  for (const q of [0.5, 0.92, 1]) {
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    const bytes = new Uint8Array(await b.arrayBuffer());
    r[`jpeg_q${q}_type`] = b.type;
    r[`jpeg_q${q}_bytes`] = bytes.length;
    for (const [k, v] of Object.entries(describeJpeg(bytes))) r[`jpeg_q${q}_${k}`] = v;
  }
  // Does convertToBlob honour an unsupported type? (BrowserImageCodec checks blob.type.)
  r.unknownType_fallback = (await c.convertToBlob({ type: 'image/x-unknown' })).type;
  return r;
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof document === 'undefined';

if (inWorker) {
  self.onmessage = async (e: MessageEvent<{ cmd: 'run' | 'probe'; base: string }>) => {
    try {
      const value = e.data.cmd === 'run' ? await run(e.data.base) : await probe();
      self.postMessage({ ok: true, value });
    } catch (err) {
      self.postMessage({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  };
} else {
  (globalThis as unknown as { __contract: unknown }).__contract = { run, probe };
}
