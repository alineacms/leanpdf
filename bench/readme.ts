/**
 * Put the committed benchmark results (bench/results.json) into the README: the full tables
 * between the BENCHMARKS markers and a short summary at BENCHMARK-SUMMARY. Run after copying a
 * fresh bench/.out/results.json to bench/results.json:
 *
 *   bun bench/readme.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { markdownTables, type Row } from './table.ts';

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

readme = replaceBetween(readme, 'BENCHMARK-SUMMARY', summary);
readme = replaceBetween(readme, 'BENCHMARKS', markdownTables(rows, files));
writeFileSync(readmePath, readme);
console.log('README.md benchmark tables updated');
