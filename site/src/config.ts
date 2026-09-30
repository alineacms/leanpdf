/** Site-wide constants, used at build time. */

export const REPO = 'benmerckx/leanpdf';
export const GITHUB_URL = `https://github.com/${REPO}`;
export const NPM_URL = 'https://www.npmjs.com/package/leanpdf';

/**
 * Public origin of the deployed site, for canonical links and Open Graph tags. Cloudflare Pages
 * serves a project called `leanpdf` at https://leanpdf.pages.dev; set SITE_URL when building for
 * a custom domain.
 */
export const SITE_URL = (process.env.SITE_URL ?? 'https://leanpdf.pages.dev').replace(/\/+$/, '');

/** Repository root, relative to this file. */
export const ROOT = new URL('../../', import.meta.url).pathname;
