/**
 * Screenshots of the built site for review: builds into a temporary directory, serves it with
 * the _headers rules, and captures pages at desktop and phone width (light and dark) into
 * site/screenshots/. The front page is captured empty, with the sample open, after compressing
 * the browser test fixture, and with each other tool run on the test documents.
 *
 *   bun site/screenshots.ts            (needs Chromium, see test/browser/harness.ts)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { buildDocFixture, buildFixturePdf } from '../test/browser/fixture.ts';
import { launchBrowser } from '../test/browser/harness.ts';
import { buildSite, writeSite } from './build.ts';
import { startSiteServer } from './serve.ts';

const OUT = new URL('./screenshots/', import.meta.url).pathname;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const launch = await launchBrowser('site screenshots');
if (!launch.browser) {
  console.error(launch.skip);
  process.exit(1);
}
const browser: Browser = launch.browser;
const dir = await mkdtemp(join(tmpdir(), 'leanpdf-site-'));
await writeSite(await buildSite(), join(dir, 'dist'));
const fixture = join(dir, 'fixture.pdf');
await writeFile(fixture, (await buildFixturePdf()).bytes);
const doc = join(dir, 'doc.pdf');
await writeFile(doc, buildDocFixture());
const server = await startSiteServer({ dist: join(dir, 'dist'), port: 0 });
await mkdir(OUT, { recursive: true });

async function shot(name: string, path: string, viewport: { width: number; height: number }, dark: boolean, prepare?: (p: Page) => Promise<void>, fullPage = true): Promise<void> {
  const context = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  const page = await context.newPage();
  await page.goto(new URL(path, server.url).href);
  await prepare?.(page);
  const file = `${OUT}${name}${dark ? '-dark' : ''}.png`;
  await page.screenshot({ path: file, fullPage });
  console.log(`wrote ${file}`);
  await context.close();
}

/** Open `file` on the front page and expand `tool`'s section. */
async function open(page: Page, file: string, tool: string): Promise<void> {
  await page.waitForSelector('#app[data-state="ready"]');
  await page.setInputFiles('#open-file', file);
  await page.waitForSelector('.page canvas', { timeout: 30_000 });
  if (await page.isVisible('#toolbox-toggle')) await page.click('#toolbox-toggle');
  if ((await page.getAttribute(`#tool-${tool}`, 'open')) === null) await page.click(`#tool-${tool} > summary`);
}

async function compressFixture(page: Page): Promise<void> {
  await open(page, fixture, 'compress');
  await page.fill('#compress-max-width', '1200');
  await page.fill('#compress-max-height', '1200');
  await page.click('#compress-start');
  await page.waitForSelector('#compress-report', { state: 'visible', timeout: 60_000 });
}

async function openSample(page: Page): Promise<void> {
  await page.waitForSelector('#app[data-state="ready"]');
  await page.click('#open-sample');
  await page.waitForSelector('.page canvas', { timeout: 30_000 });
  await page.waitForTimeout(500);
}

const TOOLS: [string, (p: Page) => Promise<void>][] = [
  ['inspect', async (p) => {
    await open(p, doc, 'inspect');
    await p.waitForSelector('#inspect-document:not([hidden])');
  }],
  ['text', async (p) => {
    await open(p, doc, 'text');
    await p.click('#text-start');
    await p.waitForSelector('#text-report', { state: 'visible' });
    await p.fill('#text-find', 'invoices');
  }],
  ['edit', async (p) => {
    await open(p, doc, 'edit');
    await p.fill('#edit-keep', '3, 1');
    await p.selectOption('#edit-rotate', '90');
    await p.check('#edit-stripMetadata');
    await p.click('#edit-start');
    await p.waitForSelector('#edit-report', { state: 'visible' });
  }],
  ['merge', async (p) => {
    await open(p, doc, 'merge');
    await p.setInputFiles('#merge-file', fixture);
    await p.waitForSelector('#merge-start:not([disabled])', { timeout: 30_000 });
    await p.fill('#merge-list li:nth-child(1) input', '2');
    await p.click('#merge-start');
    await p.waitForSelector('#merge-report', { state: 'visible', timeout: 60_000 });
  }],
];

try {
  for (const [tool, prepare] of TOOLS) {
    await shot(`app-${tool}-desktop`, '/', DESKTOP, false, async (p) => {
      await prepare(p);
      await p.mouse.move(0, 0);
    }, false);
  }
  for (const dark of [false, true]) {
    await shot('home-desktop', '/', DESKTOP, dark);
    await shot('app-desktop', '/', DESKTOP, dark, openSample, false);
    await shot('app-compress-desktop', '/', DESKTOP, dark, compressFixture, false);
  }
  await shot('home-mobile', '/', PHONE, false);
  await shot('app-mobile', '/', PHONE, false, openSample, false);
  await shot('app-compress-mobile', '/', PHONE, false, compressFixture, false);
  await shot('benchmarks-desktop', '/benchmarks/', DESKTOP, false);
  await shot('benchmarks-mobile', '/benchmarks/', PHONE, false);
  await shot('benchmarks-mobile', '/benchmarks/', PHONE, true, undefined, false);
  await shot('docs-desktop', '/docs/#api', DESKTOP, false, undefined, false);
  await shot('docs-mobile', '/docs/', PHONE, false, undefined, false);
} finally {
  await launch.close();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
