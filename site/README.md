# leanpdf website

The static website for leanpdf: a landing page, the in-browser PDF app, the docs (generated from
the root `README.md`) and the benchmarks (generated from `bench/results.json`). Plain HTML, CSS and
TypeScript, no framework, no third-party requests. It is deployed to Cloudflare but is just
static files.

```sh
bun run site:dev        # http://127.0.0.1:5173, rebuilt on every page load (PORT, HOST to change)
bun run site:build      # -> site/dist, prints every file with its size
bun run site:preview    # serves site/dist exactly as built
bun run demo            # alias of site:dev
bun site/screenshots.ts # PNGs of the main pages in site/screenshots/ (needs Chromium)
```

Tests: `bun test test/unit/site.test.ts` (Markdown, `_headers`, benchmark rendering) and
`bun test test/browser/site.test.ts` (builds the site, serves it with its `_headers`, and drives
every page and the Compress tool in headless Chromium) and `bun test test/browser/tools.test.ts`
(the other tools, their outputs checked with the library).

## Layout

```
site/
  build.ts            buildSite() -> Map<path, bytes>; writes site/dist when run
  serve.ts            dev server and static server, both applying _headers like Cloudflare
  screenshots.ts
  src/
    config.ts         GitHub/npm links, SITE_URL
    headers.ts        the _headers file (COOP/COEP, CSP, caching) and a matcher for it
    markdown.ts       minimal Markdown -> HTML (the README's subset) with GitHub heading ids
    highlight.ts      build-time syntax highlighting (TypeScript, shell)
    bench.ts          loads bench/results.json, renders tables and SVG bar charts
    pages/            one module per page, plus layout.ts and icons.ts
    static/           styles.css, logo.svg
    client/site.ts    small enhancements for content pages (copy buttons, docs contents)
    app/              the app page (see below)
```

Pages: `/` (home), `/app/`, `/docs/`, `/benchmarks/` and `/404.html`. Assets are content-hashed
under `/assets/`; the worker is its own bundle there, and the library is only in the worker.

Build inputs: `README.md` (docs), `bench/results.json` and the header comment of
`bench/corpus.ts` (benchmarks), and `src/` (the library, bundled into the worker; the home page
also measures the size of the browser entry). Sections of the README listed in `EXCLUDE` in
`src/pages/docs.ts` are left out of the docs. The tool descriptions on the benchmarks page are in
`src/pages/benchmarks.ts` and should follow `bench/run.ts`.

Numbers on the home and benchmarks pages come from `bench/results.json`. To refresh them, run the
benchmark (see the Methodology section of the benchmarks page), then
`cp bench/.out/results.json bench/results.json`, update the README's tables with
`bun bench/readme.ts`, and commit both. Without that file the benchmarks
page shows a notice and the home page falls back to the README's memory figure.

## The app

`/app/` runs leanpdf in a Web Worker. It is organised so that more tools become more tabs:

- `app/main.ts` renders one tab per entry of `TOOLS` (`app/tools.ts`), selected by the URL hash
  (`/app/#compress`), and mounts a tool the first time its tab is shown.
- A tool is a UI module, `app/tools/<id>/ui.ts`, exporting a `Tool` (`app/tool.ts`): an id, a tab
  label, a summary and `mount(panel, ctx)`. `ctx` gives it the shared worker client, the memory
  monitor, a screen-reader announcer and `pickSaveFile()` (showSaveFilePicker).
- Work that needs the library is a job, `app/tools/<id>/job.ts`, made with `defineJob()` and
  registered in `JOBS` (`app/jobs.ts`). The page runs it with
  `ctx.worker.run('<id>', input, { signal, onProgress })`, typed from that registry. Inputs and
  outputs must be structured-cloneable (Files, Blobs and FileSystemFileHandles are).
- Protocol (`app/protocol.ts`): `run` / `cancel` from the page; throttled `progress`, `done` and
  `error` from the worker. Cancelling aborts the job's AbortSignal.

To add a tool: write `tools/<id>/job.ts` and add it to `JOBS`, write `tools/<id>/ui.ts` and add it
to `TOOLS`. That's all; the tab, routing and worker plumbing are shared. `app/kit.ts` has the
pieces most tools use (drop zone, progress and error cards with the run/cancel logic, result card
with the download link, "… to file" button), `app/output.ts` is the worker-side counterpart that
writes a PDF to a Blob or to a picked file, `app/probe.ts` is a quick job that reads a file's page
count and encryption as soon as it is chosen, and `app/ranges.ts` parses page ranges.

The tools: **Compress**, **Inspect** (metadata, page sizes, bookmarks, attachments, images, form
fields and links; images and attachments can be saved), **Text** (extract, search, copy, download),
**Pages & cleanup** (keep, reorder and rotate pages; remove metadata, JavaScript, attachments and
unused objects; compress streams; repair, all in one `rewritePdf` pass), **Merge** and **Unlock**
(decrypt). Tools that can't work on an encrypted file say so and point to Unlock. The worker
bundles the whole library; the page script only has the UI.

The Compress tool streams to disk when the browser has `showSaveFilePicker` (the worker gets the
file handle and has `compressPdf` write into its `WritableStream`), and otherwise builds a Blob with
`compressPdfBlob` and offers a download. Peak memory comes from
`performance.measureUserAgentSpecificMemory()` (the page is cross-origin isolated), else
`performance.memory`, else it says "unavailable".

## Hosting on Cloudflare

The site is deployed as a Worker with static assets: no Worker code, just the files in
`site/dist`. `wrangler.jsonc` at the repository root says so (`assets.directory`), and Cloudflare
builds and deploys it from the repository on every push.

The build writes `site/dist/_headers` (generated from `src/headers.ts`), which Cloudflare applies
to every response:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on
  every path, so the app is `crossOriginIsolated`. Everything is same-origin, so nothing breaks.
- A strict `Content-Security-Policy`: only same-origin scripts, styles, images, workers and
  connections (plus `blob:` for the download link), no framing.
- `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (content-hashed names).
  HTML keeps the default (revalidate every time).

`not_found_handling: "404-page"` answers unknown paths with `404.html` and status 404.

### Setting it up

In the Cloudflare dashboard: Workers & Pages → Create → Import a repository, pick this repository,
and use:

| Setting | Value |
|---|---|
| Project name | `leanpdf` (must match `name` in `wrangler.jsonc`; change both together) |
| Build command | `bun run site:build` |
| Deploy command | `npx wrangler deploy` (the default) |
| Build variable | `SITE_URL` = the site's public origin, e.g. `https://leanpdf.<your-subdomain>.workers.dev` |

`SITE_URL` is only used for canonical links and Open Graph URLs (default
`https://leanpdf.pages.dev`). If the build log shows the dependencies were not installed before
the build command ran, use `bun install --frozen-lockfile && bun run site:build`.

No API token or account ID is needed: Cloudflare's own build uses the account it runs in.
`.github/workflows/site.yml` only checks that the site builds.

To deploy by hand instead: `bun run site:build && bunx wrangler deploy` (it asks you to log in).

### Custom domain

Add it under the Worker → Settings → Domains & Routes, and set the `SITE_URL` build variable to
it so canonical links and Open Graph URLs point at it.

### Other static hosts

Any host works if it serves `site/dist` with the headers from `_headers` (at least COOP and COEP
for `/app/`, or the memory readout falls back to `performance.memory`) and serves `404.html` for
missing paths. The site uses root-relative URLs, so it must be served from the root of a domain.
