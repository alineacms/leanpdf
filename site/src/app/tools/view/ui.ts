/**
 * The View tool: pages rendered by leanpdf in the worker (./job.ts) at the screen's pixel density,
 * with page navigation and zoom.
 */
import { chevronLeft, chevronRight, eye } from '../../../pages/icons.ts';
import { describeError, fmtDuration, refs } from '../../format.ts';
import { Drop, dropHtml } from '../../kit.ts';
import type { Tool, ToolContext } from '../../tool.ts';

const ZOOMS = [
  ['fit', 'Fit width'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
];

const TEMPLATE = `
<div class="view-tool">
  <div class="card">${dropHtml('view')}</div>
  <div class="viewer-bar" role="toolbar" aria-label="Pages" data-ref="bar" hidden>
    <button type="button" class="icon-button" id="view-prev" data-ref="prev" aria-label="Previous page" title="Previous page">${chevronLeft}</button>
    <label class="page-field">Page <input type="number" class="input" id="view-page" data-ref="pageInput" min="1" value="1" inputmode="numeric"> of <span id="view-count" data-ref="count"></span></label>
    <button type="button" class="icon-button" id="view-next" data-ref="next" aria-label="Next page" title="Next page">${chevronRight}</button>
    <label class="page-field">Zoom <select class="input" id="view-zoom" data-ref="zoom">${ZOOMS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <span class="muted small" id="view-status" data-ref="status" aria-live="polite"></span>
  </div>
  <div class="viewer" id="view-viewport" data-ref="viewport" tabindex="0" hidden aria-label="Page view. Use the arrow keys to change pages.">
    <canvas id="view-canvas" data-ref="canvas" role="img" aria-label=""></canvas>
  </div>
  <section class="card error-card" id="view-error" data-ref="error" hidden tabindex="-1" aria-labelledby="view-error-heading">
    <h2 id="view-error-heading">Something went wrong</h2>
    <p id="view-error-text" data-ref="errorText"></p>
  </section>
  <ul class="warn small" id="view-warnings" data-ref="warnings" hidden></ul>
</div>`;

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, ['bar', 'prev', 'next', 'pageInput', 'count', 'zoom', 'status', 'viewport', 'canvas', 'error', 'errorText', 'warnings'] as const);
  const pageInput = r.pageInput as HTMLInputElement;
  const zoom = r.zoom as HTMLSelectElement;
  const canvas = r.canvas as HTMLCanvasElement;
  const prev = r.prev as HTMLButtonElement;
  const next = r.next as HTMLButtonElement;

  let file: File | null = null;
  let page = 0;
  let count = 0;
  let running: AbortController | null = null;
  let queued = false;
  /** Width (CSS pixels) the page was last fitted to. */
  let fitted = 0;

  const drop = new Drop(panel, (files) => {
    file = files[0];
    page = 0;
    count = 0;
    drop.show(file);
    void show();
  });

  const nav = () => {
    prev.disabled = page <= 0;
    next.disabled = count > 0 && page >= count - 1;
    pageInput.value = String(page + 1);
    pageInput.max = String(Math.max(1, count));
    r.count.textContent = count ? String(count) : '…';
  };

  /** Render the current page; a newer request replaces one in flight. */
  const show = async (): Promise<void> => {
    if (!file) return;
    if (running) {
      queued = true;
      running.abort(new DOMException('Superseded', 'AbortError'));
      return;
    }
    const ctl = new AbortController();
    running = ctl;
    r.error.hidden = true;
    r.bar.hidden = false;
    r.viewport.hidden = false;
    r.status.textContent = 'Rendering…';
    nav();
    const dpr = globalThis.devicePixelRatio || 1;
    const z = zoom.value;
    const cssWidth = Math.max(100, r.viewport.clientWidth - 32);
    const width = cssWidth * dpr;
    if (z === 'fit') fitted = cssWidth;
    try {
      const out = await ctx.worker.run('view', { file, page, ...(z === 'fit' ? { width } : { scale: Number(z) * dpr }) }, { signal: ctl.signal });
      count = out.pageCount;
      if (page >= count) page = Math.max(0, count - 1);
      canvas.width = out.width;
      canvas.height = out.height;
      canvas.style.width = `${out.width / dpr}px`;
      canvas.style.height = `${out.height / dpr}px`;
      const bctx = canvas.getContext('bitmaprenderer');
      if (bctx) bctx.transferFromImageBitmap(out.bitmap);
      else canvas.getContext('2d')?.drawImage(out.bitmap, 0, 0);
      canvas.setAttribute('aria-label', `Page ${page + 1} of ${count}`);
      canvas.dataset.page = String(page);
      // The first page of a file also says what reading and opening it took.
      const first = out.openMs === undefined ? '' : ` (file ${out.readMs === undefined ? '' : `read in ${fmtDuration(out.readMs)}, `}opened in ${fmtDuration(out.openMs)})`;
      r.status.textContent = `Rendered in ${fmtDuration(out.ms)}${first}`;
      r.warnings.textContent = '';
      for (const w of out.warnings) {
        const li = document.createElement('li');
        li.textContent = w;
        r.warnings.append(li);
      }
      r.warnings.hidden = !out.warnings.length;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        r.error.hidden = false;
        r.errorText.textContent = describeError(err);
        r.status.textContent = '';
        ctx.announce(`Error: ${r.errorText.textContent}`);
      }
    } finally {
      running = null;
      nav();
      if (queued) {
        queued = false;
        void show();
      }
    }
  };

  const go = (p: number) => {
    const target = Math.max(0, count ? Math.min(count - 1, p) : p);
    if (target === page) return;
    page = target;
    void show();
  };
  prev.addEventListener('click', () => go(page - 1));
  next.addEventListener('click', () => go(page + 1));
  pageInput.addEventListener('change', () => go(Math.floor(Number(pageInput.value)) - 1));
  zoom.addEventListener('change', () => void show());
  r.viewport.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') go(page + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp') go(page - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(count - 1);
    else return;
    e.preventDefault();
  });
  let resize: ReturnType<typeof setTimeout> | undefined;
  addEventListener('resize', () => {
    // Only a new width matters: on phones the address bar showing or hiding changes the height.
    if (zoom.value !== 'fit' || !file || panel.hidden || Math.max(100, r.viewport.clientWidth - 32) === fitted) return;
    clearTimeout(resize);
    resize = setTimeout(() => void show(), 200);
  });
}

export const viewTool: Tool = {
  id: 'view',
  label: 'View',
  icon: eye,
  summary: 'Read a PDF, rendered in your browser.',
  mount,
};
