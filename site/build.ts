/**
 * Build the static site into site/dist (or --out <dir>):
 *
 *   bun run site:build
 *
 * Output: one HTML file per page (index.html, the app; app/, a redirect to it; docs/, benchmarks/, 404.html), a
 * content-hashed CSS file and one script per page type in assets/, the worker bundle as its
 * own file, icons, an Open Graph image, the sample PDF, and Cloudflare Pages' _headers.
 *
 * Inputs: site/src, README.md (docs page), bench/results.json and bench/corpus.ts (benchmarks
 * page) and src/ (the library, bundled into the worker). buildSite() is also used in memory by
 * the dev server (site/serve.ts) and by the tests.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadBench, loadFeatures } from './src/bench.ts';
import { ROOT } from './src/config.ts';
import { HEADERS_FILE } from './src/headers.ts';
import { appPage } from './src/pages/app.ts';
import { benchmarksPage } from './src/pages/benchmarks.ts';
import { docsPage } from './src/pages/docs.ts';
import { homePage, type BundleSize } from './src/pages/home.ts';
import type { Assets } from './src/pages/layout.ts';
import { notFoundPage } from './src/pages/not-found.ts';

const here = (p: string): string => new URL(p, import.meta.url).pathname;

export interface BuildOptions {
  /** Development build: not minified, inline source maps. */
  dev?: boolean;
}

/** Output files by path relative to the site root (no leading slash). */
export type SiteFiles = Map<string, Uint8Array>;

const enc = new TextEncoder();

async function bundle(entry: string, opts: BuildOptions, define: Record<string, string> = {}): Promise<string> {
  const r = await Bun.build({
    entrypoints: [here(entry)],
    target: 'browser',
    format: 'esm',
    minify: !opts.dev,
    sourcemap: opts.dev ? 'inline' : 'none',
    define,
  });
  if (!r.success) throw new AggregateError(r.logs, `bundling ${entry} failed:\n${r.logs.map(String).join('\n')}`);
  const js = r.outputs.find((o) => o.kind === 'entry-point');
  if (!js) throw new Error(`bundling ${entry} produced no entry point`);
  return js.text();
}

async function bundleCss(entry: string, opts: BuildOptions): Promise<string> {
  const r = await Bun.build({ entrypoints: [here(entry)], minify: !opts.dev });
  if (!r.success) throw new AggregateError(r.logs, `bundling ${entry} failed`);
  return r.outputs[0].text();
}

const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex').slice(0, 10);

/**
 * Browser bundle sizes, measured like scripts/size.ts does: compressPdfBlob alone (what an app
 * that only compresses ships) and the whole library.
 */
async function librarySize(): Promise<BundleSize | null> {
  // Entries outside node_modules: Bun treats entries there as dependency files.
  const dir = join(tmpdir(), 'leanpdf-site-size');
  await mkdir(dir, { recursive: true });
  const measure = async (name: string, source: string): Promise<{ min: number; gzip: number } | null> => {
    const entry = join(dir, `${name}.ts`);
    await writeFile(entry, source);
    const r = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: true });
    if (!r.success) return null;
    const code = new Uint8Array(await r.outputs[0].arrayBuffer());
    return { min: code.byteLength, gzip: Bun.gzipSync(code).byteLength };
  };
  const lib = `${ROOT}src/index.ts`;
  const [compress, all] = await Promise.all([measure('compress', `export { compressPdfBlob } from '${lib}';\n`), measure('all', `export * from '${lib}';\n`)]);
  return compress && all ? { ...compress, all } : null;
}

function ogSvg(logo: string): string {
  const mark = logo.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const font = 'DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset="1" stop-color="#15264d"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <g transform="translate(96 150) scale(5.5)">${mark}</g>
  <text x="310" y="245" font-family="${font}" font-size="96" font-weight="700" fill="#ffffff">leanpdf</text>
  <text x="312" y="315" font-family="${font}" font-size="36" fill="#c5ccd8">Small, low-memory, streaming PDF toolkit</text>
  <text x="312" y="365" font-family="${font}" font-size="36" fill="#c5ccd8">for browsers, Node and Bun</text>
  <text x="96" y="530" font-family="${font}" font-size="30" fill="#80a8ff">Compress, read, edit, merge, decrypt. In one pass.</text>
</svg>`;
}

/** PNG icons and the Open Graph image, rendered with sharp (a dev dependency). */
async function renderPngs(logo: string): Promise<Map<string, Uint8Array> | null> {
  try {
    const { default: sharp } = await import('sharp');
    const square = logo.replace(/rx="8"/, 'rx="0"'); // iOS rounds the corners itself
    const png = async (svg: string, size: number, h = size): Promise<Uint8Array> =>
      new Uint8Array(await sharp(Buffer.from(svg), { density: 72 * Math.ceil(Math.max(size, h) / 32) }).resize(size, h).png({ compressionLevel: 9 }).toBuffer());
    return new Map([
      ['favicon-32.png', await png(logo, 32)],
      ['apple-touch-icon.png', await png(square, 180)],
      ['og.png', new Uint8Array(await sharp(Buffer.from(ogSvg(logo))).png({ compressionLevel: 9 }).toBuffer())],
    ]);
  } catch (e) {
    console.warn(`site: skipping PNG icons and og:image (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

export async function buildSite(opts: BuildOptions = {}): Promise<SiteFiles> {
  const files: SiteFiles = new Map();
  const put = (path: string, body: string | Uint8Array): void => {
    files.set(path, typeof body === 'string' ? enc.encode(body) : body);
  };
  const hashed = (name: string, ext: string, body: string): string => {
    const path = `assets/${name}-${hash(body)}.${ext}`;
    put(path, body);
    return `/${path}`;
  };

  const worker = await bundle('./src/app/worker.ts', opts);
  const workerUrl = hashed('worker', 'js', worker);
  const [appJs, siteJs, css, bundleSize] = await Promise.all([
    bundle('./src/app/main.ts', opts, { __WORKER_URL__: JSON.stringify(workerUrl) }),
    bundle('./src/client/site.ts', opts),
    bundleCss('./src/static/styles.css', opts),
    librarySize(),
  ]);
  const logo = await readFile(here('./src/static/logo.svg'), 'utf8');
  put('favicon.svg', logo);
  // The document the front page offers to try (generated by site/sample.ts).
  put('sample.pdf', new Uint8Array(await readFile(here('./src/static/sample.pdf'))));
  const pngs = await renderPngs(logo);
  for (const [p, b] of pngs ?? []) put(p, b);

  const assets: Assets = {
    css: hashed('styles', 'css', css),
    siteJs: hashed('site', 'js', siteJs),
    appJs: hashed('app', 'js', appJs),
    png: pngs !== null,
  };
  const bench = loadBench();
  put('index.html', homePage(assets, bench, bundleSize));
  put('app/index.html', appPage(assets));
  put('docs/index.html', docsPage(assets));
  put('benchmarks/index.html', benchmarksPage(assets, bench, loadFeatures()));
  put('404.html', notFoundPage(assets));
  put('_headers', HEADERS_FILE);
  return files;
}

export async function writeSite(files: SiteFiles, outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  for (const [path, body] of files) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

/** A plain-text table of output files with raw and gzipped sizes. */
export function sizeReport(files: SiteFiles): string {
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
  const rows = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, b]) => [p, kb(b.byteLength), /\.(png)$/.test(p) ? '' : kb(gzipSync(b).byteLength)]);
  const w = Math.max(...rows.map((r) => r[0].length));
  const total = [...files.values()].reduce((n, b) => n + b.byteLength, 0);
  return [...rows.map(([p, s, g]) => `${p.padEnd(w)}  ${s.padStart(9)}  ${g ? `${g.padStart(9)} gz` : ''}`), `${'total'.padEnd(w)}  ${kb(total).padStart(9)}`].join('\n');
}

if (import.meta.main) {
  const i = process.argv.indexOf('--out');
  const outDir = i > 0 ? process.argv[i + 1] : here('./dist');
  const t0 = performance.now();
  const files = await buildSite({ dev: process.argv.includes('--dev') });
  await writeSite(files, outDir);
  console.log(sizeReport(files));
  console.log(`\nwrote ${files.size} files to ${outDir} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
