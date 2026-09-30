/** Home page: what leanpdf is, with numbers taken from the benchmark data and the build itself. */
import { GITHUB_URL, NPM_URL } from '../config.ts';
import { fmtMb, fmtRss, memoryHighlight, plainTool, savingsHighlight, type BenchData } from '../bench.ts';
import { codeBlock, escapeHtml } from '../highlight.ts';
import { arrowRight, book, feather, github, globe, pkg, puzzle, shield, waves } from './icons.ts';
import { page, type Assets } from './layout.ts';

export interface BundleSize {
  /** Minified bytes of the browser entry (src/index.ts). */
  min: number;
  /** Gzipped bytes. */
  gzip: number;
}

const BROWSER_EXAMPLE = `import { compressPdfBlob } from 'leanpdf';

// file: any File or Blob, e.g. from <input type="file">
const { blob, report } = await compressPdfBlob(file, {
  maxWidth: 1600,
  maxHeight: 1600,
  jpegQuality: 0.75,
});`;

const NODE_EXAMPLE = `import { compressPdfFile } from 'leanpdf/node';
import { SharpImageCodec } from 'leanpdf/sharp';

const report = await compressPdfFile('in.pdf', 'out.pdf', {
  codec: new SharpImageCodec(),
});`;

const kb = (n: number): string => (n / 1024).toFixed(1);

function stats(bundle: BundleSize | null, bench: BenchData | null): string {
  const tiles: string[] = [];
  if (bundle) {
    tiles.push(`<div class="stat">
<dt>Browser bundle</dt>
<dd class="value">${kb(bundle.gzip)}<small>KB gzipped</small></dd>
<dd class="note">The browser entry is ${kb(bundle.min)} KB minified, with zero runtime dependencies (measured when this site was built).</dd>
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
    icon: feather,
    title: 'Small',
    text: 'No bundled JPEG, PNG or zlib code. In the browser it uses createImageBitmap, OffscreenCanvas, CompressionStream and DecompressionStream.',
  },
  {
    icon: shield,
    title: 'Byte-for-byte passthrough',
    text: 'Unchanged objects are copied verbatim, and anything unusual is left alone. An image is only replaced when the new stream is at least 10% smaller.',
  },
  {
    icon: puzzle,
    title: 'Pluggable codecs',
    text: 'Decoding, resizing and encoding go through an ImageCodec. It ships one built on browser primitives (works in Web Workers) and one built on sharp for servers.',
  },
  {
    icon: globe,
    title: 'Browsers, Node and Bun',
    text: 'ESM only. The core runs in any modern browser, Node 18.17+ and Bun, and there is a CLI: leanpdf compress in.pdf out.pdf.',
  },
  {
    icon: book,
    title: 'A detailed report',
    text: 'Every run reports sizes, images recompressed, images skipped and why, repaired cross-reference tables, and invalidated signatures.',
  },
];

export function homePage(assets: Assets, bench: BenchData | null, bundle: BundleSize | null): string {
  const body = `<section class="hero">
  <div class="container">
    <div>
      <span class="eyebrow">Open source · MIT</span>
      <h1>Lean PDFs, <span class="accent">streamed</span>.</h1>
      <p class="lead"><strong>leanpdf</strong> is a small, low-memory, streaming PDF library for browsers, Node and Bun. It makes PDFs smaller by recompressing and downscaling their embedded images, and copies everything else byte for byte.</p>
      <div class="cta">
        <a class="button primary" href="/app/">Compress a PDF ${arrowRight}</a>
        <a class="button" href="/docs/">Read the docs</a>
      </div>
      <div class="install" aria-label="Install command">
        <span class="prompt" aria-hidden="true">$</span><code id="install-cmd">npm install leanpdf</code>
      </div>
      <p class="small muted">Or <code>bun add leanpdf</code>. Add <code>sharp</code> for the Node codec and the CLI.</p>
    </div>
    <div class="hero-code">
      ${codeBlock(BROWSER_EXAMPLE, 'ts', 'Browser or Web Worker')}
      ${codeBlock(NODE_EXAMPLE, 'ts', 'Node and Bun')}
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
      <p>It currently does one job, recompressing images, and does it without holding the document in memory.</p>
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
      <p>Three stages, none of which loads the file whole. The <a href="/docs/#how-it-works">docs</a> have the details.</p>
    </div>
    <ol class="steps">
      <li><h3>Index</h3><p>Follow the cross-reference chain (tables, streams, hybrid files and incremental updates) into typed arrays. Damaged indexes are rebuilt by scanning.</p></li>
      <li><h3>Scan headers</h3><p>Read only each object's dictionary, to find soft masks, signatures, old cross-reference streams and stale linearization data.</p></li>
      <li><h3>Write once</h3><p>Copy unchanged objects as byte ranges, recompress image candidates through the codec, then write a fresh cross-reference section.</p></li>
    </ol>
  </div>
</section>

<section class="section" aria-labelledby="limits">
  <div class="container split">
    <div>
      <h2 id="limits">Know the limits</h2>
      <p>leanpdf changes images and nothing else, and it refuses what it can't do safely.</p>
      <ul class="limits">
        <li>Encrypted PDFs are refused.</li>
        <li>Signed PDFs are processed, but rewriting invalidates the signatures (the report says so).</li>
        <li>CMYK, indexed and spot-colour images, JPEG 2000, JBIG2 and CCITT, and inline images are left as they are.</li>
        <li>No deduplication or font subsetting, and linearization is lost.</li>
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
    title: 'leanpdf · small, streaming PDF library for browsers, Node and Bun',
    description:
      'leanpdf makes PDFs smaller by recompressing and downscaling their images, streaming with bounded memory and copying everything else byte for byte. Runs in browsers, Node and Bun.',
    body,
    assets,
    script: assets.siteJs,
  });
}
