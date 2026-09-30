/**
 * Screenshots of the built site for review: builds into a temporary directory, serves it with
 * the _headers rules, and captures pages at desktop and phone width (light and dark) into
 * site/screenshots/. The app page is captured after compressing the browser test fixture.
 *
 *   bun site/screenshots.ts            (needs Chromium, see test/browser/harness.ts)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { buildFixturePdf } from '../test/browser/fixture.ts';
import { launchChromium } from '../test/browser/harness.ts';
import { buildSite, writeSite } from './build.ts';
import { startSiteServer } from './serve.ts';

const OUT = new URL('./screenshots/', import.meta.url).pathname;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const launch = await launchChromium('site screenshots');
if (!launch.browser) {
  console.error(launch.skip);
  process.exit(1);
}
const browser: Browser = launch.browser;
const dir = await mkdtemp(join(tmpdir(), 'leanpdf-site-'));
await writeSite(await buildSite(), join(dir, 'dist'));
const fixture = join(dir, 'fixture.pdf');
await writeFile(fixture, (await buildFixturePdf()).bytes);
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

async function compressFixture(page: Page): Promise<void> {
  await page.setInputFiles('#compress-file', fixture);
  await page.fill('#compress-max-width', '1200');
  await page.fill('#compress-max-height', '1200');
  await page.click('#compress-start');
  await page.waitForSelector('#compress-report', { state: 'visible', timeout: 60_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

try {
  for (const dark of [false, true]) {
    await shot('home-desktop', '/', DESKTOP, dark);
    await shot('app-desktop', '/app/', DESKTOP, dark, compressFixture);
  }
  await shot('home-mobile', '/', PHONE, false);
  await shot('app-mobile', '/app/', PHONE, false, compressFixture);
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
