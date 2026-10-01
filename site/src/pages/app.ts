/** /app/ moved to the front page; this page sends old links there. */
import { page, type Assets } from './layout.ts';

export function appPage(assets: Assets): string {
  return page({
    path: '/app/',
    title: 'leanpdf',
    description: 'The leanpdf app is on the front page.',
    body: '<div class="container section"><p>The app is on the <a href="/">front page</a> now.</p></div>',
    assets,
    noindex: true,
    head: '<meta http-equiv="refresh" content="0; url=/">',
  });
}
