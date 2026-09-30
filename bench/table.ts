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
