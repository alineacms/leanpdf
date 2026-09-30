/** Home page: what leanpdf is, with numbers taken from the benchmark data and the build itself. */
import { GITHUB_URL, NPM_URL } from '../config.ts';
import { fmtMb, fmtRss, memoryHighlight, plainTool, savingsHighlight, type BenchData } from '../bench.ts';
import { codeBlock, escapeHtml } from '../highlight.ts';
import { arrowRight, feather, fileText, github, minimize, pkg, scissors, shield, waves } from './icons.ts';
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
<dd class="note">compressPdfBlob with the browser codec, ${kb(bundle.min)} KB minified. Everything together is ${kb(bundle.all.gzip)} KB gzipped, and bundlers keep only what you import. Zero dependencies; measured when this site was built.</dd>
</div>`);
  }
  const mem = bench && memoryHighlight(bench);
  if (mem) {
    const others = mem.others
      .filter((r) => r.status === 'ok' && r.peakMb > mem.lean.peakMb && !/lossless/i.test(r.tool))
      .slice(0, 2)
      .map((r) => `${escapeHtml(plainTool(r.tool).replace(/ \(Node\)$/, ''))} peaked at ${fmtRss(r.peakMb)}`);
    tiles.push(`<div class="stat">
<dt>Peak memory on a ${fmtMb(mem.inBytes)} PDF</dt>
<dd class="value">${Math.round(mem.lean.peakMb)}<small>MB RSS</small></dd>
<dd class="note">${escapeHtml(plainTool(mem.lean.tool))}, including the runtime and libvips.${others.length ? ` On the same file, ${others.join(' and ')}.` : ''}</dd>
</div>`);
  } else {
    tiles.push(`<div class="stat">
<dt>Peak memory on a 600 MB PDF</dt>
<dd class="value">~270<small>MB RSS</small></dd>
<dd class="note">Roughly one decoded image plus the cross-reference index, whatever the file size. Most of it is the runtime and libvips.</dd>
</div>`);
  }
  const save = bench && savingsHighlight(bench);
  if (save) {
    const pct = Math.round(100 * (1 - save.outBytes / save.inBytes));
    tiles.push(`<div class="stat">
<dt>Smaller, at default settings</dt>
<dd class="value">${pct}<small>%</small></dd>
<dd class="note"><code>${escapeHtml(save.file)}</code> from the benchmark corpus: ${fmtMb(save.inBytes)} → ${fmtMb(save.outBytes)}, with images capped at 1600 px and JPEG quality 0.75.</dd>
</div>`);
  }
  return `<dl class="stats">${tiles.join('\n')}</dl>`;
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  {
    icon: waves,
    title: 'Streams',
    text: 'Reads the input with bounded random access and writes the output in one forward pass. Peak memory is roughly one decoded image plus the cross-reference index (13 bytes per object).',
  },
  {
    icon: minimize,
    title: 'Shrinks images',
    text: 'Downscales and re-encodes photos, scans and their transparency masks through a pluggable codec: browser primitives (Web Workers too) or sharp on servers. An image is only replaced when the result is at least 10% smaller.',
  },
  {
    icon: fileText,
    title: 'Reads',
    text: 'Metadata, page sizes, bookmarks, links, form fields, attachments and images, and text page by page for search indexing. Attachments and images stream out without loading the document.',
  },
  {
    icon: scissors,
    title: 'Edits, merges, decrypts',
    text: 'Plugins remove metadata, JavaScript, attachments and unused objects, select, reorder and rotate pages, and repair streams, all in the same single pass. Merging and decryption stream too.',
  },
  {
    icon: feather,
    title: 'Small and tree-shakeable',
    text: 'Every feature is its own module. No bundled JPEG, PNG or zlib code: in the browser it uses createImageBitmap, OffscreenCanvas, CompressionStream and DecompressionStream.',
  },
  {
    icon: shield,
    title: 'Byte-for-byte passthrough',
    text: 'Whatever a rewrite does not change is copied verbatim, and anything unusual is left alone. Damaged files are repaired as they are read. ESM only: browsers, Node 18.17+, Bun, and a CLI.',
  },
];

export function homePage(assets: Assets, bench: BenchData | null, bundle: BundleSize | null): string {
  const body = `<section class="hero">
  <div class="container">
    <div>
      <span class="eyebrow">Open source · MIT</span>
      <h1>Lean PDFs, <span class="accent">streamed</span>.</h1>
      <p class="lead"><strong>leanpdf</strong> is a small, low-memory, streaming PDF toolkit for browsers, Node and Bun. It makes PDFs smaller by recompressing their images, reads their text and metadata, and edits, merges and decrypts them, copying whatever it doesn't change byte for byte.</p>
      <div class="cta">
        <a class="button primary" href="/app/">Try it in your browser ${arrowRight}</a>
        <a class="button" href="/docs/">Read the docs</a>
      </div>
      <div class="install" aria-label="Install command">
        <span class="prompt" aria-hidden="true">$</span><code id="install-cmd">npm install leanpdf</code>
      </div>
      <p class="small muted">Or <code>bun add leanpdf</code>. Add <code>sharp</code> for the Node codec and the CLI.</p>
    </div>
    <div class="hero-code">
      ${codeBlock(BROWSER_EXAMPLE, 'ts', 'Compress, in a browser or Web Worker')}
      ${codeBlock(READ_EXAMPLE, 'ts', 'Read, anywhere')}
    </div>
  </div>
</section>

<section class="section section-soft" aria-labelledby="numbers">
  <div class="container">
    <div class="section-head">
      <h2 id="numbers">Small, and stays small</h2>
      <p>Numbers from this build and from the <a href="/benchmarks/">benchmarks</a>, where leanpdf runs next to pdf-lib, Ghostscript and MuPDF on the same files.</p>
    </div>
    ${stats(bundle, bench)}
  </div>
</section>

<section class="section" aria-labelledby="features">
  <div class="container">
    <div class="section-head">
      <h2 id="features">What you get</h2>
      <p>Everything works on documents of any size without holding them in memory, and you ship only the parts you use.</p>
    </div>
    <ul class="features">
      ${FEATURES.map((f) => `<li class="feature"><h3>${f.icon}${escapeHtml(f.title)}</h3><p>${escapeHtml(f.text)}</p></li>`).join('\n      ')}
    </ul>
  </div>
</section>

<section class="section section-soft" aria-labelledby="how">
  <div class="container">
    <div class="section-head">
      <h2 id="how">How it works</h2>
      <p>Every write is the same three stages, none of which loads the file whole. The <a href="/docs/#how-it-works">docs</a> have the details.</p>
    </div>
    <ol class="steps">
      <li><h3>Index</h3><p>Follow the cross-reference chain (tables, streams, hybrid files and incremental updates) into typed arrays. Damaged indexes are rebuilt by scanning.</p></li>
      <li><h3>Scan headers</h3><p>Read only each object's dictionary, to find soft masks, signatures, old cross-reference streams and stale linearization data.</p></li>
      <li><h3>Write once</h3><p>Copy unchanged objects as byte ranges, write what the plugins changed (recompressed images, edited dictionaries, decrypted streams), then a fresh cross-reference section.</p></li>
    </ol>
  </div>
</section>

<section class="section" aria-labelledby="limits">
  <div class="container split">
    <div>
      <h2 id="limits">Know the limits</h2>
      <p>leanpdf changes only what you ask for, and refuses what it can't do safely.</p>
      <ul class="limits">
        <li>Encrypted PDFs have to be decrypted first, with the password when they need one. Public-key encryption isn't supported.</li>
        <li>Signed PDFs are processed, but rewriting invalidates the signatures (the report says so).</li>
        <li>CMYK, indexed and spot-colour images, JPEG 2000, JBIG2 and CCITT, and inline images are not recompressed.</li>
        <li>Text comes out in drawing order: no column detection, right-to-left reordering or OCR.</li>
        <li>No rendering, deduplication or font subsetting, and linearization is lost.</li>
      </ul>
      <p><a href="/docs/#known-limitations">All known limitations</a></p>
    </div>
    <div>
      <h2>Get it</h2>
      <p>Published on npm as <code>leanpdf</code>, developed on GitHub.</p>
      <div class="cta">
        <a class="button" href="${NPM_URL}" rel="noopener">${pkg} npm</a>
        <a class="button" href="${GITHUB_URL}" rel="noopener">${github} GitHub</a>
      </div>
    </div>
  </div>
</section>`;
  return page({
    path: '/',
    title: 'leanpdf · small, streaming PDF toolkit for browsers, Node and Bun',
    description:
      'leanpdf compresses, reads, edits, merges and decrypts PDFs with bounded memory, copying everything it does not change byte for byte. Tree-shakeable, zero dependencies; runs in browsers, Node and Bun.',
    body,
    assets,
    script: assets.siteJs,
  });
}
