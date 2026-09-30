/**
 * Benchmark leanpdf against other JavaScript PDF compressors (plus native references).
 *
 *   bun install --cwd bench && bun run build   # once
 *   bun bench/run.ts [--files brochure.pdf,scan.pdf] [--tools leanpdf-node,pdflib]
 *
 * Every tool runs in its own process; CPU time and peak RSS come from the kernel's rusage for
 * that process. Outputs are checked with `qpdf --check`, and the first pages are rendered with
 * MuPDF (all pages, 72 dpi, luminance) to measure how much the images changed, as PSNR.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { CORPUS, CORPUS_DIR, ensureCorpus } from './corpus.ts';

const root = new URL('../', import.meta.url).pathname;
const bench = new URL('./', import.meta.url).pathname;
const outDir = `${bench}.out/`;
mkdirSync(outDir, { recursive: true });

interface Tool {
  id: string;
  label: string;
  js: boolean;
  argv: (input: string, output: string) => string[];
}

const TOOLS: Tool[] = [
  { id: 'leanpdf-node', label: '**leanpdf** (Node, sharp)', js: true, argv: (i, o) => ['node', `${root}dist/cli.js`, 'compress', i, o, '--quiet'] },
  { id: 'leanpdf-bun', label: '**leanpdf** (Bun, sharp)', js: true, argv: (i, o) => ['bun', `${root}src/cli.ts`, 'compress', i, o, '--quiet'] },
  { id: 'pdflib', label: 'pdf-lib 1.17 + sharp (Node)', js: true, argv: (i, o) => ['node', `${bench}tools/pdflib-sharp.mjs`, i, o] },
  { id: 'gs-wasm', label: 'Ghostscript WASM, /ebook (Node)', js: true, argv: (i, o) => ['node', `${bench}tools/gs-wasm.mjs`, i, o] },
  { id: 'mupdf', label: 'MuPDF.js 1.28, lossless (Node)', js: true, argv: (i, o) => ['node', `${bench}tools/mupdf.mjs`, i, o] },
  {
    id: 'gs',
    label: 'Ghostscript 10 native, /ebook',
    js: false,
    argv: (i, o) => ['gs', '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dBATCH', '-dQUIET', `-sOutputFile=${o}`, i],
  },
  {
    id: 'qpdf',
    label: 'qpdf 11 native, lossless',
    js: false,
    argv: (i, o) => ['qpdf', '--recompress-flate', '--compression-level=9', '--object-streams=generate', i, o],
  },
];

const arg = (name: string): string[] | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1].split(',') : undefined;
};
const files = arg('files') ?? Object.keys(CORPUS);
const tools = TOOLS.filter((t) => !arg('tools') || arg('tools')!.includes(t.id));
const TIMEOUT = Number(process.env.BENCH_TIMEOUT_S ?? 1200) * 1000;

interface Row {
  file: string;
  tool: string;
  status: string;
  seconds: number;
  cpuSeconds: number;
  peakMb: number;
  inBytes: number;
  outBytes: number;
  valid: string;
  psnr: number | null;
}

function render(bytes: Uint8Array, pages: number): { w: number; h: number; px: Uint8Array }[] {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const out = [];
  for (let i = 0; i < Math.min(pages, doc.countPages()); i++) {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceGray, false);
    out.push({ w: pix.getWidth(), h: pix.getHeight(), px: pix.getPixels().slice() });
  }
  return out;
}

/** PSNR of the rendered first pages (72 dpi, luminance). Infinity = pixel identical. */
function psnr(a: ReturnType<typeof render>, b: ReturnType<typeof render>): number | null {
  if (!a.length || a.length !== b.length) return null;
  let se = 0;
  let n = 0;
  for (let p = 0; p < a.length; p++) {
    if (a[p].w !== b[p].w || a[p].h !== b[p].h) return null;
    for (let i = 0; i < a[p].px.length; i++) {
      const d = a[p].px[i] - b[p].px[i];
      se += d * d;
    }
    n += a[p].px.length;
  }
  const mse = se / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

const rows: Row[] = [];
for (const [file] of (await ensureCorpus(files)).map((p, i) => [files[i], p])) {
  const input = CORPUS_DIR + file;
  const inBytes = statSync(input).size;
  const small = inBytes < 200 << 20;
  const ref = small ? render(readFileSync(input), 60) : [];
  for (const tool of tools) {
    const output = `${outDir}${file.replace('.pdf', '')}.${tool.id}.pdf`;
    const argv = tool.argv(input, output);
    process.stderr.write(`${file} / ${tool.id} ... `);
    const t0 = performance.now();
    const r = Bun.spawnSync(['bun', `${bench}measure.ts`, ...argv], { stdout: 'ignore', stderr: 'pipe', timeout: TIMEOUT, cwd: bench });
    const seconds = (performance.now() - t0) / 1000;
    const err = r.stderr.toString();
    const m = /@@RUSAGE (.*)/.exec(err);
    const usage = m ? JSON.parse(m[1]) : { exitCode: -1, signal: r.signalCode, cpu: 0, maxRssKb: 0 };
    const cpuSeconds = usage.cpu;
    const peakMb = usage.maxRssKb / 1024;
    let status = 'ok';
    if (r.signalCode) status = 'timeout';
    else if (usage.signal) status = `killed (${usage.signal})`;
    else if (usage.exitCode !== 0) {
      status = /heap out of memory|Allocation failed|RangeError: Array buffer allocation failed|Cannot enlarge memory|ERR_FS_FILE_TOO_LARGE|out of memory/i.test(err)
        ? 'out of memory'
        : `failed (${err.trim().split('\n').at(-1)?.slice(0, 80)})`;
    }
    let outBytes = 0;
    let valid = '-';
    let quality: number | null = null;
    if (status === 'ok' && existsSync(output)) {
      outBytes = statSync(output).size;
      const q = spawnSync('qpdf', ['--check', output], { encoding: 'utf8', maxBuffer: 1 << 26 });
      valid = q.status === 0 ? 'yes' : q.status === 3 ? 'warnings' : 'no';
      if (small) quality = psnr(ref, render(readFileSync(output), 60));
    }
    process.stderr.write(`${status} ${seconds.toFixed(1)}s ${peakMb.toFixed(0)}MB ${(outBytes / 1048576).toFixed(2)}MB\n`);
    rows.push({ file, tool: tool.label, status, seconds, cpuSeconds, peakMb, inBytes, outBytes, valid, psnr: quality });
  }
}

const mb = (n: number) => (n >= 10 << 20 ? (n / 1048576).toFixed(0) : (n / 1048576).toFixed(1)) + ' MB';
let md = '';
for (const file of files) {
  const rs = rows.filter((r) => r.file === file);
  if (!rs.length) continue;
  md += `\n#### ${file} (${mb(rs[0].inBytes)})\n\n`;
  md += '| Tool | Output | Saved | Wall time | CPU time | Peak RSS | Valid (qpdf) | PSNR |\n|---|--:|--:|--:|--:|--:|:-:|--:|\n';
  for (const r of rs) {
    if (r.status !== 'ok') {
      md += `| ${r.tool} | ${r.status} | | ${r.seconds.toFixed(1)} s | ${r.cpuSeconds.toFixed(1)} s | ${r.peakMb.toFixed(0)} MB | | |\n`;
      continue;
    }
    const saved = `${(100 * (1 - r.outBytes / r.inBytes)).toFixed(0)}%`;
    const q = r.psnr === null ? '–' : r.psnr === Infinity ? '∞' : `${r.psnr.toFixed(1)} dB`;
    md += `| ${r.tool} | ${mb(r.outBytes)} | ${saved} | ${r.seconds.toFixed(1)} s | ${r.cpuSeconds.toFixed(1)} s | ${r.peakMb.toFixed(0)} MB | ${r.valid} | ${q} |\n`;
  }
}
// JSON has no Infinity (it would become null, like "not measured"): pixel-identical is "Infinity".
writeFileSync(`${outDir}results.json`, `${JSON.stringify(rows, (_, v) => (v === Infinity ? 'Infinity' : v), 2)}\n`);
writeFileSync(`${outDir}results.md`, md);
console.log(md);
