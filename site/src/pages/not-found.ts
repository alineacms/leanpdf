/** 404 page. Cloudflare Pages serves /404.html, with status 404, for any path that has no file. */
import { page, type Assets } from './layout.ts';

export function notFoundPage(assets: Assets): string {
  const body = `<div class="container not-found">
  <h1>Page not found</h1>
  <p class="lead">There is nothing at this address. Maybe one of these?</p>
  <div class="cta">
    <a class="button primary" href="/app/">Compress a PDF</a>
    <a class="button" href="/docs/">Docs</a>
    <a class="button" href="/">Home</a>
  </div>
</div>`;
  return page({ path: '/404.html', title: 'Page not found · leanpdf', description: 'This page does not exist.', body, assets, noindex: true });
}
