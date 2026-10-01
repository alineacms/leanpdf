/** Benchmarks page, rendered from bench/results.json at build time. */
import { GITHUB_URL } from '../config.ts';
import { FEATURES, featureSection, fileSection, fmtMb, fmtRss, isLeanpdf, plainTool, type BenchData, type FeatureRow } from '../bench.ts';
import { codeBlock, escapeHtml } from '../highlight.ts';
import { page, type Assets } from './layout.ts';

const REPRODUCE = `bun install && bun install --cwd bench
bun run build                        # dist/cli.js, for the Node runs
bun bench/run.ts                     # compression; or --files scan.pdf --tools leanpdf-node,gs
bun bench/features.ts                # the rest; or --features text,merge --tools leanpdf,mupdf
cp bench/.out/results.json bench/.out/features.json bench/
bun run site:build                   # re-renders this page`;

/** What each compression tool in bench/run.ts does; keyed by a pattern on the tool label. */
const TOOLS: { match: RegExp; name: string; text: string }[] = [
  {
    match: /leanpdf.*Node/,
    name: 'leanpdf (Node, sharp)',
    text: 'The CLI on Node with sharp, at its defaults: 1600 px, JPEG quality 0.75.',
  },
  { match: /leanpdf.*Bun/, name: 'leanpdf (Bun, sharp)', text: 'The same CLI run from source on Bun.' },
  {
    match: /pdf-lib/,
    name: 'pdf-lib + sharp',
    text: 'Loads the whole document, recompresses images with sharp at the same settings, saves.',
  },
  {
    match: /Ghostscript WASM/,
    name: 'Ghostscript WASM, /ebook',
    text: 'Ghostscript in WebAssembly, as in-browser compressors use it, with the /ebook preset (150 dpi).',
  },
  {
    match: /MuPDF/,
    name: 'MuPDF.js, lossless',
    text: 'MuPDF in WebAssembly. Its API can’t downsample images, so this is a lossless rewrite.',
  },
  { match: /Ghostscript 10 native/, name: 'Ghostscript native, /ebook', text: 'Native Ghostscript with the same preset, for reference.' },
  { match: /qpdf/, name: 'qpdf native, lossless', text: 'Native qpdf, lossless, for reference.' },
];

function findings(data: BenchData): string {
  const lean = data.rows.filter((r) => isLeanpdf(r) && r.status === 'ok');
  const items: string[] = [];
  if (lean.length) {
    const peaks = lean.map((r) => r.peakMb);
    const largest = Math.max(...data.rows.map((r) => r.inBytes));
    const others = data.rows.filter((r) => r.inBytes === largest && !isLeanpdf(r) && !/native/i.test(r.tool));
    const ok = others.filter((r) => r.status === 'ok').sort((a, b) => b.peakMb - a.peakMb);
    const oom = others.filter((r) => r.status === 'out of memory');
    items.push(
      `<li><strong>Memory stays flat.</strong> leanpdf used at most ${fmtRss(Math.max(...peaks))}, on the ${fmtMb(largest)} file too.` +
        (ok.length ? ` The others needed up to ${fmtRss(ok[0].peakMb)}` : '') +
        (oom.length ? `${ok.length ? ', and ' : ' On that file, '}${oom.map((r) => escapeHtml(plainTool(r.tool).replace(/[,(].*$/, '').trim())).join(' and ')} ran out of memory` : '') +
        (ok.length || oom.length ? '.' : '') +
        '</li>',
    );
  }
  items.push(
    '<li><strong>Ghostscript makes the smallest files</strong> by re-rendering everything at 150 dpi, at lower quality.</li>',
    '<li><strong>pdf-lib can’t decode predicted images</strong>, so the scans don’t shrink.</li>',
    '<li><strong>Lossless tools don’t shrink photos.</strong></li>',
  );
  return `<ul>${items.join('\n')}</ul>`;
}

/** The libraries in bench/features.ts. */
const FEATURE_TOOLS: { name: string; text: string }[] = [
  { name: 'leanpdf', text: 'The CLI on Node (info, text, pages, rotate, merge, decrypt), and renderPage in Chromium.' },
  { name: 'pdf-lib', text: 'Loads each document into its object model and saves the whole result. It can’t extract text, render or decrypt.' },
  { name: 'PDF.js', text: 'Mozilla’s reader: info and text in Node (legacy build), rendering in Chromium with its worker. It can’t write PDFs.' },
  { name: 'MuPDF.js', text: 'MuPDF in WebAssembly, which reads the whole file into memory first.' },
  { name: 'qpdf native', text: 'For reference, for the jobs that write files.' },
];

function methodology(data: BenchData | null): string {
  const corpus = data?.corpus ?? new Map<string, string>();
  const labels = new Set(data?.rows.map((r) => r.tool) ?? []);
  const tools = TOOLS.filter((t) => !data || [...labels].some((l) => t.match.test(l)));
  return `<section class="methodology section" aria-labelledby="methodology">
<h2 id="methodology">Methodology</h2>
<p>Each tool runs in its own process on one 4-core Linux container; CPU time and peak memory (RSS) come from the kernel, and include the runtime itself (about 45 MB for Node). Jobs on the smaller files run three times and the median run counts. Written files are checked with <code>qpdf --check</code> and their page count. For compression, pages are rendered to compare quality (PSNR). The code is in <a href="${GITHUB_URL}/tree/main/bench" rel="noopener"><code>bench/</code></a>.</p>

<h3>Compression tools</h3>
<dl>
${tools.map((t) => `<dt>${escapeHtml(t.name)}</dt><dd>${escapeHtml(t.text)}</dd>`).join('\n')}
</dl>
<h3>Tools for the other features</h3>
<dl>
${FEATURE_TOOLS.map((t) => `<dt>${escapeHtml(t.name)}</dt><dd>${escapeHtml(t.text)}</dd>`).join('\n')}
</dl>
<p>Chromium runs headless with software rasterization, like most servers; on a desktop with a GPU both renderers are faster.</p>
<h3>Corpus</h3>
<p>Generated by <a href="${GITHUB_URL}/blob/main/bench/corpus.ts" rel="noopener"><code>bench/corpus.ts</code></a>, with photo-like images.</p>
${corpus.size ? `<dl>${[...corpus].map(([f, d]) => `<dt><code>${escapeHtml(f)}</code></dt><dd>${escapeHtml(d.charAt(0).toUpperCase() + d.slice(1))}</dd>`).join('\n')}</dl>` : ''}
<h3>Reproduce</h3>
<p>Needs Bun, Node, <code>qpdf</code> and <code>gs</code>, and Chromium for rendering. The corpus (about 700 MB, and as much again for the encrypted copies) is generated on the first run.</p>
${codeBlock(REPRODUCE, 'sh')}
</section>`;
}

export function benchmarksPage(assets: Assets, data: BenchData | null, features: FeatureRow[] | null = null): string {
  const shown = FEATURES.filter((f) => features?.some((r) => r.feature === f.id));
  const nav = [{ id: 'compression', title: 'Compression' }, ...shown.map((f) => ({ id: `feature-${f.id}`, title: f.title }))];
  const compression = data
    ? `<section class="bench-feature" aria-labelledby="compression">
<h2 id="compression">Compression</h2>
<p>Recompress and downscale images (leanpdf’s defaults: 1600 px, JPEG quality 0.75), keeping the rest.</p>
<div class="prose">${findings(data)}</div>
${data.files.map((f) => fileSection(data, f)).join('\n')}
</section>`
    : `<div class="notice" role="note" id="no-results"><p><strong>No benchmark results yet.</strong> This build found no <code>bench/results.json</code>. Run the benchmark (see <a href="#methodology">Methodology</a>) and commit the file to publish numbers here.</p></div>`;
  const body = `<div class="container">
<div class="page-head">
  <h1>Benchmarks</h1>
  <p>leanpdf next to other JavaScript PDF tools on the same documents, feature by feature. Shorter bars are better.</p>
</div>
${shown.length ? `<nav class="bench-nav" aria-label="Features"><ul>${nav.map((n) => `<li><a href="#${n.id}">${escapeHtml(n.title)}</a></li>`).join('')}</ul></nav>` : ''}
${compression}
${shown.map((f) => featureSection(features!, f)).join('\n')}
${methodology(data)}
</div>`;
  return page({
    path: '/benchmarks/',
    title: 'Benchmarks · leanpdf',
    description: 'Speed and peak memory of leanpdf, pdf-lib, PDF.js, MuPDF.js, Ghostscript and qpdf: compressing, reading info and text, editing pages, merging, decrypting and rendering, up to a 600 MB PDF.',
    body,
    assets,
    script: assets.siteJs,
  });
}
