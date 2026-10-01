/** Markdown tables of benchmark rows (bench/run.ts prints them; bench/readme.ts puts them in the README). */

export interface Row {
  file: string;
  tool: string;
  status: string;
  seconds: number;
  cpuSeconds: number;
  peakMb: number;
  inBytes: number;
  outBytes: number;
  valid: string;
  /** Rendered-page PSNR in dB; Infinity (stored as "Infinity") is pixel-identical, null not measured. */
  psnr: number | 'Infinity' | null;
}

const mb = (n: number): string => (n >= 10 << 20 ? (n / 1048576).toFixed(0) : (n / 1048576).toFixed(1)) + ' MB';

export function markdownTables(rows: Row[], files = [...new Set(rows.map((r) => r.file))]): string {
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
      const q = r.psnr === null ? '–' : r.psnr === Infinity || r.psnr === 'Infinity' ? '∞' : `${r.psnr.toFixed(1)} dB`;
      md += `| ${r.tool} | ${mb(r.outBytes)} | ${saved} | ${r.seconds.toFixed(1)} s | ${r.cpuSeconds.toFixed(1)} s | ${r.peakMb.toFixed(0)} MB | ${r.valid} | ${q} |\n`;
    }
  }
  return md;
}

/** One tool doing one job of bench/features.ts. */
export interface FeatureRow {
  feature: string;
  /** A corpus file, or the files merged. */
  job: string;
  tool: string;
  status: string;
  seconds: number;
  /** Not measured for rendering (it runs in the browser). */
  cpuSeconds: number | null;
  peakMb: number | null;
  inBytes: number;
  /** Size of the written file; null when nothing was written. */
  outBytes: number | null;
  /** `qpdf --check` of a written PDF, its page count, and that it isn't encrypted. */
  valid: string;
  /** Rendering only. */
  pages?: number;
  openMs?: number;
  medianPageMs?: number;
  /** Rendering: percent of pixels of the first pages that differ clearly from MuPDF's. */
  differs?: number | null;
}

export const FEATURE_TITLES: Record<string, string> = {
  info: 'Info: metadata and page sizes',
  text: 'Text extraction, all pages',
  pages: 'Select pages: keep every other page',
  rotate: 'Rotate all pages',
  merge: 'Merge',
  decrypt: 'Decrypt (AES-256, user password)',
  render: 'Render all pages (Chromium, 144 dpi)',
};

const secs = (s: number): string => (s < 10 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`);

/** A table cell: wall time and peak RSS. */
export function featureCell(r: FeatureRow | undefined): string {
  if (!r) return '–';
  if (r.status !== 'ok') return r.status;
  const bad = r.valid !== '–' && r.valid !== 'yes' && r.valid !== 'warnings' ? ` (output: ${r.valid})` : '';
  return `${secs(r.seconds)}, ${Math.round(r.peakMb ?? 0)} MB${bad}`;
}

/** Percent of pixels unlike MuPDF's. */
export const differsText = (r: FeatureRow): string =>
  typeof r.differs !== 'number' ? '–' : r.differs < 0.1 ? '<0.1%' : `${r.differs.toFixed(1)}%`;

/** Markdown table of one feature: tools down, jobs across; rendering gets a row per file and tool. */
export function featureTable(rows: FeatureRow[], feature: string): string {
  const rs = rows.filter((r) => r.feature === feature);
  const jobs = [...new Set(rs.map((r) => r.job))];
  const name = (j: string) => (j.endsWith('.pdf') ? `\`${j}\`` : j);
  if (feature === 'render') {
    let md = '| File | Renderer | All pages | Per page (median) | Pixels unlike MuPDF |\n|---|---|--:|--:|--:|\n';
    for (const r of rs) {
      md += r.status !== 'ok'
        ? `| ${name(r.job)} (${r.pages ?? '?'} pages) | ${r.tool} | ${r.status} | | |\n`
        : `| ${name(r.job)} (${r.pages} pages) | ${r.tool} | ${secs(r.seconds)} | ${Math.round(r.medianPageMs ?? 0)} ms | ${differsText(r)} |\n`;
    }
    return md;
  }
  let md = `| Tool | ${jobs.map(name).join(' | ')} |\n|---|${jobs.map(() => '--:').join('|')}|\n`;
  for (const tool of [...new Set(rs.map((r) => r.tool))]) {
    md += `| ${tool} | ${jobs.map((j) => featureCell(rs.find((r) => r.job === j && r.tool === tool))).join(' | ')} |\n`;
  }
  return md;
}

/** All features, each under a heading. */
export function featureTables(rows: FeatureRow[]): string {
  let md = '';
  for (const feature of [...new Set(rows.map((r) => r.feature))]) md += `\n#### ${FEATURE_TITLES[feature] ?? feature}\n\n${featureTable(rows, feature)}`;
  return md;
}
