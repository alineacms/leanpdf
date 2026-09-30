/**
 * Shared plumbing for tests that drive headless Chromium: locating and launching the browser,
 * bundling browser code with Bun.build, and a tiny static server (Web Workers need a real URL).
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

const PREINSTALLED = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
];

/** $CHROMIUM_PATH, else a pre-installed Chromium, else undefined (playwright-core's default). */
export function chromiumPath(): string | undefined {
  const env = process.env.CHROMIUM_PATH;
  if (env) return env;
  return PREINSTALLED.find((p) => existsSync(p));
}

export interface Chromium {
  browser: Browser;
  /** Release this file's hold on the shared browser (see launchChromium). Safe to call twice. */
  close(): Promise<void>;
}

export type Launch = ({ skip?: undefined } & Chromium) | { browser?: undefined; close?: undefined; skip: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Flags for every test browser. ForceEagerMeasureMemory makes measureUserAgentSpecificMemory()
 * answer immediately instead of at the next GC (10-20 s), which the demo test relies on.
 */
const ARGS = ['--enable-blink-features=ForceEagerMeasureMemory'];

interface Shared {
  launch: Promise<{ browser: Browser } | { error: string }>;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
}
let shared: Shared | undefined;

async function start(): Promise<{ browser: Browser } | { error: string }> {
  try {
    return { browser: await chromium.launch({ executablePath: chromiumPath(), headless: true, timeout: 30_000, args: ARGS }) };
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).split('\n')[0] };
  }
}

async function shutdown(s: Shared): Promise<void> {
  if (shared === s) shared = undefined;
  const r = await s.launch;
  if ('browser' in r) await Promise.race([r.browser.close().catch(() => {}), sleep(5_000)]);
}

/**
 * Get headless Chromium. Never throws: when no browser can be started the result carries a skip
 * reason, which callers report and turn into skipped tests.
 *
 * One browser is shared by all test files in a `bun test` process, and each file releases it in
 * afterAll with `close()` (which closes that file's pages and contexts); the last release closes
 * the browser after a short grace period, in case the next file is about to acquire it.
 * Launching a fresh Chromium per file was unreliable under Bun 1.3: after the first browser closed, a later `browser.close()` never resolved, and the
 * listening socket of a Bun.serve started after it was intermittently torn down (Chromium got
 * ERR_CONNECTION_REFUSED), which looks like a stale file descriptor being closed twice.
 */
export async function launchChromium(label: string): Promise<Launch> {
  const s = shared ?? (shared = { launch: start(), users: 0 });
  if (s.timer) clearTimeout(s.timer);
  s.timer = undefined;
  s.users++;
  const r = await s.launch;
  if ('error' in r) {
    s.users--;
    if (shared === s) shared = undefined;
    const skip =
      `${label}: SKIPPED, could not launch Chromium (${chromiumPath() ?? 'playwright-core default'}): ${r.error}. ` +
      'Set CHROMIUM_PATH or run `bunx playwright-core install chromium`.';
    console.warn(skip);
    return { skip };
  }
  let released = false;
  const close = async (): Promise<void> => {
    if (released) return;
    released = true;
    for (const c of r.browser.contexts()) await c.close().catch(() => {});
    if (--s.users > 0) return;
    // Close after a grace period unless another test file acquires the browser first. The timer
    // is unref'd so it never keeps the process alive; playwright-core kills its browsers on exit.
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (s.users === 0) void shutdown(s);
    }, 2_000);
    (s.timer as { unref?: () => void }).unref?.();
  };
  return { browser: r.browser, close };
}

/** Bundle one browser entry point into a single ESM file. */
export async function bundle(entry: string, opts: { minify?: boolean } = {}): Promise<string> {
  const r = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: opts.minify ?? false });
  if (!r.success) throw new AggregateError(r.logs, `Bun.build failed for ${entry}`);
  return r.outputs[0].text();
}

export type Asset = { body: string | Uint8Array | Blob; type: string };

export interface StaticServer {
  url: string;
  /** Bodies POSTed to /upload/<name>, by name. */
  uploads: Map<string, Uint8Array>;
  close(): Promise<void>;
}

/** Serve fixed assets on 127.0.0.1 with a random port. POST /upload/<name> stores the body. */
export function serveStatic(assets: Record<string, Asset>, headers: Record<string, string> = {}): StaticServer {
  const uploads = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'POST' && path.startsWith('/upload/')) {
        uploads.set(decodeURIComponent(path.slice(8)), new Uint8Array(await req.arrayBuffer()));
        return new Response('ok', { headers });
      }
      const a = assets[path];
      if (!a) return new Response('not found', { status: 404, headers });
      return new Response(a.body as BodyInit, { headers: { 'content-type': a.type, 'cache-control': 'no-store', ...headers } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    uploads,
    // Graceful stop (bounded): with stop(true), Bun 1.3 sometimes tears down the listener of a
    // server started later in the same process, which then refuses connections.
    close: () => Promise.race([server.stop(), sleep(3_000)]),
  };
}

export const HTML = (body = ''): Asset => ({
  body: `<!doctype html><html><head><meta charset="utf-8"><title>test</title></head><body>${body}</body></html>`,
  type: 'text/html; charset=utf-8',
});

export const JS = (code: string): Asset => ({ body: code, type: 'text/javascript; charset=utf-8' });

// ---------------------------------------------------------------------------------------------
// qpdf

export interface QpdfResult {
  code: number;
  output: string;
}

/** `qpdf --check`; exit code 0 means no errors and no warnings. */
export function qpdfCheck(path: string): QpdfResult {
  const p = Bun.spawnSync(['qpdf', '--check', path], { stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode ?? -1, output: `${p.stdout.toString()}${p.stderr.toString()}` };
}

export function qpdfPageCount(path: string): number {
  const p = Bun.spawnSync(['qpdf', '--show-npages', path], { stdout: 'pipe', stderr: 'pipe' });
  return Number(p.stdout.toString().trim());
}

/** Stream dictionaries of all image XObjects, by object number (qpdf JSON v2). */
export function qpdfImages(path: string): Map<number, Record<string, unknown>> {
  const p = Bun.spawnSync(['qpdf', '--json=2', '--json-key=qpdf', path], { stdout: 'pipe', stderr: 'pipe' });
  const json = JSON.parse(p.stdout.toString()) as { qpdf: [unknown, Record<string, { stream?: { dict: Record<string, unknown> } }>] };
  const out = new Map<number, Record<string, unknown>>();
  for (const [key, o] of Object.entries(json.qpdf[1])) {
    const m = /^obj:(\d+) 0 R$/.exec(key);
    if (m && o.stream?.dict['/Subtype'] === '/Image') out.set(Number(m[1]), o.stream.dict);
  }
  return out;
}

/** The raw (still encoded) data of a stream object. */
export function qpdfRawStream(path: string, num: number): Uint8Array {
  const p = Bun.spawnSync(['qpdf', `--show-object=${num}`, '--raw-stream-data', path], { stdout: 'pipe', stderr: 'pipe' });
  return new Uint8Array(p.stdout);
}

export const hasQpdf = Bun.which('qpdf') !== null;
