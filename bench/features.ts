/**
 * Benchmark leanpdf's other features against the JavaScript libraries that offer them: reading
 * info and text, selecting and rotating pages, merging, decrypting, and rendering pages.
 *
 *   bun install --cwd bench && bun run build   # once
 *   bun bench/features.ts [--features text,merge] [--files report.pdf] [--tools leanpdf,mupdf]
 *
 * Like bench/run.ts, every tool runs in its own Node process, with CPU time and peak RSS from
 * the kernel; fast jobs run three times and the median run is kept. Written files are checked
 * with `qpdf --check` and their page count. Rendering runs in headless Chromium instead: every
 * page at 2x (144 dpi), timed until its pixels can be read, the first pages compared with MuPDF's.
 */
import { mkdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { bundle, launchChromium } from '../test/browser/harness.ts';
import { CORPUS, CORPUS_DIR, ensureCorpus } from './corpus.ts';
import { FEATURE_TITLES, featureTables, type FeatureRow } from './table.ts';

const root = new URL('../', import.meta.url).pathname;
const bench = new URL('./', import.meta.url).pathname;
const outDir = `${bench}.out/features/`;
mkdirSync(outDir, { recursive: true });
const PASSWORD = 'bench';
const TIMEOUT = Number(process.env.BENCH_TIMEOUT_S ?? 1200) * 1000;
const LARGE = 200 << 20;
/** Rendering: pixels per point, and pages per file compared with MuPDF. */
const SCALE = 2;
const COMPARE = 3;

const arg = (name: string): string[] | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1].split(',') : undefined;
};

interface Job {
  label: string;
  inputs: string[];
  /** Pages the written file should have. */
  pages?: number;
}

type Task = 'info' | 'text' | 'pages' | 'rotate' | 'merge' | 'decrypt';

interface Tool {
  id: string;
  label: string;
  tasks: Task[];
  argv: (task: Task, out: string, inputs: string[], pageCount: number) => string[];
}

const lean = (...a: string[]) => ['node', `${root}dist/cli.js`, ...a];
const oddPages = (n: number) => Array.from({ length: Math.ceil(n / 2) }, (_, i) => 2 * i + 1).join(',');

const TOOLS: Tool[] = [
  {
    id: 'leanpdf',
    label: '**leanpdf** (Node)',
    tasks: ['info', 'text', 'pages', 'rotate', 'merge', 'decrypt'],
    argv: (task, out, [a, ...rest], n) =>
      task === 'info' ? lean('info', a, '--json')
      : task === 'text' ? lean('text', a, '-o', out)
      : task === 'pages' ? lean('pages', a, out, oddPages(n))
      : task === 'rotate' ? lean('rotate', a, out, '90')
      : task === 'merge' ? lean('merge', out, a, ...rest)
      : lean('decrypt', a, out, '--password', PASSWORD),
  },
  {
    id: 'pdflib',
    label: 'pdf-lib 1.17 (Node)',
    tasks: ['info', 'pages', 'rotate', 'merge'],
    argv: (task, out, inputs) => ['node', `${bench}tools/pdflib.mjs`, task, out, ...inputs],
  },
  {
    id: 'pdfjs',
    label: 'PDF.js 6.3 (Node)',
    tasks: ['info', 'text'],
    argv: (task, out, inputs) => ['node', `${bench}tools/pdfjs.mjs`, task, out, ...inputs],
  },
  {
    id: 'mupdf',
    label: 'MuPDF.js 1.28 (Node)',
    tasks: ['info', 'text', 'pages', 'rotate', 'merge', 'decrypt'],
    argv: (task, out, inputs) => ['node', `${bench}tools/mupdf-features.mjs`, task, out, ...inputs],
  },
  {
    id: 'qpdf',
    label: 'qpdf 11 native',
    tasks: ['pages', 'rotate', 'merge', 'decrypt'],
    argv: (task, out, [a, ...rest]) =>
      task === 'pages' ? ['qpdf', a, '--pages', '.', '1-z:odd', '--', out]
      : task === 'rotate' ? ['qpdf', a, out, '--rotate=+90']
      : task === 'merge' ? ['qpdf', '--empty', '--pages', a, ...rest, '--', out]
      : ['qpdf', `--password=${PASSWORD}`, '--decrypt', a, out],
  },
];

const FEATURES = Object.keys(FEATURE_TITLES) as (Task | 'render')[];

const files = arg('files') ?? Object.keys(CORPUS);
const features = FEATURES.filter((f) => !arg('features') || arg('features')!.includes(f));
const tools = TOOLS.filter((t) => !arg('tools') || arg('tools')!.includes(t.id));
await ensureCorpus(files);
const pageCount = (path: string): number => Number(Bun.spawnSync(['qpdf', '--show-npages', path]).stdout.toString().trim());
const pagesOf = new Map(files.map((f) => [f, pageCount(CORPUS_DIR + f)]));

/** The AES-256 encrypted copy of a corpus file, made with qpdf. */
function encrypted(file: string): string {
  const path = `${CORPUS_DIR}aes256-${file}`;
  if (!existsSync(path)) {
    const r = Bun.spawnSync(['qpdf', '--encrypt', PASSWORD, 'owner', '256', '--', CORPUS_DIR + file, path]);
    if (r.exitCode !== 0) throw new Error(`qpdf --encrypt ${file}: ${r.stderr}`);
  }
  return path;
}

function jobs(task: Task): Job[] {
  if (task === 'merge') {
    const small = files.filter((f) => statSync(CORPUS_DIR + f).size < LARGE);
    const sets = [small, files].filter((s, i, all) => s.length > 1 && (i === 0 || s.length !== all[0].length));
    return sets.map((s) => ({
      label: s.length === files.length && s.length > small.length ? `all ${s.length} files` : s.map((f) => f.replace('.pdf', '')).join(' + '),
      inputs: s.map((f) => CORPUS_DIR + f),
      pages: s.reduce((n, f) => n + pagesOf.get(f)!, 0),
    }));
  }
  return files.map((f) => {
    const n = pagesOf.get(f)!;
    return {
      label: f,
      inputs: [task === 'decrypt' ? encrypted(f) : CORPUS_DIR + f],
      pages: task === 'pages' ? Math.ceil(n / 2) : task === 'info' || task === 'text' ? undefined : n,
    };
  });
}

interface Run {
  status: string;
  seconds: number;
  cpuSeconds: number;
  peakMb: number;
}

function runOnce(argv: string[]): Run {
  const t0 = performance.now();
  const r = Bun.spawnSync(['bun', `${bench}measure.ts`, ...argv], {
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: TIMEOUT,
    cwd: bench,
    env: { ...process.env, BENCH_PASSWORD: PASSWORD },
  });
  const seconds = (performance.now() - t0) / 1000;
  const stderr = r.stderr.toString();
  const m = /@@RUSAGE (.*)/.exec(stderr);
  const err = stderr.replace(/\n?@@RUSAGE .*\n?/, '');
  const usage = m ? JSON.parse(m[1]) : { exitCode: -1, signal: r.signalCode, cpu: 0, maxRssKb: 0 };
  let status = 'ok';
  if (r.signalCode) status = 'timeout';
  else if (usage.signal) status = `killed (${usage.signal})`;
  else if (usage.exitCode !== 0) {
    status = /heap out of memory|Allocation failed|Array buffer allocation failed|Cannot enlarge memory|ERR_FS_FILE_TOO_LARGE|out of memory/i.test(err)
      ? 'out of memory'
      : `failed (${(err.split('\n').find((l) => /\b\w*Error\b|error:|Aborted/.test(l)) ?? err.trim().split('\n').at(-1))?.trim().slice(0, 80)})`;
  }
  return { status, seconds, cpuSeconds: usage.cpu, peakMb: usage.maxRssKb / 1024 };
}

/** Check a written PDF: qpdf --check, page count, and not encrypted. */
function check(path: string, pages: number | undefined): string {
  const q = Bun.spawnSync(['qpdf', '--check', path]);
  if (q.exitCode !== 0 && q.exitCode !== 3) return 'no';
  if (pages !== undefined && pageCount(path) !== pages) return 'wrong pages';
  if (Bun.spawnSync(['qpdf', '--is-encrypted', path]).exitCode === 0) return 'still encrypted';
  return q.exitCode === 0 ? 'yes' : 'warnings';
}

const rows: FeatureRow[] = [];
for (const task of features) {
  if (task === 'render') {
    rows.push(...(await renderBench(files)));
    continue;
  }
  for (const job of jobs(task)) {
    const inBytes = job.inputs.reduce((n, p) => n + statSync(p).size, 0);
    for (const tool of tools.filter((t) => t.tasks.includes(task))) {
      // Every tool starts with the inputs in the page cache, not just the ones after the first.
      Bun.spawnSync(['cat', ...job.inputs], { stdout: 'ignore' });
      const out = `${outDir}${task}.${tool.id}.${task === 'text' ? 'txt' : task === 'info' ? 'json' : 'pdf'}`;
      const argv = tool.argv(task, out, job.inputs, pagesOf.get(job.label) ?? 0);
      process.stderr.write(`${task} / ${job.label} / ${tool.id} ... `);
      const runs: Run[] = [];
      for (let i = 0; i < (inBytes < LARGE ? 3 : 1); i++) {
        rmSync(out, { force: true });
        runs.push(runOnce(argv));
        if (runs.at(-1)!.status !== 'ok') break;
      }
      const run = runs.at(-1)!.status !== 'ok' ? runs.at(-1)! : [...runs].sort((a, b) => a.seconds - b.seconds)[runs.length >> 1];
      let outBytes: number | null = null;
      let valid = '–';
      if (run.status === 'ok' && existsSync(out)) {
        outBytes = statSync(out).size;
        if (task !== 'info' && task !== 'text') valid = check(out, job.pages);
      }
      rmSync(out, { force: true });
      process.stderr.write(`${run.status} ${run.seconds.toFixed(2)}s ${run.peakMb.toFixed(0)}MB ${valid}\n`);
      rows.push({ feature: task, job: job.label, tool: tool.label, ...run, inBytes, outBytes, valid });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering, in headless Chromium

async function renderBench(files: string[]): Promise<FeatureRow[]> {
  const js = await bundle(`${bench}render-entry.ts`, { minify: true });
  const pdfjsDir = `${bench}node_modules/pdfjs-dist/`;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === '/') return new Response('<!doctype html><meta charset="utf-8"><title>bench</title>', { headers: { 'content-type': 'text/html' } });
      if (path === '/entry.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      const file = path.startsWith('/pdfjs/') ? Bun.file(pdfjsDir + path.slice(7)) : Bun.file(CORPUS_DIR + path.slice(1));
      return file.size ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
  const launch = await launchChromium('render bench');
  if (!launch.browser) throw new Error(launch.skip);
  const out: FeatureRow[] = [];
  const renderers = [
    { id: 'leanpdf', label: '**leanpdf** (Chromium)' },
    { id: 'pdfjs', label: 'PDF.js 6.3 (Chromium)' },
  ].filter((r) => !arg('tools') || arg('tools')!.includes(r.id));
  for (const file of files) {
    const inBytes = statSync(CORPUS_DIR + file).size;
    const ref = mupdfGray(readFileSync(CORPUS_DIR + file), COMPARE);
    for (const r of renderers) {
      process.stderr.write(`render / ${file} / ${r.id} ... `);
      const context = await launch.browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.addScriptTag({ url: '/entry.js', type: 'module' });
      await page.waitForFunction(() => 'benchRender' in globalThis);
      const t0 = performance.now();
      type Res = { openMs: number; pageMs: number[]; gray: { width: number; height: number; data: string }[] };
      let res: Res | { error: string };
      try {
        res = await page.evaluate(
          ([tool, url, scale, keep]) => (globalThis as unknown as { benchRender: (...a: unknown[]) => Promise<Res> }).benchRender(tool, url, scale, keep),
          [r.id, `/${file}`, SCALE, COMPARE] as const,
        );
      } catch (e) {
        res = { error: (e instanceof Error ? e.message : String(e)).split('\n')[0] };
      }
      const seconds = (performance.now() - t0) / 1000;
      await context.close();
      if ('error' in res) {
        process.stderr.write(`failed: ${res.error}\n`);
        out.push({ feature: 'render', job: file, tool: r.label, status: `failed (${res.error.slice(0, 80)})`, seconds, cpuSeconds: null, peakMb: null, inBytes, outBytes: null, valid: '–' });
        continue;
      }
      const sorted = [...res.pageMs].sort((a, b) => a - b);
      const total = (res.openMs + res.pageMs.reduce((a, b) => a + b, 0)) / 1000;
      const diff = differs(
        res.gray.map((g) => ({ w: g.width, h: g.height, px: new Uint8Array(Buffer.from(g.data, 'base64')) })),
        ref,
      );
      process.stderr.write(`${total.toFixed(2)}s, ${res.pageMs.length} pages, median ${sorted[sorted.length >> 1].toFixed(0)} ms, ${diff?.toFixed(2)}% differ\n`);
      out.push({
        feature: 'render',
        job: file,
        tool: r.label,
        status: 'ok',
        seconds: total,
        cpuSeconds: null,
        peakMb: null,
        inBytes,
        outBytes: null,
        valid: '–',
        pages: res.pageMs.length,
        openMs: res.openMs,
        medianPageMs: sorted[sorted.length >> 1],
        differs: diff,
      });
    }
  }
  await launch.close();
  server.stop(true);
  return out;
}

type Gray = { w: number; h: number; px: Uint8Array };

function mupdfGray(bytes: Uint8Array, pages: number): Gray[] {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const out: Gray[] = [];
  for (let i = 0; i < Math.min(pages, doc.countPages()); i++) {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceGray, false);
    out.push({ w: pix.getWidth(), h: pix.getHeight(), px: pix.getPixels().slice() });
  }
  return out;
}

/**
 * Share of pixels, in percent, whose luminance differs from MuPDF's by more than 64: real
 * differences, not anti-aliasing or a slightly different font. Over the pages' common area, since
 * renderers may round the size differently by a pixel.
 */
function differs(a: Gray[], b: Gray[]): number | null {
  if (!a.length || a.length !== b.length) return null;
  let bad = 0;
  let n = 0;
  for (let p = 0; p < a.length; p++) {
    if (Math.abs(a[p].w - b[p].w) > 1 || Math.abs(a[p].h - b[p].h) > 1) return null;
    const w = Math.min(a[p].w, b[p].w);
    const h = Math.min(a[p].h, b[p].h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (Math.abs(a[p].px[y * a[p].w + x] - b[p].px[y * b[p].w + x]) > 64) bad++;
    }
    n += w * h;
  }
  return (100 * bad) / n;
}

writeFileSync(`${bench}.out/features.json`, `${JSON.stringify(rows, null, 2)}\n`);
const md = featureTables(rows);
writeFileSync(`${bench}.out/features.md`, md);
console.log(md);
process.exit(0);
