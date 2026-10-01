/**
 * Put the committed benchmark results into the README: the compression tables (bench/results.json)
 * between the BENCHMARKS markers with a short summary at BENCHMARK-SUMMARY, and the other features
 * (bench/features.json) between the FEATURE-BENCHMARKS markers. Run after copying fresh files from
 * bench/.out/:
 *
 *   bun bench/readme.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FEATURE_TITLES, featureCell, featureTables, markdownTables, type FeatureRow, type Row } from './table.ts';

const root = new URL('../', import.meta.url).pathname;
const rows: Row[] = JSON.parse(readFileSync(`${root}bench/results.json`, 'utf8'));
const readmePath = `${root}README.md`;
let readme = readFileSync(readmePath, 'utf8');

const replaceBetween = (text: string, name: string, body: string): string => {
  const re = new RegExp(`(<!-- ${name}:START[^>]*-->\\n)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) throw new Error(`README.md has no ${name}:START/END markers`);
  return text.replace(re, (_, a: string, b: string) => `${a}${body.trim()}\n${b}`);
};

const mb = (n: number): string => (n >= 10 << 20 ? (n / 1048576).toFixed(0) : (n / 1048576).toFixed(1)) + ' MB';
const change = (r: Row): string => {
  const d = Math.round(100 * (r.outBytes / r.inBytes - 1));
  return d < 0 ? `−${-d}%` : d > 0 ? `+${d}%` : '±0%';
};
const find = (file: string, tool: RegExp): Row | undefined => rows.find((r) => r.file === file && tool.test(r.tool));

// Summary: savings and peak memory of leanpdf (Node) next to pdf-lib and Ghostscript WASM.
const files = [...new Set(rows.map((r) => r.file))];
let summary = '| File | leanpdf (Node) | pdf-lib + sharp | Ghostscript WASM |\n|---|--:|--:|--:|\n';
for (const file of files) {
  const cell = (r: Row | undefined): string =>
    !r ? '–' : r.status !== 'ok' ? `${r.status}, ${r.peakMb.toFixed(0)} MB RSS` : `${mb(r.outBytes)} (${change(r)}), ${r.peakMb.toFixed(0)} MB RSS`;
  const input = rows.find((r) => r.file === file)!;
  summary += `| \`${file}\` (${mb(input.inBytes)}) | ${cell(find(file, /leanpdf.*Node/))} | ${cell(find(file, /pdf-lib/))} | ${cell(find(file, /Ghostscript WASM/))} |\n`;
}

readme = replaceBetween(readme, 'BENCHMARKS', markdownTables(rows, files));
const featuresPath = `${root}bench/features.json`;
if (existsSync(featuresPath)) {
  const features: FeatureRow[] = JSON.parse(readFileSync(featuresPath, 'utf8'));
  readme = replaceBetween(readme, 'FEATURE-BENCHMARKS', featureTables(features));
  // Summary of the other features on the largest file, where streaming shows.
  const largest = features.reduce((a, b) => (b.inBytes > a.inBytes && b.job.endsWith('.pdf') ? b : a)).job;
  const on = features.filter((r) => r.job === largest && r.feature !== 'render');
  const libs = [/leanpdf/, /pdf-lib/, /PDF\.js/, /MuPDF/];
  const names = libs.map((re) => on.find((r) => re.test(r.tool))?.tool.replace(/\*\*/g, '').replace(/ \d.*| \(.*/, ''));
  summary += `\nOn \`${largest}\` (${mb(on[0].inBytes)}), wall time and peak RSS:\n\n`;
  summary += `| Feature | ${names.map((n) => n ?? '').join(' | ')} |\n|---|${libs.map(() => '--:').join('|')}|\n`;
  for (const feature of [...new Set(on.map((r) => r.feature))]) {
    const cells = libs.map((re) => on.find((r) => r.feature === feature && re.test(r.tool)));
    summary += `| ${FEATURE_TITLES[feature].replace(/[:(,].*/, '').trim()} | ${cells.map((r) => (r ? featureCell(r) : '–')).join(' | ')} |\n`;
  }
  summary += '\n(– means the library has no such feature.)\n';
}
readme = replaceBetween(readme, 'BENCHMARK-SUMMARY', summary);
writeFileSync(readmePath, readme);
console.log('README.md benchmark tables updated');
