/**
 * The app page shell. The tools themselves (tabs and panels) are rendered by the page script,
 * site/src/app/main.ts, from the registry in site/src/app/tools.ts.
 */
import { lock } from './icons.ts';
import { page, type Assets } from './layout.ts';

export function appPage(assets: Assets): string {
  const body = `<div class="container">
<div class="app-head">
  <h1>PDF tools in your browser</h1>
  <p>Powered by leanpdf, running in a Web Worker on this page. Large files are fine: the PDF is read in slices and written as a stream.</p>
  <p class="privacy">${lock}Your files never leave this device. Nothing is uploaded.</p>
</div>
<div id="app" class="app" data-state="loading">
  <noscript><div class="notice"><p>The tools need JavaScript. The <a href="/docs/">library docs</a> work without it.</p></div></noscript>
</div>
<section class="card memory" id="memory" aria-labelledby="memory-heading">
  <h2 id="memory-heading">Memory</h2>
  <p class="muted small" id="memory-status">Measuring…</p>
</section>
</div>`;
  return page({
    path: '/app/',
    title: 'PDF tools in your browser · leanpdf',
    description: 'Compress, inspect, extract text from, edit, merge and unlock PDFs entirely in your browser. Large files stream to disk; nothing is uploaded.',
    body,
    assets,
    script: assets.appJs,
  });
}
