/**
 * The document view: every page in one scrolling column, as placeholders of the right size that
 * are rendered (in the worker) when they come near the screen and dropped again when they are far
 * away, so a long document costs no more than the pages around the one being read.
 */
import type { WorkerClient } from './client.ts';
import { describeError, el, fmtDuration } from './format.ts';

/** CSS pixels per point at 100%. */
const PX = 96 / 72;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Pages rendered at once. */
const CONCURRENCY = 2;
/** Gap between pages, and padding around them, in CSS pixels. */
const GAP = 16;
/** Widest a page gets when fitted to the view, in CSS pixels: wider reads badly and renders slowly. */
const MAX_FIT = 1000;

interface PageView {
  index: number;
  /** Size in points, as shown. */
  w: number;
  h: number;
  box: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** Width in device pixels the canvas was rendered at; 0 when not rendered. */
  renderedAt: number;
  /** In or near the viewport. */
  near: boolean;
  running: AbortController | null;
}

export interface ViewerEvents {
  /** The page at the middle of the view changed (0-based). */
  onPage(page: number, count: number): void;
  /** Status for the toolbar: timings, warnings. */
  onStatus(text: string): void;
}

export class Viewer {
  readonly scroller: HTMLElement;
  private readonly column: HTMLElement;
  private readonly worker: WorkerClient;
  private readonly events: ViewerEvents;
  private pages: PageView[] = [];
  private file: File | null = null;
  /** null: fit the width. */
  private zoom: number | null = null;
  private queue: PageView[] = [];
  private active = 0;
  private observer: IntersectionObserver | null = null;
  private current = 0;
  private warnings = new Set<string>();
  private loadInfo = '';
  private session = 0;

  constructor(scroller: HTMLElement, worker: WorkerClient, events: ViewerEvents) {
    this.scroller = scroller;
    this.worker = worker;
    this.events = events;
    this.column = el('div', undefined, 'pages');
    scroller.append(this.column);
    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    let last = scroller.clientWidth;
    new ResizeObserver(() => {
      // Only a new width matters: on phones the address bar showing or hiding changes the height.
      if (scroller.clientWidth === last) return;
      last = scroller.clientWidth;
      if (this.zoom === null) this.relayout();
    }).observe(scroller);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Show `file`; its page sizes come from the worker. */
  async show(file: File): Promise<void> {
    const session = ++this.session;
    this.clear();
    this.file = file;
    this.events.onStatus('Opening…');
    let layout;
    try {
      layout = await this.worker.run('layout', { file });
    } catch (err) {
      if (session === this.session) this.events.onStatus(describeError(err));
      return;
    }
    if (session !== this.session) return;
    this.loadInfo = `Opened in ${fmtDuration(layout.openMs)}${layout.readMs !== undefined ? ` (read in ${fmtDuration(layout.readMs)})` : ''}`;
    this.events.onStatus(this.loadInfo);
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.scroller, rootMargin: '150% 0px' });
    this.pages = layout.sizes.map(([w, h], index) => {
      const box = el('div', undefined, 'page');
      box.dataset.page = String(index);
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `Page ${index + 1} of ${layout.sizes.length}`);
      this.column.append(box);
      return { index, w, h, box, canvas: null, renderedAt: 0, near: false, running: null };
    });
    this.relayout();
    for (const p of this.pages) this.observer.observe(p.box);
    this.scroller.scrollTop = 0;
    this.current = -1;
    this.onScroll();
  }

  clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const p of this.pages) p.running?.abort(new DOMException('Closed', 'AbortError'));
    this.pages = [];
    this.queue = [];
    this.column.textContent = '';
    this.warnings.clear();
    this.file = null;
  }

  /** Zoom: a factor (1 = 100%), or null to fit the width. */
  setZoom(zoom: number | null): void {
    // Keep the page at the middle of the view in place.
    const page = this.current;
    this.zoom = zoom;
    this.relayout();
    if (page >= 0) this.goTo(page, false);
  }

  /** The next zoom step in or out from the current scale. */
  stepZoom(dir: 1 | -1): number {
    const now = this.zoom ?? this.fitScale();
    const next = dir > 0 ? (ZOOMS.find((z) => z > now + 0.01) ?? ZOOMS.at(-1)!) : ([...ZOOMS].reverse().find((z) => z < now - 0.01) ?? ZOOMS[0]);
    this.setZoom(next);
    return next;
  }

  get zoomLabel(): string {
    return this.zoom === null ? 'Fit' : `${Math.round(this.zoom * 100)}%`;
  }

  goTo(page: number, smooth = true): void {
    const p = this.pages[Math.max(0, Math.min(this.pages.length - 1, page))];
    if (!p) return;
    this.scroller.scrollTo({ top: p.box.offsetTop - GAP, behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Scale (points to CSS pixels) that fits the widest page to the view, up to MAX_FIT wide. */
  private fitScale(): number {
    const widest = Math.max(1, ...this.pages.map((p) => p.w));
    return Math.max(0.1, Math.min(MAX_FIT, this.scroller.clientWidth - 2 * GAP) / (widest * PX));
  }

  /** Size every page box for the current zoom; rendered pages are redone at the new size. */
  private relayout(): void {
    if (!this.pages.length) return;
    const scale = (this.zoom ?? this.fitScale()) * PX;
    for (const p of this.pages) {
      p.box.style.width = `${Math.round(p.w * scale)}px`;
      p.box.style.height = `${Math.round(p.h * scale)}px`;
      if (p.renderedAt && p.renderedAt !== this.targetWidth(p)) {
        if (p.near) this.enqueue(p);
        else this.drop(p);
      }
    }
  }

  /** Device pixels wide to render page `p` at. */
  private targetWidth(p: PageView): number {
    const css = parseFloat(p.box.style.width) || 1;
    return Math.max(1, Math.round(css * (globalThis.devicePixelRatio || 1)));
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const p = this.pages[Number((e.target as HTMLElement).dataset.page)];
      if (!p) continue;
      p.near = e.isIntersecting;
      if (p.near) {
        if (p.renderedAt !== this.targetWidth(p)) this.enqueue(p);
      } else {
        p.running?.abort(new DOMException('Scrolled away', 'AbortError'));
        this.queue = this.queue.filter((q) => q !== p);
        this.drop(p);
      }
    }
  }

  private enqueue(p: PageView): void {
    if (!this.queue.includes(p) && !p.running) this.queue.push(p);
    this.pump();
  }

  /** Start renders, the page nearest the middle of the view first. */
  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const mid = this.current;
      this.queue.sort((a, b) => Math.abs(a.index - mid) - Math.abs(b.index - mid));
      const p = this.queue.shift()!;
      void this.render(p);
    }
  }

  private async render(p: PageView): Promise<void> {
    const file = this.file;
    if (!file) return;
    const ctl = new AbortController();
    p.running = ctl;
    this.active++;
    const width = this.targetWidth(p);
    try {
      const out = await this.worker.run('view', { file, page: p.index, width }, { signal: ctl.signal });
      if (file !== this.file || !p.near) return;
      const canvas = p.canvas ?? el('canvas');
      canvas.width = out.width;
      canvas.height = out.height;
      const bctx = canvas.getContext('bitmaprenderer');
      if (bctx) bctx.transferFromImageBitmap(out.bitmap);
      else canvas.getContext('2d')?.drawImage(out.bitmap, 0, 0);
      if (!p.canvas) {
        p.canvas = canvas;
        p.box.replaceChildren(canvas);
      }
      p.renderedAt = width;
      p.box.classList.remove('failed');
      for (const w of out.warnings) this.warnings.add(w);
      if (out.warnings.length) this.events.onStatus(`${this.loadInfo} · ${[...this.warnings].join('; ')}`);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError') && file === this.file) {
        p.box.classList.add('failed');
        p.box.replaceChildren(el('p', `Page ${p.index + 1} could not be shown: ${describeError(err)}`, 'page-error'));
        p.canvas = null;
        p.renderedAt = width;
      }
    } finally {
      p.running = null;
      this.active--;
      this.pump();
    }
  }

  /** Free a page's pixels. */
  private drop(p: PageView): void {
    if (!p.canvas) return;
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
    p.renderedAt = 0;
  }

  private scrollTick = false;
  private onScroll(): void {
    if (this.scrollTick || !this.pages.length) return;
    this.scrollTick = true;
    requestAnimationFrame(() => {
      this.scrollTick = false;
      const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
      let page = this.pages.findIndex((p) => p.box.offsetTop + p.box.offsetHeight + GAP / 2 >= mid);
      if (page < 0) page = this.pages.length - 1;
      if (page !== this.current) {
        this.current = page;
        this.events.onPage(page, this.pages.length);
      }
    });
  }
}
