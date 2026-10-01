/**
 * End-to-end test of the website (site/): build it into a temporary directory, serve that with
 * the generated _headers applied (as Cloudflare Pages would), and check every page in headless
 * Chromium: it renders, loads nothing from other origins, logs no errors, is crossOriginIsolated
 * and has no horizontal scroll at phone width. The app compresses the fixture both to a
 * downloadable Blob and streamed to a file from showSaveFilePicker (stubbed with an OPFS file).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { buildSite, writeSite, type SiteFiles } from '../../site/build.ts';
import { FEATURES, loadBench, loadFeatures } from '../../site/src/bench.ts';
import { startSiteServer, type SiteServer } from '../../site/serve.ts';
import { buildFixturePdf } from './fixture.ts';
import { hasQpdf, launchChromium, qpdfCheck } from './harness.ts';

// The harness starts Chromium with ForceEagerMeasureMemory, so measureUserAgentSpecificMemory()
// answers right away instead of at the next GC.
const launch = await launchChromium('site test');
const browser = launch.browser;

let dir = '';
let inputPath = '';
let inputSize = 0;
let files: SiteFiles = new Map();
let server: SiteServer | undefined;
const url = (path: string): string => new URL(path, server!.url).href;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leanpdf-site-'));
  files = await buildSite();
  await writeSite(files, join(dir, 'dist'));
  server = await startSiteServer({ dist: join(dir, 'dist'), port: 0 });
  if (!browser) return;
  const pdf = await buildFixturePdf();
  inputPath = join(dir, 'fixture.pdf');
  inputSize = pdf.bytes.length;
  await writeFile(inputPath, pdf.bytes);
}, 60_000);

afterAll(async () => {
  await launch.close?.();
  await server?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 20_000);

describe('site build and server', () => {
  test('outputs every page, hashed assets, the worker and _headers', () => {
    const paths = [...files.keys()];
    for (const p of ['index.html', 'app/index.html', 'docs/index.html', 'benchmarks/index.html', '404.html', '_headers', 'favicon.svg']) expect(paths).toContain(p);
    for (const name of ['app', 'site', 'worker', 'styles']) expect(paths.some((p) => new RegExp(`^assets/${name}-[0-9a-f]{10}\\.(js|css)$`).test(p))).toBe(true);
  });

  test('serves _headers rules, Pages-style redirects and a 404 page', async () => {
    const app = await fetch(url('/app/'));
    expect(app.status).toBe(200);
    expect(app.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(app.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(app.headers.get('content-security-policy')).toContain("script-src 'self'");
    const asset = [...files.keys()].find((p) => p.startsWith('assets/worker-'))!;
    const res = await fetch(url(`/${asset}`));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toStartWith('text/javascript');
    const redirect = await fetch(url('/docs'), { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/docs/');
    const missing = await fetch(url('/no/such/page'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Page not found');
    expect((await fetch(url('/_headers'))).status).toBe(404);
    for (const r of [app, res, redirect, missing]) await r.body?.cancel().catch(() => {});
  });
});

interface Watch {
  errors: string[];
  foreign: string[];
}

/** Collect console errors, page errors, failed requests and requests to other origins. */
function watch(page: Page): Watch {
  const w: Watch = { errors: [], foreign: [] };
  const origin = new URL(server!.url).origin;
  page.on('pageerror', (e) => w.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') w.errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => w.errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) w.errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin && !['blob:', 'data:'].includes(u.protocol)) w.foreign.push(r.url());
  });
  return w;
}

const noHorizontalScroll = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

describe.skipIf(!browser)('site pages', () => {
  const PAGES = ['/', '/app/', '/docs/', '/benchmarks/', '/404.html'];

  for (const width of [390, 360]) {
    test(`every page renders cleanly at ${width} px`, async () => {
      const context = await browser!.newContext({ viewport: { width, height: 800 } });
      for (const path of PAGES) {
        const page = await context.newPage();
        const w = watch(page);
        await page.goto(url(path), { waitUntil: 'load' });
        if (path === '/app/') await page.waitForSelector('#app[data-state="ready"]');
        expect(await page.locator('h1').count()).toBe(1);
        expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
        expect({ path, overflow: !(await noHorizontalScroll(page)) }).toEqual({ path, overflow: false });
        expect(w.foreign).toEqual([]);
        expect(w.errors).toEqual([]);
        await page.close();
      }
      await context.close();
    }, 45_000);
  }

  test('home page', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    const w = watch(page);
    await page.goto(url('/'));
    expect(await page.textContent('h1')).toContain('Lean PDFs');
    expect(await page.textContent('#install-cmd')).toBe('npm install leanpdf');
    expect(await page.locator('a[href="https://github.com/alineacms/leanpdf"]').count()).toBeGreaterThan(0);
    expect(await page.locator('a[href="https://www.npmjs.com/package/leanpdf"]').count()).toBeGreaterThan(0);
    expect(await page.locator('a.button.primary[href="/app/"]').count()).toBe(1);
    expect(await page.locator('.stat').count()).toBe(loadBench() ? 3 : 2);
    expect(await page.textContent('.stats')).toMatch(/[\d.]+KB gzipped/);
    // Copy buttons come from the enhancement script.
    expect(await page.locator('.code .copy').count()).toBe(2);
    expect(w.errors).toEqual([]);
    await page.close();
  });

  test('docs page has the README sections and a working table of contents', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    const w = watch(page);
    await page.goto(url('/docs/'));
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const h2 = await page.locator('.prose h2').allTextContents();
    // Every section but Benchmarks, which the site has a page for (links to it lead there).
    for (const [, title] of readme.matchAll(/^## (.+)$/gm)) if (title !== 'Benchmarks') expect(h2).toContain(title.replace(/`/g, ''));
    expect(h2).not.toContain('Benchmarks');
    expect(await page.locator('.prose a[href="/benchmarks/"]').count()).toBeGreaterThan(0);
    expect(h2[0]).toBe('Overview');
    expect(await page.locator('#compresspdfinput-output-options-promisecompressreport').count()).toBe(1);
    // Every table-of-contents link points at a heading on the page.
    const targets = await page.locator('.toc a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).hash.slice(1)));
    expect(targets.length).toBeGreaterThan(10);
    for (const id of targets) expect(await page.locator(`[id="${id}"]`).count()).toBe(1);
    expect(await page.locator('.prose table').count()).toBeGreaterThan(3);
    expect(await page.locator('.prose pre code .tok-k').count()).toBeGreaterThan(0);
    await page.click('.toc a[href="#known-limitations"]');
    await page.waitForFunction(() => document.querySelector('.toc a[aria-current="true"]')?.getAttribute('href') === '#known-limitations');
    expect(w.errors).toEqual([]);
    await page.close();
  });

  test('benchmarks page renders a table and three charts per file', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    const w = watch(page);
    await page.goto(url('/benchmarks/'));
    const data = loadBench();
    if (!data) {
      expect(await page.isVisible('#no-results')).toBe(true);
    } else {
      expect(await page.locator('.bench-file').count()).toBe(data.files.length);
      for (const file of data.files) {
        const section = page.locator('.bench-file', { has: page.locator(`h3:has-text("${file}")`) });
        const rows = data.rows.filter((r) => r.file === file).length;
        expect(await section.locator('table.bench-table tbody tr').count()).toBe(rows);
        expect(await section.locator('svg[role="img"]').count()).toBe(3);
        // Every chart has a bar (or a status) per tool; the output-size chart also the original.
        const bars = await section.locator('svg').evaluateAll((svgs) => svgs.map((s) => s.querySelectorAll('g').length));
        expect(bars).toEqual([rows + 1, rows, rows]);
      }
    }
    // One section per other feature, each with charts and a table.
    const features = loadFeatures();
    const shown = FEATURES.filter((f) => features?.some((r) => r.feature === f.id));
    for (const f of shown) {
      const section = page.locator(`section[aria-labelledby="feature-${f.id}"]`);
      expect(await section.locator('svg[role="img"]').count()).toBeGreaterThan(0);
      expect(await section.locator('table.bench-table tbody tr').count()).toBeGreaterThan(0);
    }
    expect(await page.locator('.bench-nav a').count()).toBe(shown.length ? shown.length + 1 : 0);
    expect(await page.textContent('#methodology')).toBe('Methodology');
    expect(w.errors).toEqual([]);
    await page.close();
  });
});

async function openApp(context: BrowserContext): Promise<{ page: Page; w: Watch }> {
  const page = await context.newPage();
  const w = watch(page);
  await page.goto(url('/app/'));
  await page.waitForSelector('#app[data-state="ready"]');
  await page.setInputFiles('#compress-file', inputPath);
  await page.fill('#compress-max-width', '1200');
  await page.fill('#compress-max-height', '1200');
  return { page, w };
}

describe.skipIf(!browser)('app', () => {
  test('is crossOriginIsolated and compresses to a downloadable Blob', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const { page, w } = await openApp(context);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.getAttribute('#memory-table tbody th', 'data-method')).toBe('performance.measureUserAgentSpecificMemory()');
    expect(await page.getAttribute('#tab-compress', 'aria-selected')).toBe('true');
    expect(await page.isEnabled('#compress-start')).toBe(true);

    await page.click('#compress-start');
    await page.waitForSelector('#compress-report', { state: 'visible', timeout: 30_000 });
    expect(await page.isVisible('#compress-error')).toBe(false);
    expect(await page.textContent('#compress-progress-text')).toStartWith('100%');
    expect(await page.textContent('#compress-r-recompressed')).toBe('3');
    expect(await page.textContent('#compress-r-skipped')).toContain('below the size threshold');
    expect(await page.textContent('#compress-saved-pct')).toMatch(/^−\d+\.\d%$/);
    // Peak memory was sampled during the run by at least one meter.
    await page.waitForFunction(() => /: [\d.]+ (KB|MB)/.test(document.getElementById('compress-r-memory')?.textContent ?? ''), undefined, { timeout: 15_000 });

    const outBytes = Number(await page.getAttribute('#compress-report', 'data-output-bytes'));
    const href = (await page.getAttribute('#compress-download', 'href'))!;
    expect(href).toStartWith('blob:');
    const blobSize = await page.evaluate(async (u) => (await (await fetch(u)).blob()).size, href);
    expect(blobSize).toBe(outBytes);
    expect(blobSize).toBeLessThan(inputSize);
    expect(blobSize).toBeGreaterThan(1000);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#compress-download')]);
    expect(download.suggestedFilename()).toBe('fixture-compressed.pdf');
    const saved = join(dir, 'download.pdf');
    await download.saveAs(saved);
    expect(Bun.file(saved).size).toBe(blobSize);
    if (hasQpdf) expect(qpdfCheck(saved).code).toBe(0);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(w.foreign).toEqual([]);
    expect(w.errors).toEqual([]);
    await context.close();
  }, 45_000);

  test('streams to the file picked with showSaveFilePicker', async () => {
    const context = await browser!.newContext();
    // Headless Chromium cannot show the native picker; hand out an OPFS file handle instead.
    await context.addInitScript(() => {
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o?: { suggestedName?: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(o?.suggestedName ?? 'out.pdf', { create: true });
    });
    const { page, w } = await openApp(context);
    expect(await page.isVisible('#compress-save')).toBe(true);
    await page.click('#compress-save');
    await page.waitForSelector('#compress-report', { state: 'visible', timeout: 30_000 });
    expect(await page.isVisible('#compress-error')).toBe(false);
    expect(await page.isVisible('#compress-download')).toBe(false);
    expect(await page.textContent('#compress-saved-to')).toBe('Saved to fixture-compressed.pdf.');

    const outBytes = Number(await page.getAttribute('#compress-report', 'data-output-bytes'));
    const b64 = await page.evaluate(async () => {
      const f = await (await (await navigator.storage.getDirectory()).getFileHandle('fixture-compressed.pdf')).getFile();
      const u = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(f);
      });
      return u.slice(u.indexOf(',') + 1);
    });
    const bytes = Buffer.from(b64, 'base64');
    expect(bytes.length).toBe(outBytes);
    expect(bytes.length).toBeLessThan(inputSize);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const out = join(dir, 'streamed.pdf');
    await writeFile(out, bytes);
    if (hasQpdf) expect(qpdfCheck(out).code).toBe(0);
    expect(w.errors).toEqual([]);
    await context.close();
  }, 45_000);

  test('cancel stops a run, and a non-PDF gets a readable error', async () => {
    const context = await browser!.newContext();
    const { page, w } = await openApp(context);
    await page.click('#compress-start');
    await page.click('#compress-cancel');
    await page.waitForFunction(() => {
      const t = document.getElementById('compress-progress-text')?.textContent ?? '';
      return t === 'Cancelled.' || t.startsWith('100%'); // the fixture is small; it may win the race
    });
    expect(await page.isEnabled('#compress-start')).toBe(true);

    const junk = join(dir, 'junk.pdf');
    await writeFile(junk, 'this is not a PDF');
    await page.setInputFiles('#compress-file', junk);
    await page.click('#compress-start');
    await page.waitForSelector('#compress-error', { state: 'visible', timeout: 15_000 });
    expect(await page.textContent('#compress-error-text')).toContain('not a PDF');
    expect(w.errors).toEqual([]);
    await context.close();
  }, 45_000);
});

if (!browser) test.skip(`site browser tests (${launch.skip})`, () => {});
