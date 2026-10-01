/**
 * The front page: the app (open a PDF, view it, work on it with the toolbox; site/src/app/main.ts),
 * and below it what leanpdf is, with numbers from the benchmark data and the build itself.
 */
import { GITHUB_URL, NPM_URL } from '../config.ts';
import { fmtMb, fmtRss, memoryHighlight, plainTool, savingsHighlight, type BenchData } from '../bench.ts';
import { codeBlock, escapeHtml } from '../highlight.ts';
import { arrowRight, feather, fileText, github, lock, minimize, pkg, scissors, shield, upload, waves } from './icons.ts';
import { page, type Assets } from './layout.ts';

export interface BundleSize {
  /** Minified bytes of a browser bundle that imports only compressPdfBlob. */
  min: number;
  /** Gzipped bytes. */
  gzip: number;
  /** The whole library (every export). */
  all: { min: number; gzip: number };
}

const BROWSER_EXAMPLE = `import { compressPdfBlob } from 'leanpdf';

// file: any File or Blob, e.g. from <input type="file">
const { blob, report } = await compressPdfBlob(file, {
  maxWidth: 1600,
  maxHeight: 1600,
  jpegQuality: 0.75,
});`;

const READ_EXAMPLE = `import { openPdf, getInfo, extractText } from 'leanpdf';

const doc = await openPdf(file);
const { title, pageCount } = await getInfo(doc);
for await (const { pageIndex, text } of extractText(doc)) {
  index(pageIndex, text); // one page at a time
}`;

const kb = (n: number): string => (n / 1024).toFixed(1);

function stats(bundle: BundleSize | null, bench: BenchData | null): string {
  const tiles: string[] = [];
  if (bundle) {
    tiles.push(`<div class="stat">
<dt>To compress in a browser</dt>
<dd class="value">${kb(bundle.gzip)}<small>KB gzipped</small></dd>
<dd class="note">${kb(bundle.min)} KB minified. The whole library is ${kb(bundle.all.gzip)} KB gzipped; you ship only what you import.</dd>
</div>`);
  }
  const mem = bench && memoryHighlight(bench);
  if (mem) {
    const others = mem.others
      .filter((r) => r.status === 'ok' && r.peakMb > mem.lean.peakMb && !/lossless/i.test(r.tool))
      .slice(0, 2)
      .map((r) => `${escapeHtml(plainTool(r.tool).replace(/[ ,(].*$/, ''))}: ${fmtRss(r.peakMb)}`);
    tiles.push(`<div class="stat">
<dt>Peak memory on a ${fmtMb(mem.inBytes)} PDF</dt>
<dd class="value">${Math.round(mem.lean.peakMb)}<small>MB RSS</small></dd>
<dd class="note">Including the runtime.${others.length ? ` ${others.join(', ')}.` : ''}</dd>
</div>`);
  } else {
    tiles.push(`<div class="stat">
<dt>Peak memory on a 600 MB PDF</dt>
<dd class="value">~270<small>MB RSS</small></dd>
<dd class="note">Including the runtime.</dd>
</div>`);
  }
  const save = bench && savingsHighlight(bench);
  if (save) {
    const pct = Math.round(100 * (1 - save.outBytes / save.inBytes));
    tiles.push(`<div class="stat">
<dt>Smaller, at default settings</dt>
<dd class="value">${pct}<small>%</small></dd>
<dd class="note"><code>${escapeHtml(save.file)}</code>: ${fmtMb(save.inBytes)} → ${fmtMb(save.outBytes)}.</dd>
</div>`);
  }
  return `<dl class="stats">${tiles.join('\n')}</dl>`;
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: waves, title: 'Streams', text: 'Reads in slices and writes in one pass. Memory stays flat, whatever the file size.' },
  { icon: minimize, title: 'Compresses', text: 'Downscales and re-encodes images, and keeps a result only when it is at least 10% smaller.' },
  { icon: fileText, title: 'Reads and renders', text: 'Metadata, bookmarks, form fields, attachments and text. Pages render to a canvas.' },
  { icon: scissors, title: 'Edits', text: 'Select, reorder and rotate pages, remove metadata or scripts, merge files, decrypt.' },
  { icon: feather, title: 'Small', text: 'No dependencies. It uses the browser’s own JPEG, zlib and canvas instead of bundling them.' },
  { icon: shield, title: 'Careful', text: 'Anything it doesn’t change is copied byte for byte. Damaged files are repaired as they are read.' },
];

export function homePage(assets: Assets, bench: BenchData | null, bundle: BundleSize | null): string {
  const body = `<div id="app" class="app" data-state="loading">
<section class="landing" id="landing" aria-labelledby="landing-title">
  <div class="container landing-inner">
    <h1 id="landing-title">View, compress and edit PDFs, <span class="accent">right in your browser</span></h1>
    <p class="lead">Powered by <strong>leanpdf</strong>, a small, streaming PDF toolkit. Large files are fine.</p>
    <label class="drop landing-drop">
      <input type="file" id="open-file" accept="application/pdf,.pdf">
      ${upload}
      <span class="drop-title">Open a PDF</span>
      <span class="small">or drop it anywhere on this page</span>
    </label>
    <p class="landing-sub"><span class="privacy">${lock}Nothing is uploaded: the file stays on this device.</span> <button type="button" class="link-button" id="open-sample">Try the sample PDF</button></p>
    <noscript><div class="notice"><p>The app needs JavaScript. The <a href="/docs/">library docs</a> work without it.</p></div></noscript>
  </div>
</section>
</div>

<section class="hero landing-more section-soft" aria-labelledby="code">
  <div class="container">
    <div>
      <span class="eyebrow">Open source · MIT</span>
      <h2 id="code">Use it in your code</h2>
      <p class="lead">leanpdf runs in browsers, Node and Bun. It compresses, reads, renders, edits, merges and decrypts PDFs without loading them into memory.</p>
      <div class="install" aria-label="Install command">
        <span class="prompt" aria-hidden="true">$</span><code id="install-cmd">npm install leanpdf</code>
      </div>
      <p class="small muted">In Node and the CLI, add <code>sharp</code> to compress and <code>@napi-rs/canvas</code> to render.</p>
      <div class="cta">
        <a class="button primary" href="/docs/">Read the docs ${arrowRight}</a>
        <a class="button" href="/benchmarks/">Benchmarks</a>
      </div>
    </div>
    <div class="hero-code">
      ${codeBlock(BROWSER_EXAMPLE, 'ts', 'Compress, in a browser or Web Worker')}
      ${codeBlock(READ_EXAMPLE, 'ts', 'Read, anywhere')}
    </div>
  </div>
</section>

<section class="section landing-more" aria-labelledby="numbers">
  <div class="container">
    <div class="section-head">
      <h2 id="numbers">In numbers</h2>
      <p>From this build and the <a href="/benchmarks/">benchmarks</a>.</p>
    </div>
    ${stats(bundle, bench)}
  </div>
</section>

<section class="section landing-more" aria-labelledby="features">
  <div class="container">
    <div class="section-head">
      <h2 id="features">Features</h2>
      
    </div>
    <ul class="features">
      ${FEATURES.map((f) => `<li class="feature"><h3>${f.icon}${escapeHtml(f.title)}</h3><p>${escapeHtml(f.text)}</p></li>`).join('\n      ')}
    </ul>
  </div>
</section>

<section class="section section-soft landing-more" aria-labelledby="how">
  <div class="container">
    <div class="section-head">
      <h2 id="how">How it works</h2>
      
    </div>
    <ol class="steps">
      <li><h3>Index</h3><p>Read the cross-reference table into typed arrays, rebuilding it if it’s damaged.</p></li>
      <li><h3>Scan</h3><p>Read each object’s dictionary, not its data.</p></li>
      <li><h3>Write</h3><p>Copy unchanged objects as byte ranges and write only what changed.</p></li>
    </ol>
  </div>
</section>

<section class="section landing-more" aria-labelledby="limits">
  <div class="container split">
    <div>
      <h2 id="limits">Limits</h2>
      
      <ul class="limits">
        <li>Encrypted PDFs must be decrypted first.</li>
        <li>Rewriting a signed PDF invalidates its signatures.</li>
        <li>CMYK, indexed and spot-color images, JBIG2 and fax images aren’t recompressed.</li>
        <li>Text comes out in drawing order; no OCR.</li>
        <li>JBIG2 images aren’t rendered yet.</li>
      </ul>
      <p><a href="/docs/#known-limitations">All known limitations</a></p>
    </div>
    <div>
      <h2>Get it</h2>
      
      <div class="cta">
        <a class="button" href="${NPM_URL}" rel="noopener">${pkg} npm</a>
        <a class="button" href="${GITHUB_URL}" rel="noopener">${github} GitHub</a>
      </div>
    </div>
  </div>
</section>`;
  return page({
    path: '/',
    title: 'leanpdf · PDF tools in your browser',
    description:
      'View, compress, edit, merge and unlock PDFs in your browser, with nothing uploaded. Powered by leanpdf, a small streaming PDF toolkit for browsers, Node and Bun.',
    body,
    assets,
    script: [assets.appJs, assets.siteJs],
  });
}
