/**
 * Demo server: `bun demo/serve.ts` (or `bun run demo`), then open the printed URL.
 *
 * Bundles demo/main.ts and demo/worker.ts with Bun.build on every request (so edits show up on
 * reload) and serves everything with COOP/COEP headers, which makes the page crossOriginIsolated
 * and enables performance.measureUserAgentSpecificMemory().
 *
 * Env: PORT (default 5173), HOST (default 127.0.0.1).
 */
const here = (p: string): string => new URL(p, import.meta.url).pathname;

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const ENTRIES: Record<string, string> = {
  '/main.js': here('./main.ts'),
  '/worker.js': here('./worker.ts'),
};

async function build(entry: string): Promise<Response> {
  const r = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', sourcemap: 'inline' });
  if (!r.success) {
    const msg = r.logs.map(String).join('\n');
    console.error(msg);
    return new Response(`console.error(${JSON.stringify(`build failed:\n${msg}`)});`, {
      status: 500,
      headers: { ...ISOLATION_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' },
    });
  }
  return new Response(await r.outputs[0].text(), { headers: { ...ISOLATION_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' } });
}

export interface DemoServer {
  url: string;
  stop(): Promise<void>;
}

export function startDemoServer(opts: { port?: number; hostname?: string } = {}): DemoServer {
  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 5173),
    hostname: opts.hostname ?? process.env.HOST ?? '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/' || path === '/index.html') {
        return new Response(Bun.file(here('./index.html')), { headers: { ...ISOLATION_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      const entry = ENTRIES[path];
      if (entry) return build(entry);
      return new Response('Not found', { status: 404, headers: ISOLATION_HEADERS });
    },
  });
  return { url: `http://${server.hostname}:${server.port}/`, stop: () => server.stop() }; // graceful: see test/browser/harness.ts serveStatic
}

if (import.meta.main) {
  const s = startDemoServer();
  console.log(`pdf-squeeze demo: ${s.url}`);
}
