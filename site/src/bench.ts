/**
 * Benchmark data (bench/results.json, rows as written by bench/run.ts) and its rendering: one
 * table per corpus file and small hand-written SVG bar charts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ROOT } from './config.ts';
import { escapeHtml } from './highlight.ts';
import { renderInline } from './markdown.ts';

export interface BenchRow {
  file: string;
  /** Display label; may contain Markdown bold (`**leanpdf** (Node, sharp)`). */
  tool: string;
  status: string;
  seconds: number;
  cpuSeconds: number;
  peakMb: number;
  inBytes: number;
  outBytes: number;
  valid: string;
  /**
   * Rendered-page PSNR in dB. "Infinity" means pixel-identical; null means not measured (files
   * over 200 MB, or pages that couldn't be compared). Files written before bench/run.ts stored
   * Infinity as a string have null for pixel-identical results too.
   */
  psnr: number | 'Infinity' | null;
}

export interface BenchData {
  rows: BenchRow[];
  files: string[];
  /** File name -> description, from the header comment of bench/corpus.ts. */
  corpus: Map<string, string>;
}

export const RESULTS_PATH = `${ROOT}bench/results.json`;

function isRow(x: unknown): x is BenchRow {
  const r = x as Record<string, unknown>;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.file === 'string' &&
    typeof r.tool === 'string' &&
    typeof r.status === 'string' &&
    ['seconds', 'cpuSeconds', 'peakMb', 'inBytes', 'outBytes'].every((k) => typeof r[k] === 'number')
  );
}

/** Load the committed results, or null when there are none (the page then says so). */
export function loadBench(path = RESULTS_PATH): BenchData | null {
  if (!existsSync(path)) return null;
  const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(json)) throw new Error(`${path}: expected an array of rows`);
  const rows = json.filter(isRow);
  if (rows.length !== json.length) throw new Error(`${path}: ${json.length - rows.length} malformed rows`);
  if (!rows.length) return null;
  const files = [...new Set(rows.map((r) => r.file))];
  return { rows, files, corpus: corpusDescriptions() };
}

/** Parse `name.pdf   description` lines from the doc comment at the top of bench/corpus.ts. */
export function corpusDescriptions(path = `${ROOT}bench/corpus.ts`): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  const head = /^\/\*\*([\s\S]*?)\*\//.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
  for (const m of head.matchAll(/^\s*\*\s+(\S+\.pdf)\s{2,}(.+)$/gm)) out.set(m[1], m[2].trim());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Formatting

const MiB = 1048576;
export const fmtMb = (bytes: number): string => (bytes >= 10 * MiB ? (bytes / MiB).toFixed(0) : (bytes / MiB).toFixed(1)) + ' MB';
export const fmtRss = (mb: number): string => `${Math.round(mb).toLocaleString('en-US')} MB`;
export const fmtSec = (s: number): string => `${s.toFixed(1)} s`;
const plainTool = (tool: string): string => tool.replace(/\*\*/g, '');
export const isLeanpdf = (r: BenchRow): boolean => /leanpdf/i.test(r.tool);

function fmtPsnr(r: BenchRow): string {
  if (r.status !== 'ok') return '';
  if (r.psnr === 'Infinity') return '∞';
  if (typeof r.psnr === 'number') return Number.isFinite(r.psnr) ? `${r.psnr.toFixed(1)} dB` : '∞';
  return '–';
}

function savedPct(r: BenchRow): string {
  const p = 100 * (1 - r.outBytes / r.inBytes);
  const s = p.toFixed(0);
  return s === '-0' ? '0%' : `${s}%`;
}

// ---------------------------------------------------------------------------------------------
// Charts

interface ChartSpec {
  title: string;
  unit: string;
  value: (r: BenchRow) => number;
  format: (r: BenchRow) => string;
  /** Optional first bar for comparison (e.g. the input size), drawn in a lighter gray. */
  baseline?: { label: string; value: number; text: string };
}

const W = 320;
const LABEL_H = 15;
const BAR_H = 11;
const ROW_H = 33;
const VALUE_W = 60;

function bar(x: number, y: number, w: number, cls: string): string {
  const r = Math.min(4, w / 2, BAR_H / 2);
  // Square at the baseline, rounded at the data end.
  return (
    `<path class="${cls}" d="M${x} ${y}h${(w - r).toFixed(2)}a${r} ${r} 0 0 1 ${r} ${r}v${BAR_H - 2 * r}` +
    `a${r} ${r} 0 0 1 -${r} ${r}H${x}z"/>`
  );
}

/** Horizontal bar chart, one bar per tool; leanpdf's bars carry the accent color. */
export function barChart(rows: BenchRow[], spec: ChartSpec, idBase: string): string {
  type Item = { label: string; cls: string; value?: number; text: string; failed?: boolean };
  const items: Item[] = [];
  if (spec.baseline) items.push({ label: spec.baseline.label, cls: 'base', value: spec.baseline.value, text: spec.baseline.text });
  for (const r of rows) {
    const cls = isLeanpdf(r) ? 'hl' : '';
    items.push(r.status === 'ok' ? { label: plainTool(r.tool), cls, value: spec.value(r), text: spec.format(r) } : { label: plainTool(r.tool), cls, text: r.status, failed: true });
  }
  const h = items.length * ROW_H + 2;
  const max = Math.max(1e-9, ...items.map((i) => i.value ?? 0));
  const span = W - VALUE_W;
  let body = '';
  items.forEach((it, i) => {
    const y = i * ROW_H;
    const by = y + LABEL_H;
    const cls = it.cls ? ` ${it.cls}` : '';
    body += `<g><title>${escapeHtml(`${it.label}: ${it.text}`)}</title><text class="label${cls}" x="0" y="${y + 11}">${escapeHtml(it.label)}</text>`;
    if (it.failed || it.value === undefined) {
      body += `<text class="status" x="4" y="${by + 9.5}">${escapeHtml(it.text)}</text></g>`;
      return;
    }
    const w = Math.max(1.5, (it.value / max) * span);
    body += bar(0, by, w, `bar${cls}`);
    body += `<text class="value${cls}" x="${(w + 6).toFixed(2)}" y="${by + 9.5}">${escapeHtml(it.text)}</text></g>`;
  });
  const summary = items.map((it) => `${it.label}: ${it.text}`).join('; ');
  return `<figure class="chart">
<figcaption id="${idBase}-cap">${escapeHtml(spec.title)} <span>(${escapeHtml(spec.unit)})</span></figcaption>
<svg viewBox="-1 0 ${W + 1} ${h}" role="img" aria-labelledby="${idBase}-cap" aria-describedby="${idBase}-desc"><desc id="${idBase}-desc">${escapeHtml(summary)}</desc>
<line class="axis" x1="0" x2="0" y1="${LABEL_H - 2}" y2="${h}"/>${body}</svg>
</figure>`;
}

// ---------------------------------------------------------------------------------------------
// Tables

export function benchTable(rows: BenchRow[], caption: string): string {
  let html = `<div class="table-wrap" tabindex="0"><table class="bench-table"><caption class="visually-hidden">${escapeHtml(caption)}</caption><thead><tr>
<th scope="col">Tool</th><th scope="col" class="num">Output</th><th scope="col" class="num">Saved</th><th scope="col" class="num">Wall time</th>
<th scope="col" class="num">CPU time</th><th scope="col" class="num">Peak RSS</th><th scope="col">Valid (qpdf)</th><th scope="col" class="num">PSNR</th></tr></thead><tbody>`;
  for (const r of rows) {
    const tool = renderInline(r.tool);
    const cls = isLeanpdf(r) ? ' class="hl"' : '';
    if (r.status !== 'ok') {
      html += `<tr${cls}><th scope="row">${tool}</th><td class="num status-bad" colspan="2">${escapeHtml(r.status)}</td><td class="num">${fmtSec(r.seconds)}</td><td class="num">${fmtSec(r.cpuSeconds)}</td><td class="num">${fmtRss(r.peakMb)}</td><td></td><td></td></tr>`;
      continue;
    }
    html += `<tr${cls}><th scope="row">${tool}</th><td class="num">${fmtMb(r.outBytes)}</td><td class="num">${savedPct(r)}</td><td class="num">${fmtSec(r.seconds)}</td><td class="num">${fmtSec(r.cpuSeconds)}</td><td class="num">${fmtRss(r.peakMb)}</td><td>${escapeHtml(r.valid)}</td><td class="num">${fmtPsnr(r)}</td></tr>`;
  }
  return `${html}</tbody></table></div>`;
}

export function fileSection(data: BenchData, file: string): string {
  const rows = data.rows.filter((r) => r.file === file);
  const inBytes = rows[0].inBytes;
  const id = file.replace(/\W+/g, '-').toLowerCase();
  const desc = data.corpus.get(file);
  const charts = [
    barChart(rows, { title: 'Output size', unit: 'MB', value: (r) => r.outBytes, format: (r) => fmtMb(r.outBytes), baseline: { label: 'Original file', value: inBytes, text: fmtMb(inBytes) } }, `${id}-size`),
    barChart(rows, { title: 'Peak memory', unit: 'RSS in MB', value: (r) => r.peakMb, format: (r) => fmtRss(r.peakMb) }, `${id}-mem`),
    barChart(rows, { title: 'CPU time', unit: 'seconds, user + system', value: (r) => r.cpuSeconds, format: (r) => fmtSec(r.cpuSeconds) }, `${id}-cpu`),
  ];
  return `<section class="bench-file" aria-labelledby="${id}">
<h2 id="${id}"><code>${escapeHtml(file)}</code> <span class="muted">${fmtMb(inBytes)}</span></h2>
${desc ? `<p>${escapeHtml(desc.charAt(0).toUpperCase() + desc.slice(1))}.</p>` : ''}
<div class="charts">${charts.join('\n')}</div>
${benchTable(rows, `Results for ${file}`)}
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Highlights for the home page

export interface MemoryHighlight {
  file: string;
  inBytes: number;
  /** Lowest leanpdf peak RSS on the largest file. */
  lean: BenchRow;
  /** Other JavaScript/WASM tools on the same file, highest peak first. */
  others: BenchRow[];
}

export function memoryHighlight(data: BenchData): MemoryHighlight | null {
  const largest = data.files.map((f) => data.rows.find((r) => r.file === f)!).sort((a, b) => b.inBytes - a.inBytes)[0];
  if (!largest) return null;
  const rows = data.rows.filter((r) => r.file === largest.file);
  const lean = rows.filter((r) => isLeanpdf(r) && r.status === 'ok').sort((a, b) => a.peakMb - b.peakMb)[0];
  if (!lean) return null;
  const others = rows.filter((r) => !isLeanpdf(r) && !/native/i.test(r.tool)).sort((a, b) => b.peakMb - a.peakMb);
  return { file: largest.file, inBytes: largest.inBytes, lean, others };
}

/** The best leanpdf size reduction among the (non-huge) files, for a headline number. */
export function savingsHighlight(data: BenchData): BenchRow | null {
  const lean = data.rows.filter((r) => isLeanpdf(r) && r.status === 'ok' && r.inBytes < 200 * MiB);
  return lean.sort((a, b) => a.outBytes / a.inBytes - b.outBytes / b.inBytes)[0] ?? null;
}

export { plainTool };
