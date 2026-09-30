/**
 * Smoke test for the demo page (demo/): start demo/serve.ts, upload a fixture, wait for the
 * report and check the result, both as a download and streamed to a file handle (the
 * showSaveFilePicker path, with the picker stubbed to return an OPFS file).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { startDemoServer, type DemoServer } from '../../demo/serve.ts';
import { buildFixturePdf } from './fixture.ts';
import { hasQpdf, launchChromium, qpdfCheck } from './harness.ts';

// The harness starts Chromium with ForceEagerMeasureMemory, so measureUserAgentSpecificMemory()
// answers right away instead of at the next GC (~10-20 s).
const launch = await launchChromium('demo smoke test');
const browser = launch.browser;

let dir = '';
let inputPath = '';
let inputSize = 0;
let server: DemoServer | undefined;

beforeAll(async () => {
  if (!browser) return;
  dir = await mkdtemp(join(tmpdir(), 'pdfc-demo-'));
  const pdf = await buildFixturePdf();
  inputPath = join(dir, 'fixture.pdf');
  inputSize = pdf.bytes.length;
  await writeFile(inputPath, pdf.bytes);
  server = startDemoServer({ port: 0 });
}, 60_000);

afterAll(async () => {
  await launch.close?.();
  await server?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 20_000);

async function openDemo(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(server!.url);
  await page.setInputFiles('#file', inputPath);
  await page.fill('#max-width', '1200');
  await page.fill('#max-height', '1200');
  return errors;
}

describe.skipIf(!browser)('demo page', () => {
  test('is crossOriginIsolated and compresses to a downloadable Blob', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    const errors = await openDemo(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.getAttribute('#mem-rows th:first-child', 'title')).toBe('performance.measureUserAgentSpecificMemory()');
    // No horizontal scrolling at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.click('#compress');
    await page.waitForSelector('#report', { state: 'visible', timeout: 30_000 });
    expect(await page.isVisible('#error')).toBe(false);
    expect(await page.textContent('#progress-text')).toStartWith('100%');
    expect(await page.textContent('#r-recompressed')).toBe('3');
    expect(await page.textContent('#r-skipped')).toContain('below the size threshold');
    // Peak memory was sampled during the run.
    await page.waitForFunction(() => /^Page \+ worker: [\d.]+ (KB|MB)/.test(document.getElementById('r-memory')?.textContent ?? ''));

    const outBytes = Number(await page.getAttribute('#report', 'data-output-bytes'));
    const href = (await page.getAttribute('#download', 'href'))!;
    expect(href).toStartWith('blob:');
    const blobSize = await page.evaluate(async (u) => (await (await fetch(u)).blob()).size, href);
    expect(blobSize).toBe(outBytes);
    expect(blobSize).toBeLessThan(inputSize);
    expect(blobSize).toBeGreaterThan(1000);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(download.suggestedFilename()).toBe('fixture-compressed.pdf');
    const saved = join(dir, 'download.pdf');
    await download.saveAs(saved);
    expect(Bun.file(saved).size).toBe(blobSize);
    if (hasQpdf) expect(qpdfCheck(saved).code).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test('streams to the file picked with showSaveFilePicker', async () => {
    const context = await browser!.newContext();
    // Headless Chromium cannot show the native picker; hand out an OPFS file handle instead.
    await context.addInitScript(() => {
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o?: { suggestedName?: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(o?.suggestedName ?? 'out.pdf', { create: true });
    });
    const page = await context.newPage();
    const errors = await openDemo(page);
    await page.click('#save-to');
    await page.waitForFunction(() => document.getElementById('save-target')?.textContent?.includes('fixture-compressed.pdf'));
    await page.click('#compress');
    await page.waitForSelector('#report', { state: 'visible', timeout: 30_000 });
    expect(await page.isVisible('#error')).toBe(false);
    expect(await page.isVisible('#download')).toBe(false);
    expect(await page.textContent('#saved-to')).toBe('Saved to fixture-compressed.pdf.');

    const outBytes = Number(await page.getAttribute('#report', 'data-output-bytes'));
    const b64 = await page.evaluate(async () => {
      const f = await (await (await navigator.storage.getDirectory()).getFileHandle('fixture-compressed.pdf')).getFile();
      const url = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(f);
      });
      return url.slice(url.indexOf(',') + 1);
    });
    const bytes = Buffer.from(b64, 'base64');
    expect(bytes.length).toBe(outBytes);
    expect(bytes.length).toBeLessThan(inputSize);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const out = join(dir, 'streamed.pdf');
    await writeFile(out, bytes);
    if (hasQpdf) expect(qpdfCheck(out).code).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 45_000);
});

if (!browser) test.skip(`demo smoke test (${launch.skip})`, () => {});
