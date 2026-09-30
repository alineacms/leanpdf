/**
 * The codec contract against BrowserImageCodec in headless Chromium, inside a module Web Worker
 * and on the main thread. The suite runs in the page; results come back as JSON and each case is
 * asserted here. Skips (with a message) when no Chromium can be launched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'playwright-core';
import { bundle, HTML, JS, launchChromium, serveStatic, type Asset, type StaticServer } from '../browser/harness.ts';
import { CASE_NAMES, type CaseResult, type InfoValue } from './contract.ts';
import { makeJpegFixtures } from './node-helpers.ts';

const launch = await launchChromium('browser codec contract');
const browser = launch.browser;

let server: StaticServer | undefined;
let page: Page | undefined;
const results: Record<'worker' | 'main', Map<string, CaseResult> | Error> = { worker: new Error('not run'), main: new Error('not run') };
let probe: Record<string, InfoValue> | undefined;

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

beforeAll(async () => {
  if (!browser) return;
  const assets: Record<string, Asset> = {
    '/': HTML('<script type="module" src="/contract.js"></script>'),
    '/contract.js': JS(await bundle(new URL('./browser-entry.ts', import.meta.url).pathname)),
  };
  for (const [name, data] of Object.entries(await makeJpegFixtures())) assets[`/fixtures/${name}.jpg`] = { body: data, type: 'image/jpeg' };
  server = serveStatic(assets);
  page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.waitForFunction(() => '__contract' in globalThis);

  // Worker and main thread run concurrently; they are independent threads.
  const [worker, main, pr] = await page.evaluate(async (base) => {
    type R<T> = { ok: true; value: T } | { ok: false; error: string };
    const inWorker = <T,>(cmd: string): Promise<R<T>> =>
      new Promise((resolve) => {
        const w = new Worker('/contract.js', { type: 'module' });
        w.onmessage = (e) => {
          w.terminate();
          resolve(e.data);
        };
        w.onerror = (e) => {
          w.terminate();
          resolve({ ok: false, error: `worker error: ${e.message}` });
        };
        w.postMessage({ cmd, base });
      });
    const api = (globalThis as unknown as { __contract: { run(b: string): Promise<unknown> } }).__contract;
    const onMain = api.run(base).then(
      (value) => ({ ok: true, value }) as const,
      (e: unknown) => ({ ok: false, error: String(e) }) as const,
    );
    return Promise.all([inWorker('run'), onMain, inWorker('probe')]);
  }, server.url);
  const collect = (r: Reply<unknown>): Map<string, CaseResult> | Error =>
    r.ok ? new Map((r.value as CaseResult[]).map((c) => [c.name, c])) : new Error(r.error);
  results.worker = collect(worker as Reply<unknown>);
  results.main = collect(main as Reply<unknown>);
  if ((pr as Reply<unknown>).ok) probe = (pr as { value: Record<string, InfoValue> }).value;
  if (errors.length) console.warn('page errors:', errors);
  if (process.env.CONTRACT_VERBOSE) {
    for (const where of ['worker', 'main'] as const) {
      const m = results[where];
      if (m instanceof Map) for (const r of m.values()) console.log(where, r.status, r.name, r.ms, JSON.stringify(r.info));
    }
    console.log('probe', JSON.stringify(probe, null, 1));
  }
}, 120_000);

afterAll(async () => {
  await page?.close().catch(() => {});
  await launch.close?.();
  await server?.close();
}, 20_000);

for (const where of ['worker', 'main'] as const) {
  describe.skipIf(!browser)(`ImageCodec contract: BrowserImageCodec (${where === 'worker' ? 'Web Worker' : 'main thread'})`, () => {
    for (const name of CASE_NAMES) {
      test(name, () => {
        const m = results[where];
        if (m instanceof Error) throw m;
        const r = m.get(name);
        expect(r, `case "${name}" did not run`).toBeDefined();
        expect(r!.failures).toEqual([]);
      });
    }
  });
}

describe.skipIf(!browser)('Chromium image primitives', () => {
  test('probe ran and convertToBlob produces JPEG', () => {
    expect(probe).toBeDefined();
    expect(probe!['jpeg_q0.92_type']).toBe('image/jpeg');
  });
});

if (!browser) test.skip(`browser codec contract (${launch.skip})`, () => {});
