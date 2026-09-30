/**
 * Local server for the site, applying the same _headers rules Cloudflare Pages will.
 *
 *   bun run site:dev        development: rebuilds in memory whenever a page is requested
 *   bun run site:preview    serves the built site/dist (run `bun run site:build` first)
 *   bun site/serve.ts --dist <dir>
 *
 * It mimics Pages' routing: /docs/ serves docs/index.html, /docs redirects to /docs/, unknown
 * paths get 404.html with status 404, and _headers is applied to every response (so the app
 * page is crossOriginIsolated, as in production).
 *
 * Env: PORT (default 5173), HOST (default 127.0.0.1).
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { buildSite, type SiteFiles } from './build.ts';
import { headersFor, parseHeaders, type HeaderRule } from './src/headers.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
};

/** Where the files come from: the dist directory, or an in-memory build. */
interface FileStore {
  get(path: string): Promise<Uint8Array | null>;
  headers(): Promise<HeaderRule[]>;
}

function dirStore(root: string): FileStore {
  return {
    async get(path) {
      const full = normalize(join(root, path));
      if (!full.startsWith(normalize(root)) || !existsSync(full) || !statSync(full).isFile()) return null;
      return new Uint8Array(await readFile(full));
    },
    async headers() {
      const p = join(root, '_headers');
      return existsSync(p) ? parseHeaders(await readFile(p, 'utf8')) : [];
    },
  };
}

/** Rebuilds on each page (HTML) request; assets come from the latest build or the one before. */
function devStore(): FileStore & { rebuild(): Promise<void> } {
  let current: SiteFiles = new Map();
  let previous: SiteFiles = new Map();
  let building: Promise<void> | null = null;
  let error: string | null = null;
  const store = {
    rebuild(): Promise<void> {
      building ??= buildSite({ dev: true })
        .then((files) => {
          previous = current;
          current = files;
          error = null;
        })
        .catch((e: unknown) => {
          error = e instanceof Error ? e.message : String(e);
          console.error(error);
        })
        .finally(() => {
          building = null;
        });
      return building;
    },
    async get(path: string) {
      if (error && path.endsWith('.html')) return new TextEncoder().encode(`<!doctype html><title>Build failed</title><pre>${Bun.escapeHTML(error)}</pre>`);
      return current.get(path) ?? previous.get(path) ?? null;
    },
    async headers() {
      const h = current.get('_headers');
      return h ? parseHeaders(new TextDecoder().decode(h)) : [];
    },
  };
  return store;
}

export interface SiteServer {
  url: string;
  stop(): Promise<void>;
}

export interface ServeOptions {
  /** Serve this built directory; omit for the development server. */
  dist?: string;
  port?: number;
  hostname?: string;
}

export async function startSiteServer(opts: ServeOptions = {}): Promise<SiteServer> {
  const dev = opts.dist ? null : devStore();
  const store: FileStore = dev ?? dirStore(opts.dist!);
  if (dev) await dev.rebuild();

  const respond = async (pathname: string, method: string): Promise<Response> => {
    const rules = await store.headers();
    const withHeaders = (body: Uint8Array | null, status: number, file: string, extra: Record<string, string> = {}): Response => {
      const h = headersFor(rules, pathname);
      h.set('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      for (const [k, v] of Object.entries(extra)) h.set(k, v);
      // Never let the browser cache development builds.
      if (dev) h.set('Cache-Control', 'no-store');
      return new Response(method === 'HEAD' ? null : (body as BodyInit | null), { status, headers: h });
    };
    let path = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (path === '_headers' || path.split('/').includes('..')) path = '\0';
    if (path === '' || path.endsWith('/')) path += 'index.html';
    if (dev && path.endsWith('.html')) await dev.rebuild();
    const body = await store.get(path);
    if (body) return withHeaders(body, 200, path);
    // Pages: /docs -> /docs/ when docs/index.html exists; /about -> about.html.
    if (!extname(path) && (await store.get(`${path}/index.html`))) {
      return withHeaders(null, 308, '.txt', { Location: `/${path}/` });
    }
    const html = !extname(path) ? await store.get(`${path}.html`) : null;
    if (html) return withHeaders(html, 200, '.html');
    return withHeaders(await store.get('404.html'), 404, '404.html');
  };

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 5173),
    hostname: opts.hostname ?? process.env.HOST ?? '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      return respond(new URL(req.url).pathname, req.method);
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}/`,
    // Graceful stop, bounded (see test/browser/harness.ts serveStatic).
    stop: () => Promise.race([server.stop(), new Promise<void>((r) => setTimeout(r, 3_000))]),
  };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--dist');
  const dist = i > 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('-') ? process.argv[i + 1] : new URL('./dist', import.meta.url).pathname) : undefined;
  if (dist && !existsSync(join(dist, 'index.html'))) {
    console.error(`${dist} has no index.html; run \`bun run site:build\` first.`);
    process.exit(1);
  }
  const s = await startSiteServer({ dist });
  console.log(`leanpdf site (${dist ? `serving ${dist}` : 'development, rebuilt on every page load'}): ${s.url}`);
}
