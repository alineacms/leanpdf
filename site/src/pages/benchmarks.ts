/** Benchmarks page, rendered from bench/results.json at build time. */
import { GITHUB_URL } from '../config.ts';
import { fileSection, fmtMb, fmtRss, isLeanpdf, type BenchData } from '../bench.ts';
import { codeBlock, escapeHtml } from '../highlight.ts';
import { page, type Assets } from './layout.ts';

const REPRODUCE = `bun install && bun install --cwd bench
bun run build                        # dist/cli.js, for the Node run
bun bench/run.ts                     # or --files scan.pdf --tools leanpdf-node,gs
cp bench/.out/results.json bench/results.json
bun run site:build                   # re-renders this page`;

/** What each tool in bench/run.ts does; keyed by a pattern on the tool label. */
const TOOLS: { match: RegExp; name: string; text: string }[] = [
  {
    match: /leanpdf.*Node/,
    name: 'leanpdf (Node, sharp)',
    text: 'The published CLI (dist/cli.js compress) on Node with the sharp codec, at its defaults: images capped at 1600 × 1600 px, JPEG quality 0.75, replaced only when at least 10% smaller.',
  },
  { match: /leanpdf.*Bun/, name: 'leanpdf (Bun, sharp)', text: 'The same CLI run from source on Bun.' },
  {
    match: /pdf-lib/,
    name: 'pdf-lib + sharp',
    text: "The usual pdf-lib approach: load the whole document into pdf-lib's object model, recompress image streams with sharp at the same limits (1600 px, quality 75, keep only if at most 90% of the original), then serialize everything with doc.save(). It handles JPEG and predictor-less Flate images only.",
  },
  {
    match: /Ghostscript WASM/,
    name: 'Ghostscript WASM, /ebook',
    text: "Ghostscript compiled to WebAssembly, as used by in-browser compressors: the input is copied into the in-memory file system and rewritten with pdfwrite's /ebook preset (150 dpi images).",
  },
  {
    match: /MuPDF/,
    name: 'MuPDF.js, lossless',
    text: 'MuPDF compiled to WebAssembly. Its JavaScript API has no image downsampling, so this is the best it offers: a lossless rewrite with garbage collection, deduplication and Flate for everything uncompressed.',
  },
  { match: /Ghostscript 10 native/, name: 'Ghostscript native, /ebook', text: 'The native gs binary with the same /ebook preset, as a reference point outside JavaScript.' },
  { match: /qpdf/, name: 'qpdf native, lossless', text: 'qpdf with --recompress-flate --compression-level=9 --object-streams=generate: a lossless native reference.' },
];

function findings(data: BenchData): string {
  const lean = data.rows.filter((r) => isLeanpdf(r) && r.status === 'ok');
  const items: string[] = [];
  if (lean.length) {
    const peaks = lean.map((r) => r.peakMb);
    const largest = Math.max(...data.rows.map((r) => r.inBytes));
    const onLargest = data.rows.filter((r) => r.inBytes === largest && !isLeanpdf(r) && !/native/i.test(r.tool) && r.status === 'ok').sort((a, b) => b.peakMb - a.peakMb);
    items.push(
      `<li><strong>Memory stays bounded.</strong> leanpdf peaked between ${fmtRss(Math.min(...peaks))} and ${fmtRss(Math.max(...peaks))} of RSS across all files, the ${fmtMb(largest)} one included.` +
        (onLargest.length ? ` On that file, the JavaScript and WebAssembly tools that load the whole document needed up to ${fmtRss(onLargest[0].peakMb)}.` : '') +
        '</li>',
    );
  }
  items.push(
    "<li><strong>Ghostscript makes the smallest files.</strong> Its /ebook preset downsamples images to 150 dpi and rewrites the entire document, at a lower PSNR. <code>large.pdf</code> repeats one photo on every page, and Ghostscript deduplicates identical images; leanpdf doesn't deduplicate.</li>",
    "<li><strong>Lossless tools barely shrink photos.</strong> MuPDF.js and qpdf don't touch image data, so photo-heavy files stay about the same size (or grow).</li>",
    '<li><strong>Native programs use far less memory.</strong> The native Ghostscript and qpdf binaries use far less memory than any JavaScript runtime; they are here as reference points, not as alternatives you can run in a browser.</li>',
  );
  return `<ul>${items.join('\n')}</ul>`;
}

function methodology(data: BenchData | null): string {
  const corpus = data?.corpus ?? new Map<string, string>();
  const labels = new Set(data?.rows.map((r) => r.tool) ?? []);
  const tools = TOOLS.filter((t) => !data || [...labels].some((l) => t.match.test(l)));
  return `<section class="methodology section" aria-labelledby="methodology">
<h2 id="methodology">Methodology</h2>
<p>The benchmark lives in <a href="${GITHUB_URL}/tree/main/bench" rel="noopener"><code>bench/</code></a>. Every tool runs in its own process; wall time is measured around it, and CPU time (user + system) and peak RSS come from the kernel's resource usage for that process. Outputs are checked with <code>qpdf --check</code>. For inputs under 200 MB, up to 60 pages of the output and of the original are rendered with MuPDF (72 dpi, grayscale) and compared as PSNR: higher means closer to the original, ∞ means pixel-identical.</p>
<p>All numbers come from one run on a single Linux container. Absolute times will differ on your machine.</p>
<h3>Tools</h3>
<dl>
${tools.map((t) => `<dt>${escapeHtml(t.name)}</dt><dd>${escapeHtml(t.text)}</dd>`).join('\n')}
</dl>
<h3>Corpus</h3>
<p>The documents are generated deterministically by <a href="${GITHUB_URL}/blob/main/bench/corpus.ts" rel="noopener"><code>bench/corpus.ts</code></a>, with photo-like images (fractal noise with the spectrum of natural photographs), so anyone can reproduce them.</p>
${corpus.size ? `<dl>${[...corpus].map(([f, d]) => `<dt><code>${escapeHtml(f)}</code></dt><dd>${escapeHtml(d.charAt(0).toUpperCase() + d.slice(1))}</dd>`).join('\n')}</dl>` : ''}
<h3>Reproduce</h3>
<p>You need Bun, Node, <code>qpdf</code> and Ghostscript (<code>gs</code>) on the <code>PATH</code>. The corpus is generated on the first run, about 700 MB in <code>bench/.corpus/</code>.</p>
${codeBlock(REPRODUCE, 'sh')}
</section>`;
}

export function benchmarksPage(assets: Assets, data: BenchData | null): string {
  const results = data
    ? `<section aria-labelledby="findings">
<h2 id="findings" class="visually-hidden">Findings</h2>
<div class="prose">${findings(data)}</div>
</section>
${data.files.map((f) => fileSection(data, f)).join('\n')}`
    : `<div class="notice" role="note" id="no-results"><p><strong>No benchmark results yet.</strong> This build found no <code>bench/results.json</code>. Run the benchmark (see <a href="#methodology">Methodology</a>) and commit the file to publish numbers here.</p></div>`;
  const body = `<div class="container">
<div class="page-head">
  <h1>Benchmarks</h1>
  <p>leanpdf next to other JavaScript PDF tools, plus two native programs for reference, on the same generated documents. For output size, memory and CPU time, shorter bars are better. leanpdf's bars and rows are highlighted.</p>
</div>
${results}
${methodology(data)}
</div>`;
  return page({
    path: '/benchmarks/',
    title: 'Benchmarks · leanpdf',
    description: 'Output size, peak memory and CPU time of leanpdf, pdf-lib, Ghostscript and MuPDF on generated test documents, including a 600 MB PDF.',
    body,
    assets,
    script: assets.siteJs,
  });
}
