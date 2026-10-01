/**
 * End to end: a PDF with large images, compressed in headless Chromium by compressPdfBlob inside
 * a Web Worker, and in Bun by compressPdf + SharpImageCodec. Both outputs must pass
 * `qpdf --check` and meet the same structural expectations.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sniffJpeg } from '../../src/core/jpeg.ts';
import type { CompressReport, RewriteProgress } from '../../src/core/types.ts';
import { compressPdfFile } from '../../src/node.ts';
import { SharpImageCodec } from '../../src/sharp.ts';
import { buildFixturePdf, type FixturePdf } from './fixture.ts';
import {
  bundle,
  hasQpdf,
  HTML,
  JS,
  ENGINE_NAME,
  launchBrowser,
  qpdfCheck,
  qpdfImages,
  qpdfPageCount,
  qpdfRawStream,
  serveStatic,
  type StaticServer,
} from './harness.ts';

const OPTS = { maxWidth: 1600, maxHeight: 1600, jpegQuality: 0.75 };

const launch = await launchBrowser('browser e2e');
const browser = launch.browser;

let dir = '';
let fixture: FixturePdf;
let inputPath = '';
let server: StaticServer | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdfc-e2e-'));
  fixture = await buildFixturePdf();
  inputPath = join(dir, 'input.pdf');
  await writeFile(inputPath, fixture.bytes);
}, 60_000);

afterAll(async () => {
  await launch.close?.();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 20_000);

function checkReport(report: CompressReport): void {
  expect(report.inputBytes).toBe(fixture.bytes.length);
  expect(report.imagesSeen).toBe(fixture.images.length);
  expect(report.imagesRecompressed).toBe(fixture.images.filter((i) => i.recompressible).length);
  expect(report.imagesSkipped).toEqual({ small: 1 });
  expect(report.outputBytes).toBeGreaterThan(0);
  expect(report.outputBytes).toBeLessThan(report.inputBytes / 4);
  expect(report.signaturesInvalidated).toBe(false);
  expect(report.xrefRepaired).toBe(false);
  expect(report.warnings).toEqual([]);
}

/** Structural expectations shared by every output, whichever codec produced it. */
async function checkOutput(path: string, bytes: Uint8Array, grayStaysGray: boolean): Promise<void> {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 16)).trimEnd();
  expect(head).toStartWith('%PDF-1.');
  expect(tail).toEndWith('%%EOF');

  if (!hasQpdf) {
    console.warn('qpdf not found; skipping qpdf checks');
    return;
  }
  const check = qpdfCheck(path);
  expect(check.output).toContain('No syntax or stream encoding errors');
  expect(check.code).toBe(0);
  expect(qpdfPageCount(path)).toBe(fixture.pages);

  const images = qpdfImages(path);
  expect([...images.keys()].sort((a, b) => a - b)).toEqual(fixture.images.map((i) => i.num));
  for (const img of fixture.images) {
    const d = images.get(img.num)!;
    if (!img.recompressible) {
      expect(d['/Filter']).toBe(`/${img.filter}`);
      expect(d['/Width']).toBe(img.width);
      continue;
    }
    const w = d['/Width'] as number;
    const h = d['/Height'] as number;
    expect(d['/Filter']).toBe('/DCTDecode');
    expect(d['/DecodeParms']).toBeUndefined();
    expect(d['/BitsPerComponent']).toBe(8);
    expect(Math.max(w, h)).toBe(Math.min(1600, Math.max(img.width, img.height)));
    expect(Math.abs(h - (w * img.height) / img.width)).toBeLessThanOrEqual(1);

    const jpeg = qpdfRawStream(path, img.num);
    expect(d['/Length']).toBe(jpeg.length);
    const info = sniffJpeg(jpeg);
    expect(info).not.toBeNull();
    expect([info!.width, info!.height]).toEqual([w, h]);
    const gray = img.num === 9;
    const comps = gray && grayStaysGray ? 1 : 3;
    expect(info!.components).toBe(comps);
    expect(d['/ColorSpace']).toBe(comps === 1 ? '/DeviceGray' : '/DeviceRGB');
    const meta = await sharp(jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([w, h]);
  }
}

describe('end to end in Bun: compressPdf + SharpImageCodec', () => {
  let report: CompressReport;
  let outPath = '';

  test('input fixture is a valid PDF', () => {
    if (hasQpdf) expect(qpdfCheck(inputPath).code).toBe(0);
    expect(fixture.bytes.length).toBeGreaterThan(3_000_000);
  });

  test('compresses and passes qpdf --check', async () => {
    outPath = join(dir, 'out-sharp.pdf');
    report = await compressPdfFile(inputPath, outPath, { ...OPTS, codec: new SharpImageCodec() });
    checkReport(report);
    const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer());
    expect(bytes.length).toBe(report.outputBytes);
    await checkOutput(outPath, bytes, true);
  }, 60_000);
});

describe.skipIf(!browser)(`end to end in ${ENGINE_NAME}: compressPdfBlob in a Web Worker`, () => {
  type PageResult =
    | { ok: false; error: string }
    | { ok: true; report: CompressReport; events: RewriteProgress[]; ms: number; blobType: string; size: number };
  let r: PageResult;
  let outPath = '';
  let bytes: Uint8Array;

  beforeAll(async () => {
    server = serveStatic({
      '/': HTML(),
      '/e2e-worker.js': JS(await bundle(new URL('./e2e-worker.ts', import.meta.url).pathname)),
      '/input.pdf': { body: fixture.bytes, type: 'application/pdf' },
    });
    const page = await browser!.newPage();
    await page.goto(server.url);
    r = await page.evaluate(async (opts) => {
      const res = await fetch('/input.pdf');
      const file = new File([await res.blob()], 'input.pdf', { type: 'application/pdf' });
      const w = new Worker('/e2e-worker.js', { type: 'module' });
      type Msg = { ok: true; report: CompressReport; events: RewriteProgress[]; ms: number; blobType: string; buf: ArrayBuffer } | { ok: false; error: string };
      const msg = await new Promise<Msg>((resolve) => {
        w.onmessage = (e: MessageEvent<Msg>) => resolve(e.data);
        w.onerror = (e) => resolve({ ok: false, error: `worker error: ${e.message}` });
        w.postMessage({ file, opts });
      });
      w.terminate();
      if (!msg.ok) return msg;
      const size = msg.buf.byteLength;
      await fetch('/upload/out.pdf', { method: 'POST', body: msg.buf });
      return { ok: true as const, report: msg.report, events: msg.events, ms: msg.ms, blobType: msg.blobType, size };
    }, OPTS);
    await page.close();
    if (r.ok) {
      bytes = server.uploads.get('out.pdf')!;
      outPath = join(dir, 'out-browser.pdf');
      await writeFile(outPath, bytes);
    }
  }, 60_000);

  test('worker finished and transferred the output', () => {
    if (!r.ok) throw new Error(r.error);
    expect(r.blobType).toBe('application/pdf');
    expect(bytes).toBeDefined();
    expect(bytes.length).toBe(r.size);
    expect(bytes.length).toBe(r.report.outputBytes);
  });

  test('report is sane', () => {
    if (!r.ok) throw new Error(r.error);
    checkReport(r.report);
  });

  test('onProgress reports monotonic progress up to the end', () => {
    if (!r.ok) throw new Error(r.error);
    const ev = r.events;
    expect(ev.length).toBeGreaterThan(0);
    for (let i = 1; i < ev.length; i++) expect(ev[i].processedObjects).toBeGreaterThanOrEqual(ev[i - 1].processedObjects);
    const last = ev[ev.length - 1];
    expect(last.processedObjects).toBe(last.totalObjects);
    const saved = r.report.inputBytes - r.report.outputBytes;
    expect(Math.abs(last.bytesSaved - saved)).toBeLessThan(2_000);
  });

  test('output passes qpdf --check and structural checks', async () => {
    if (!r.ok) throw new Error(r.error);
    // Browsers always encode 3-component JPEGs (see BROWSER_CAPABILITIES in test/contract).
    await checkOutput(outPath, bytes, false);
  });
});

if (!browser) test.skip(`browser e2e (${launch.skip})`, () => {});
