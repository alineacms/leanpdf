/** The HTML document shell shared by every page: head, header with navigation, footer. */
import { GITHUB_URL, NPM_URL, SITE_URL } from '../config.ts';
import { escapeHtml } from '../highlight.ts';
import { github } from './icons.ts';

/** URLs of the built, content-hashed assets. */
export interface Assets {
  css: string;
  /** Progressive enhancements for the content pages (copy buttons, table-of-contents highlight). */
  siteJs: string;
  /** The app page's script. */
  appJs: string;
  /** Present when the PNG icons could be rendered. */
  png: boolean;
}

export interface PageOptions {
  /** URL path of the page, e.g. "/docs/". */
  path: string;
  title: string;
  description: string;
  /** Contents of <main>. */
  body: string;
  assets: Assets;
  /** Page script (a module), if any. */
  script?: string;
  noindex?: boolean;
}

const NAV: { href: string; label: string }[] = [
  { href: '/app/', label: 'App' },
  { href: '/docs/', label: 'Docs' },
  { href: '/benchmarks/', label: 'Benchmarks' },
];

export function page(o: PageOptions): string {
  const e = escapeHtml;
  const url = SITE_URL + o.path;
  const nav = NAV.map((n) => {
    const current = o.path === n.href ? ' aria-current="page"' : '';
    return `<li><a href="${n.href}"${current}>${n.label}</a></li>`;
  }).join('');
  const og = o.assets.png
    ? `<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="leanpdf: a small, low-memory, streaming PDF library">
<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="twitter:card" content="summary">';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(o.title)}</title>
<meta name="description" content="${e(o.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${e(url)}">`}
${o.assets.png ? '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">\n' : ''}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${o.assets.png ? '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' : ''}<link rel="stylesheet" href="${o.assets.css}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="leanpdf">
<meta property="og:title" content="${e(o.title)}">
<meta property="og:description" content="${e(o.description)}">
<meta property="og:url" content="${e(url)}">
${og}
${o.script ? `<script type="module" src="${o.script}"></script>` : ''}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container">
    <a class="brand" href="/"${o.path === '/' ? ' aria-current="page"' : ''}><img src="/favicon.svg" alt="" width="30" height="30">leanpdf</a>
    <nav class="site-nav" aria-label="Main">
      <ul>${nav}<li><a href="${GITHUB_URL}" rel="noopener">${github}<span>GitHub</span></a></li></ul>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
${o.body}
</main>
<footer class="site-footer">
  <div class="container">
    <p>leanpdf is open source under the MIT license.</p>
    <ul>
      <li><a href="${GITHUB_URL}" rel="noopener">GitHub</a></li>
      <li><a href="${NPM_URL}" rel="noopener">npm</a></li>
      <li><a href="${GITHUB_URL}/issues" rel="noopener">Issues</a></li>
      <li><a href="/docs/">Docs</a></li>
    </ul>
  </div>
</footer>
</body>
</html>
`;
}
