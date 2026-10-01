/**
 * The front page's viewer and toolbox other than Compress (site.test.ts covers that one):
 * the document view, Document, Text, Pages & cleanup and Merge, and opening encrypted files,
 * driven in a headless browser against the built site, with their outputs checked by the library.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { buildSite, writeSite } from '../../site/build.ts';
import { startSiteServer, type SiteServer } from '../../site/serve.ts';
import { extractText, getInfo, getPages, openPdf } from '../../src/index.ts';
import { DocBuilder, drawText } from '../support/pdfgen.ts';
import { buildDocFixture, buildFixturePdf } from './fixture.ts';
import { hasQpdf, launchBrowser, qpdfCheck } from './harness.ts';

const launch = await launchBrowser('app tools test');
const browser = launch.browser;

let dir = '';
let docPath = '';
let imagesPath = '';
let longPath = '';
let encPath = '';
let openEncPath = '';
let server: SiteServer | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leanpdf-tools-'));
  await writeSite(await buildSite(), join(dir, 'dist'));
  server = await startSiteServer({ dist: join(dir, 'dist'), port: 0 });
  docPath = join(dir, 'doc.pdf');
  await writeFile(docPath, buildDocFixture());
  imagesPath = join(dir, 'fixture.pdf');
  await writeFile(imagesPath, (await buildFixturePdf()).bytes);
  // 60 pages, to see that only the pages near the view are rendered.
  const long = new DocBuilder();
  for (let i = 0; i < 60; i++) long.page({ content: drawText(`Page ${i + 1}`, 72, 760, 24) });
  longPath = join(dir, 'long.pdf');
  await writeFile(longPath, long.finish().build().bytes);
  if (hasQpdf) {
    encPath = join(dir, 'locked.pdf');
    openEncPath = join(dir, 'restricted.pdf');
    for (const [user, out] of [['user-pw', encPath], ['', openEncPath]]) {
      const r = spawnSync('qpdf', ['--encrypt', user, 'owner-pw', '256', '--', docPath, out]);
      if (r.status !== 0) throw new Error(`qpdf --encrypt failed: ${r.stderr}`);
    }
  }
}, 60_000);

afterAll(async () => {
  await launch.close?.();
  await server?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 20_000);

/** The front page with `path` opened, and `tool`'s section expanded. */
async function openDoc(path: string, tool?: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(server!.url);
  await page.waitForSelector('#app[data-state="ready"]');
  await page.setInputFiles('#open-file', path);
  await page.waitForSelector('#workspace', { state: 'visible' });
  if (tool && (await page.getAttribute(`#tool-${tool}`, 'open')) === null) await page.click(`#tool-${tool} > summary`);
  return { page, errors };
}

/** The bytes behind a blob: link on the page. */
async function linkBytes(page: Page, selector: string): Promise<Uint8Array> {
  const href = (await page.getAttribute(selector, 'href'))!;
  expect(href).toStartWith('blob:');
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, href);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function pageTexts(data: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  for await (const p of extractText(await openPdf(data))) out.push(p.text);
  return out;
}

async function checkValid(data: Uint8Array, name: string): Promise<void> {
  if (!hasQpdf) return;
  const path = join(dir, name);
  await writeFile(path, data);
  expect(qpdfCheck(path).code).toBe(0);
}

const rendered = (page: Page): Promise<number[]> =>
  page.locator('.page:has(canvas)').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.page)));

describe.skipIf(!browser)('app tools', () => {
  test('the viewer lays out every page, renders those near the view, zooms and follows the scroll', async () => {
    const { page, errors } = await openDoc(longPath);
    await page.waitForSelector('.page canvas', { timeout: 15_000 });
    expect(await page.locator('.page').count()).toBe(60);
    expect(await page.textContent('#view-count')).toBe('60');
    await page.waitForTimeout(500);
    // Only pages around the view, not all 60.
    const first = await rendered(page);
    expect(first).toContain(0);
    expect(first.length).toBeLessThan(15);
    // Jumping to a page renders it and drops the ones far behind.
    await page.fill('#view-page', '50');
    await page.press('#view-page', 'Enter');
    await page.waitForFunction(() => document.querySelector('.page[data-page="49"] canvas'), undefined, { timeout: 15_000 });
    await page.waitForTimeout(500);
    const later = await rendered(page);
    expect(later).toContain(49);
    expect(later).not.toContain(0);
    expect(await page.inputValue('#view-page')).toBe('50');
    // Zooming resizes the pages; Fit puts them back.
    const width = () => page.locator('.page').first().evaluate((e) => (e as HTMLElement).getBoundingClientRect().width);
    const fit = await width();
    await page.click('#zoom-in');
    expect(await page.textContent('#zoom-fit')).toMatch(/%$/);
    expect(await width()).not.toBe(fit);
    await page.click('#zoom-fit');
    expect(await width()).toBe(fit);
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test('Document shows metadata and every section; bookmarks go to their page; attachments and images save', async () => {
    const { page, errors } = await openDoc(docPath, 'inspect');
    await page.waitForSelector('#inspect-document', { state: 'visible', timeout: 15_000 });
    const facts = await page.textContent('#inspect-facts');
    expect(facts).toContain('Quarterly invoices');
    expect(facts).toContain('Accounts');
    expect(facts).toContain('en-GB');
    const tags = await page.locator('#inspect-tags .tag').allTextContents();
    expect(tags[0]).toStartWith('PDF ');
    expect(tags.slice(1)).toEqual(['Form', 'JavaScript', '1 attachment']);
    expect(await page.textContent('#inspect-pages')).toContain('A4 portrait');
    expect(await page.textContent('#inspect-pages')).toContain('rotated 90°');
    const outline = await page.textContent('#inspect-outline');
    expect(outline).toContain('Introduction');
    expect(outline).toContain('p. 3');
    expect(await page.textContent('#inspect-fields')).toContain('Ada Lovelace');
    expect(await page.textContent('#inspect-links')).toContain('https://example.com/terms');
    expect(await page.textContent('#inspect-images-heading')).toBe('Images (0)');
    expect(await page.isVisible('#inspect-unlocked')).toBe(false);

    await page.click('#inspect-outline button:has-text("Summary")');
    await page.waitForFunction(() => (document.getElementById('view-page') as HTMLInputElement).value === '3', undefined, { timeout: 5_000 });

    await page.click('#inspect-attachments > summary');
    const [att] = await Promise.all([page.waitForEvent('download'), page.click('#inspect-attachments button')]);
    expect(att.suggestedFilename()).toBe('notes.txt');
    const attPath = join(dir, 'notes.txt');
    await att.saveAs(attPath);
    expect(await readFile(attPath, 'utf8')).toBe('hello world\n');

    // Images: JPEG as stored, Flate as PNG.
    await page.setInputFiles('#open-another', imagesPath);
    await page.waitForFunction(() => document.getElementById('inspect-images-heading')?.textContent === 'Images (4)', undefined, { timeout: 15_000 });
    await page.click('#inspect-images > summary');
    const [jpg] = await Promise.all([page.waitForEvent('download'), page.click('button[aria-label="Save image 4"]')]);
    expect(jpg.suggestedFilename()).toBe('fixture-image-4.jpg');
    const [png] = await Promise.all([page.waitForEvent('download'), page.click('button[aria-label="Save image 10"]')]);
    expect(png.suggestedFilename()).toBe('fixture-image-10.png');
    const pngPath = join(dir, 'image.png');
    await png.saveAs(pngPath);
    expect([...(await readFile(pngPath)).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(await page.isVisible('#inspect-error')).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test('Text extracts chosen pages, finds words (a match shows its page) and offers a .txt', async () => {
    const { page, errors } = await openDoc(docPath, 'text');
    await page.waitForFunction(() => document.getElementById('text-pages-note')?.textContent === 'All 3 pages.');
    await page.fill('#text-pages', '2-1');
    expect(await page.textContent('#text-pages-note')).toBe('2 pages of 3.');
    await page.click('#text-start');
    await page.waitForSelector('#text-report', { state: 'visible', timeout: 15_000 });
    const text = await page.inputValue('#text-output');
    expect(text).toBe('--- Page 1 ---\nAlpha page one about invoices\n\n--- Page 2 ---\nBeta page two mentions invoices again');
    await page.fill('#text-find', 'INVOICES');
    expect(await page.textContent('#text-find-note')).toBe('2 matches on 2 pages.');
    expect(await page.locator('#text-hits mark').count()).toBe(2);
    await page.click('#text-hits li[data-page="1"]');
    await page.waitForFunction(() => (document.getElementById('view-page') as HTMLInputElement).value === '2', undefined, { timeout: 5_000 });
    expect(await page.getAttribute('#text-download', 'download')).toBe('doc.txt');
    expect(new TextDecoder().decode(await linkBytes(page, '#text-download'))).toBe(text);
    // A page that doesn't exist is caught before anything runs.
    await page.fill('#text-pages', '4');
    expect(await page.textContent('#text-pages-note')).toBe('There is no page 4: pages are 1 to 3.');
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test('Pages & cleanup keeps, reorders and rotates pages and strips what was asked', async () => {
    const { page, errors } = await openDoc(docPath, 'edit');
    await page.waitForFunction(() => document.getElementById('edit-keep-note')?.textContent === 'All 3 pages.');
    await page.fill('#edit-keep', '1,1');
    expect(await page.textContent('#edit-keep-note')).toBe('Page 1 is listed twice; each page can be kept once.');
    await page.fill('#edit-keep', '3, 1');
    expect(await page.textContent('#edit-keep-note')).toBe('2 pages, 1 removed.');
    expect(await page.isDisabled('#edit-rotate-pages')).toBe(true);
    await page.selectOption('#edit-rotate', '90');
    await page.fill('#edit-rotate-pages', '1');
    for (const id of ['stripMetadata', 'removeJavaScript', 'removeAttachments']) await page.check(`#edit-${id}`);
    await page.click('#edit-start');
    await page.waitForSelector('#edit-report', { state: 'visible', timeout: 15_000 });
    expect(await page.textContent('#edit-facts [data-fact="pages"] td')).toBe('2 of 3');
    expect(await page.getAttribute('#edit-download', 'download')).toBe('doc-edited.pdf');
    const out = await linkBytes(page, '#edit-download');
    await checkValid(out, 'edited.pdf');
    expect(await pageTexts(out)).toEqual(['Gamma page three', 'Alpha page one about invoices']);
    const doc = await openPdf(out);
    expect((await getPages(doc)).map((p) => p.rotate)).toEqual([0, 90]);
    const info = await getInfo(doc);
    expect(info.title).toBeUndefined();
    expect(info.hasJavaScript).toBe(false);
    expect(info.attachments).toBe(0);
    // The result opens in the viewer.
    await page.click('#edit-view');
    await page.waitForFunction(() => document.getElementById('view-count')?.textContent === '2', undefined, { timeout: 15_000 });
    expect(await page.textContent('#doc-name')).toBe('doc-edited.pdf');
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test('Merge adds files before or after the open one, with page selections', async () => {
    const { page, errors } = await openDoc(docPath, 'merge');
    await page.waitForFunction(() => document.querySelectorAll('#merge-list li').length === 1);
    await page.setInputFiles('#merge-file', imagesPath);
    await page.waitForFunction(() => document.getElementById('merge-total')?.textContent?.includes('the result has 5 pages'), undefined, { timeout: 15_000 });
    // Take only page 2 of doc.pdf, then put fixture.pdf first.
    await page.fill('#merge-list li:nth-child(1) input', '2');
    await page.click('#merge-list li:nth-child(2) [data-action="up"]');
    expect(await page.locator('#merge-list .name').evaluateAll((els) => els.map((e) => e.firstChild?.textContent))).toEqual(['fixture.pdf', 'doc.pdf (open)']);
    expect(await page.textContent('#merge-total')).toContain('the result has 3 pages');
    await page.click('#merge-start');
    await page.waitForSelector('#merge-report', { state: 'visible', timeout: 30_000 });
    expect(await page.textContent('#merge-facts [data-fact="pages"] td')).toBe('3');
    const out = await linkBytes(page, '#merge-download');
    await checkValid(out, 'merged.pdf');
    expect(await pageTexts(out)).toEqual(['', '', 'Beta page two mentions invoices again']);
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);

  test.skipIf(!hasQpdf)('a PDF that needs a password asks for it; one that does not opens decrypted', async () => {
    const { page, errors } = await openDoc(encPath, 'inspect');
    await page.waitForSelector('#doc-password', { timeout: 15_000 });
    await page.fill('#doc-password', 'wrong');
    await page.click('#doc-password-submit');
    await page.waitForFunction(() => document.getElementById('doc-password-error')?.textContent?.includes('not correct'), undefined, { timeout: 15_000 });
    await page.fill('#doc-password', 'owner-pw');
    await page.click('#doc-password-submit');
    await page.waitForSelector('.page canvas', { timeout: 15_000 });
    await page.waitForSelector('#inspect-unlocked', { state: 'visible' });
    expect(await page.textContent('#inspect-unlocked')).toContain('AES-256 (R6)');
    expect(await page.textContent('#inspect-unlocked')).toContain('owner password');
    const out = await linkBytes(page, '#inspect-unlocked-download');
    await checkValid(out, 'unlocked.pdf');
    expect((await getInfo(await openPdf(out))).encrypted).toBe(false);
    expect(await pageTexts(out)).toEqual(['Alpha page one about invoices', 'Beta page two mentions invoices again', 'Gamma page three']);

    // Encrypted without a user password: opened straight away, the tools work on the decrypted copy.
    await page.setInputFiles('#open-another', openEncPath);
    await page.waitForSelector('.page canvas', { timeout: 15_000 });
    await page.waitForSelector('#inspect-unlocked', { state: 'visible' });
    await page.click('#tool-text > summary');
    await page.click('#text-start');
    await page.waitForSelector('#text-report', { state: 'visible', timeout: 15_000 });
    expect(await page.inputValue('#text-output')).toContain('Gamma page three');
    expect(errors).toEqual([]);
    await page.close();
  }, 45_000);
});

if (!browser) test.skip(`app tools browser tests (${launch.skip})`, () => {});
