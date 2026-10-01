/**
 * Render a directory of PDFs with leanpdf (in headless Chromium) and with MuPDF, and report how
 * they differ, what failed and what was slow. Not a test: a tool for finding rendering bugs.
 *
 *   bun test/browser/corpus.ts <dir> [--pages 2] [--scale 1] [--filter text] [--out report.jsonl] [--png dir]
 *
 * Writes one JSON line per page (and per file that failed to open), then a summary. With --png,
 * pages that differ structurally are written as <file>.<page>.{ours,mupdf}.png.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { Raster } from '../support/render.ts';
import { bundle, HTML, JS, launchBrowser } from './harness.ts';
import { compare } from './render-support.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const dir = args[0];
if (!dir) throw new Error('usage: bun test/browser/corpus.ts <dir> [--pages N] [--scale S] [--filter text] [--out file] [--png dir]');
const PAGES = Number(opt('pages', '2'));
const SCALE = Number(opt('scale', '1'));
const OUT = opt('out', 'corpus-report.jsonl');
const PNG = opt('png', '');
const TIMEOUT = 60_000;
const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.pdf') && f.includes(opt('filter', '')))
  .sort();
writeFileSync(OUT, '');
if (PNG) mkdirSync(PNG, { recursive: true });

// MuPDF in a worker, restarted when a file hangs it.
let worker!: Worker;
let seq = 0;
const startWorker = () => (worker = new Worker(new URL('./corpus-mupdf.ts', import.meta.url).href));
startWorker();
function mupdf(pdf: Uint8Array): Promise<{ pageCount?: number; pages?: (Raster | null)[]; error?: string }> {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.terminate();
      startWorker();
      resolve({ error: 'timeout' });
    }, TIMEOUT);
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      clearTimeout(timer);
      resolve(e.data);
    };
    worker.postMessage({ id, pdf, pages: PAGES, dpi: 72 * SCALE });
  });
}

const js = await bundle(new URL('./corpus-entry.ts', import.meta.url).pathname);
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === '/') return new Response(HTML().body as string, { headers: { 'content-type': 'text/html' } });
    if (path === '/entry.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
    const file = Bun.file(join(dir, basename(path)));
    return file.size ? new Response(file) : new Response(null, { status: 404 });
  },
});
const launch = await launchBrowser('corpus');
if (!launch.browser) throw new Error(launch.skip);
const browser = launch.browser;
let page!: Awaited<ReturnType<typeof browser.newPage>>;
async function openPage() {
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.addScriptTag({ url: '/entry.js', type: 'module' });
  await page.waitForFunction(() => 'leanCorpus' in globalThis);
}
await openPage();

type Ours = { error?: string; count?: number; pages?: { error?: string; width: number; height: number; warnings: string[]; ms: number; rgba: string }[] };
async function ours(file: string): Promise<Ours> {
  const run = page.evaluate(([u, p, s, t]) => (globalThis as unknown as { leanCorpus: (...a: unknown[]) => Promise<Ours> }).leanCorpus(u, p, s, t), [`/${encodeURIComponent(file)}`, PAGES, SCALE, TIMEOUT] as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Ours>((r) => (timer = setTimeout(() => r({ error: 'timeout (hung)' }), TIMEOUT * PAGES + 10_000)));
  const r = await Promise.race([run.catch((e) => ({ error: `crash: ${e instanceof Error ? e.message.split('\n')[0] : e}` })), timeout]);
  clearTimeout(timer);
  if (r.error?.startsWith('timeout') || r.error?.startsWith('crash')) {
    await page.close().catch(() => {});
    await openPage();
  }
  return r;
}

const toRgb = (w: number, h: number, b64: string): Raster => {
  const rgba = Buffer.from(b64, 'base64');
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = rgba[i] * a + 255 * (1 - a);
    rgb[j + 1] = rgba[i + 1] * a + 255 * (1 - a);
    rgb[j + 2] = rgba[i + 2] * a + 255 * (1 - a);
  }
  return { width: w, height: h, rgb };
};
const png = (r: Raster, path: string) => sharp(Buffer.from(r.rgb), { raw: { width: r.width, height: r.height, channels: 3 } }).png().toFile(path);

interface Row {
  file: string;
  page?: number;
  mae?: number;
  bad?: number;
  ms?: number;
  size?: string;
  warnings?: string[];
  error?: string;
  mupdf?: string;
}
const rows: Row[] = [];
const emit = (r: Row) => {
  rows.push(r);
  appendFileSync(OUT, JSON.stringify(r) + '\n');
};

const t0 = Date.now();
for (const [i, file] of files.entries()) {
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const [a, b] = [await ours(file), await mupdf(bytes)];
  if (a.error || !a.pages) {
    emit({ file, error: a.error, mupdf: b.error });
    continue;
  }
  for (const [p, o] of a.pages.entries()) {
    const ref = b.pages?.[p];
    if (o.error) {
      emit({ file, page: p, error: o.error, ms: Math.round(o.ms), mupdf: b.error ?? (ref ? undefined : 'no page') });
      continue;
    }
    const mine = toRgb(o.width, o.height, o.rgba);
    const row: Row = { file, page: p, ms: Math.round(o.ms), warnings: o.warnings.length ? o.warnings : undefined };
    if (!ref) row.mupdf = b.error ?? 'no page';
    else {
      const d = compare(mine, ref);
      row.mae = +d.mae.toFixed(2);
      row.bad = +(d.bad * 100).toFixed(2);
      if (Math.abs(mine.width - ref.width) > 1 || Math.abs(mine.height - ref.height) > 1) row.size = `${mine.width}x${mine.height} vs ${ref.width}x${ref.height}`;
      if (PNG && (row.bad > 2 || row.size)) {
        await png(mine, join(PNG, `${file}.${p}.ours.png`));
        await png(ref, join(PNG, `${file}.${p}.mupdf.png`));
      }
    }
    emit(row);
  }
  if ((i + 1) % 25 === 0) console.log(`${i + 1}/${files.length} files, ${Math.round((Date.now() - t0) / 1000)}s`);
}

// Summary.
const pages = rows.filter((r) => r.page !== undefined && !r.error && r.bad !== undefined);
const bands = { same: pages.filter((r) => r.bad! < 0.5).length, close: pages.filter((r) => r.bad! >= 0.5 && r.bad! < 2).length, off: pages.filter((r) => r.bad! >= 2 && r.bad! < 10).length, wrong: pages.filter((r) => r.bad! >= 10).length };
console.log(`\n${files.length} files, ${pages.length} pages compared in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`differing pixels: <0.5% ${bands.same}, 0.5-2% ${bands.close}, 2-10% ${bands.off}, >=10% ${bands.wrong}`);
const failures = rows.filter((r) => r.error);
console.log(`leanpdf errors: ${failures.length} (MuPDF also failed on ${failures.filter((r) => r.mupdf).length})`);
for (const r of failures) console.log(`  ${r.file}${r.page !== undefined ? ` p${r.page}` : ''}: ${r.error}${r.mupdf ? ` [mupdf: ${r.mupdf}]` : ''}`);
const warn = new Map<string, number>();
for (const r of rows) for (const w of r.warnings ?? []) warn.set(w, (warn.get(w) ?? 0) + 1);
console.log('warnings:');
for (const [w, n] of [...warn].sort((x, y) => y[1] - x[1])) console.log(`  ${n} x ${w}`);
console.log('most different pages:');
for (const r of [...pages].sort((x, y) => y.bad! - x.bad!).slice(0, 60)) console.log(`  ${r.bad!.toFixed(1).padStart(5)}% mae ${r.mae!.toFixed(1).padStart(5)}  ${r.file} p${r.page}${r.size ? ` size ${r.size}` : ''}${r.warnings ? ` (${r.warnings.join('; ')})` : ''}`);
console.log('slowest pages:');
for (const r of rows.filter((r) => r.ms).sort((x, y) => y.ms! - x.ms!).slice(0, 15)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.file} p${r.page}`);
worker.terminate();
await page.close();
await launch.close?.();
server.stop(true);
process.exit(0);
