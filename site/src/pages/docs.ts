/** Docs page: README.md rendered at build time, with a table of contents. */
import { readFileSync } from 'node:fs';
import { GITHUB_URL, ROOT, SITE_URL } from '../config.ts';
import { escapeHtml } from '../highlight.ts';
import { renderMarkdown, type Heading } from '../markdown.ts';
import { page, type Assets } from './layout.ts';

/** README sections (by heading text) left out: repository maintenance, and what the site has its own page for. */
const EXCLUDE = new Set(['Releasing', 'Benchmarks']);

/** Links to excluded README sections that the site has a page for. */
const SECTION_PAGES: Record<string, string> = { '#benchmarks': '/benchmarks/' };

export interface Docs {
  html: string;
  headings: Heading[];
}

/**
 * Prepare README Markdown for the docs page: drop the title, name the introduction "Overview",
 * and leave out excluded sections.
 */
export function docsMarkdown(readme: string): string {
  const lines = readme.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let skipLevel = 0;
  let inFence = false;
  let sawTitle = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 1 && !sawTitle) {
        sawTitle = true;
        out.push('## Overview');
        continue;
      }
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && EXCLUDE.has(h[2].replace(/`/g, ''))) skipLevel = level;
    }
    if (!skipLevel) out.push(line);
  }
  return out.join('\n');
}

export function resolveReadmeLink(href: string): string {
  if (Object.hasOwn(SECTION_PAGES, href)) return SECTION_PAGES[href];
  if (href.startsWith(SITE_URL)) return href.slice(SITE_URL.length) || '/';
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  // Relative links in the README point into the repository.
  return `${GITHUB_URL}/blob/main/${href.replace(/^\.\//, '')}`;
}

export function renderDocs(readme: string): Docs {
  return renderMarkdown(docsMarkdown(readme), { resolveLink: resolveReadmeLink });
}

function toc(headings: Heading[]): string {
  let html = '<ol>';
  let open = false;
  for (const h of headings) {
    if (h.level === 2) {
      if (open) html += '</ol></li>';
      html += `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a><ol>`;
      open = true;
    } else if (h.level === 3 && open) {
      html += `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text.replace(/\(.*\)(: .*)?$/, '()'))}</a></li>`;
    }
  }
  if (open) html += '</ol></li>';
  return `${html.replace(/<ol><\/ol>/g, '')}</ol>`;
}

export function docsPage(assets: Assets, readme = readFileSync(`${ROOT}README.md`, 'utf8')): string {
  const docs = renderDocs(readme);
  const body = `<div class="container">
<div class="page-head">
  <h1>Documentation</h1>
  <p>Install, usage and the complete API. This page is generated from the project's README at build time.</p>
</div>
<div class="docs-layout">
  <nav class="toc" aria-label="On this page">
    <details open>
      <summary>On this page</summary>
      ${toc(docs.headings)}
    </details>
  </nav>
  <article class="prose">
${docs.html}
    <p class="edit-link muted">Something unclear or missing? <a href="${GITHUB_URL}/blob/main/README.md" rel="noopener">Edit the README on GitHub</a> or <a href="${GITHUB_URL}/issues" rel="noopener">open an issue</a>.</p>
  </article>
</div>
</div>`;
  return page({
    path: '/docs/',
    title: 'Documentation · leanpdf',
    description: 'How to install and use leanpdf in the browser, Node and Bun: compressPdf, compressPdfBlob, I/O adapters, codecs, and what gets recompressed.',
    body,
    assets,
    script: assets.siteJs,
  });
}
