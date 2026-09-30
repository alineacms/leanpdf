/**
 * Build a self-contained demo: one HTML file with the page script and the worker inlined (the
 * worker starts from a Blob URL). It works from file://, any static host, or a sandboxed preview.
 *
 *   bun run demo:build   ->  demo/dist/index.html
 *
 * Without COOP/COEP headers the page is not crossOriginIsolated, so peak-memory reporting falls
 * back to performance.memory where the browser has it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const here = (p: string): string => new URL(p, import.meta.url).pathname;

async function bundle(entry: string, define: Record<string, string> = {}): Promise<string> {
  const r = await Bun.build({ entrypoints: [here(entry)], target: 'browser', format: 'esm', minify: true, define });
  if (!r.success) throw new AggregateError(r.logs, `bundling ${entry} failed`);
  return r.outputs[0].text();
}

const worker = await bundle('./worker.ts');
const main = await bundle('./main.ts', { __WORKER_SOURCE__: JSON.stringify(worker) });
const html = readFileSync(here('./index.html'), 'utf8');
const tag = '<script type="module" src="main.js"></script>';
if (!html.includes(tag)) throw new Error('script tag not found in demo/index.html');
const inline = `<script type="module">${main.replace(/<\/script/gi, '<\\/script')}</script>`;
mkdirSync(here('./dist'), { recursive: true });
writeFileSync(here('./dist/index.html'), html.replace(tag, () => inline));
console.log(`wrote demo/dist/index.html (${(Buffer.byteLength(html) / 1024 + (main.length / 1024)).toFixed(0)} KB)`);
