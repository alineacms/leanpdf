# leanpdf website

The static website for leanpdf: a landing page, the in-browser PDF app, the docs (generated from
the root `README.md`) and the benchmarks (generated from `bench/results.json`). Plain HTML, CSS and
TypeScript, no framework, no third-party requests. It is built for Cloudflare Pages but is just
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
every page and the app in headless Chromium).

## Layout

```
site/
  build.ts            buildSite() -> Map<path, bytes>; writes site/dist when run
  serve.ts            dev server and static server, both applying _headers like Pages
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
`cp bench/.out/results.json bench/results.json` and commit it. Without that file the benchmarks
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
to `TOOLS`. That's all; the tab, routing and worker plumbing are shared.

The Compress tool streams to disk when the browser has `showSaveFilePicker` (the worker gets the
file handle and uses `compressPdf` with a `WritableStreamSink`), and otherwise builds a Blob with
`compressPdfBlob` and offers a download. Peak memory comes from
`performance.measureUserAgentSpecificMemory()` (the page is cross-origin isolated), else
`performance.memory`, else it says "unavailable".

## Hosting on Cloudflare Pages

The build writes `site/dist/_headers` (generated from `src/headers.ts`), which Pages applies to
every response:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on
  every path, so the app is `crossOriginIsolated`. Everything is same-origin, so nothing breaks.
- A strict `Content-Security-Policy`: only same-origin scripts, styles, images, workers and
  connections (plus `blob:` for the download link), no framing.
- `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (content-hashed names).
  HTML keeps Pages' default (revalidate every time).

`404.html` at the root makes Pages answer unknown paths with it and status 404 (without it, Pages
would treat the site as a single-page app).

### Option 1: GitHub Actions (set up in this repository)

`.github/workflows/site.yml` builds the site on every push and pull request, and on pushes to
`main` deploys `site/dist` with `cloudflare/wrangler-action@v3`
(`wrangler pages deploy site/dist --project-name=leanpdf --branch=main`).

1. Create the Pages project once, as a Direct Upload project named `leanpdf` with production
   branch `main`: in the Cloudflare dashboard (Workers & Pages → Create → Pages → Upload assets),
   or with `bunx wrangler pages project create leanpdf --production-branch=main`. It is then served
   at `https://leanpdf.pages.dev` (if that name is taken, Cloudflare picks another subdomain;
   update `SITE_URL` in the workflow).
2. Create an API token (My Profile → API Tokens → Create Token → Custom token) with the permission
   **Account → Cloudflare Pages → Edit**.
3. Add repository secrets (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: that token;
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID (shown on the Workers & Pages overview page).

### Option 2: Cloudflare Pages Git integration

Instead of the workflow, connect the repository in the dashboard (Workers & Pages → Create →
Pages → Connect to Git) and use:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `bun run site:build` |
| Build output directory | `site/dist` |
| Environment variable | `SITE_URL` = the site's public origin (optional, default `https://leanpdf.pages.dev`) |

Pages' v2 build image includes Bun (set the `BUN_VERSION` variable to pin a version). If the build
log shows the dependencies were not installed before the build command ran, use
`bun install --frozen-lockfile && bun run site:build` as the build command. Then delete
`.github/workflows/site.yml`, or remove its deploy step, so the site isn't deployed twice.

### Custom domain

Add it under the Pages project → Custom domains, and build with `SITE_URL=https://your.domain`
(the workflow's `env`, or the Pages environment variable) so canonical links and Open Graph URLs
point at it.

### Other static hosts

Any host works if it serves `site/dist` with the headers from `_headers` (at least COOP and COEP
for `/app/`, or the memory readout falls back to `performance.memory`) and serves `404.html` for
missing paths. The site uses root-relative URLs, so it must be served from the root of a domain.
