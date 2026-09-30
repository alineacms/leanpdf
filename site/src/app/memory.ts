/**
 * Memory readings for the app page: performance.measureUserAgentSpecificMemory() when the page
 * is crossOriginIsolated (it covers the page and its worker), else performance.memory (main
 * thread only, Chromium), else nothing. Sampled every 0.5 s; tools bracket a run with begin()
 * and end() and show peakSummary() in their report.
 */
import { el, fmtBytes } from './format.ts';

interface Sample {
  bytes: number;
  detail?: string;
}

interface UAMemoryResult {
  bytes: number;
  breakdown: { bytes: number; types: string[]; attribution: { scope?: string }[] }[];
}

type PerformanceWithMemory = Performance & {
  measureUserAgentSpecificMemory?: () => Promise<UAMemoryResult>;
  memory?: { usedJSHeapSize: number };
};

interface Meter {
  label: string;
  method: string;
  note: string;
  sample(): Promise<Sample>;
}

/** Every memory API this page can use, best first. */
function availableMeters(): { meters: Meter[]; notes: string[] } {
  const perf = performance as PerformanceWithMemory;
  const meters: Meter[] = [];
  const notes: string[] = [];
  if (typeof perf.measureUserAgentSpecificMemory === 'function' && globalThis.crossOriginIsolated) {
    const measure = perf.measureUserAgentSpecificMemory.bind(perf);
    meters.push({
      label: 'Page and worker',
      method: 'performance.measureUserAgentSpecificMemory()',
      note:
        'measureUserAgentSpecificMemory() covers the JavaScript heaps and DOM of this page and its worker, but not image buffers held by the browser itself. ' +
        'The browser answers at its next garbage collection, which can take a while on an idle page.',
      async sample() {
        const m = await measure();
        let worker = 0;
        for (const b of m.breakdown) if (b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')) worker += b.bytes;
        return { bytes: m.bytes, detail: worker ? `worker ${fmtBytes(worker)}` : undefined };
      },
    });
  } else if (typeof perf.measureUserAgentSpecificMemory === 'function') {
    notes.push('measureUserAgentSpecificMemory() needs a cross-origin isolated page (COOP and COEP headers), which this one is not.');
  }
  if (perf.memory && typeof perf.memory.usedJSHeapSize === 'number') {
    const mem = perf.memory;
    meters.push({
      label: 'Page JavaScript heap',
      method: 'performance.memory.usedJSHeapSize',
      note: 'performance.memory measures the page only; the compression itself runs in the worker.',
      sample: async () => ({ bytes: mem.usedJSHeapSize }),
    });
  }
  return { meters, notes: [...meters.map((m) => m.note), ...notes] };
}

interface MeterState {
  meter: Meter;
  pending: boolean;
  current: Sample | null;
  peak: Sample | null;
  cell: HTMLElement;
}

const describe = (s: Sample | null): string => (s ? `${fmtBytes(s.bytes)}${s.detail ? ` (${s.detail})` : ''}` : '–');

export class MemoryMonitor {
  private readonly states: MeterState[] = [];
  private readonly listeners = new Set<() => void>();
  private run = 0;
  private tracking = false;

  constructor(container: HTMLElement) {
    const { meters, notes } = availableMeters();
    container.querySelector('#memory-status')?.remove();
    const table = el('table');
    table.id = 'memory-table';
    const head = table.createTHead().insertRow();
    head.append(el('th', 'Source'), el('th', 'Now · peak during the last run'));
    for (const th of head.cells) th.setAttribute('scope', 'col');
    const body = table.createTBody();
    for (const meter of meters) {
      const tr = body.insertRow();
      const th = el('th', meter.label);
      th.scope = 'row';
      th.title = meter.method;
      th.dataset.method = meter.method;
      const td = el('td', 'measuring…');
      tr.append(th, td);
      this.states.push({ meter, pending: false, current: null, peak: null, cell: td });
    }
    if (!meters.length) {
      const tr = body.insertRow();
      const th = el('th', 'Memory');
      th.scope = 'row';
      tr.append(th, el('td', 'unavailable in this browser'));
    }
    const wrap = el('div', undefined, 'table-wrap');
    wrap.append(table);
    const list = el('ul');
    for (const n of notes) list.append(el('li', n));
    container.append(wrap, list);
    this.tick();
    setInterval(() => this.tick(), 500);
  }

  get available(): boolean {
    return this.states.length > 0;
  }

  /** Call `fn` whenever a reading changes. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start tracking the peak of a new run. */
  begin(): void {
    this.run++;
    this.tracking = true;
    for (const s of this.states) s.peak = null;
    this.render();
    this.tick();
  }

  /** Stop tracking the peak; readings already requested during the run still count. */
  end(): void {
    this.tracking = false;
  }

  /** Peak per source during the last run, for reports. */
  peakSummary(): string {
    if (!this.available) return 'unavailable in this browser';
    return this.states.map((s) => `${s.meter.label}: ${s.peak ? describe(s.peak) : 'waiting for the browser…'}`).join(' · ');
  }

  private render(): void {
    for (const s of this.states) s.cell.textContent = `${describe(s.current)} · peak ${describe(s.peak)}`;
    for (const fn of this.listeners) fn();
  }

  private tick(): void {
    for (const s of this.states) {
      if (s.pending) continue;
      s.pending = true;
      const run = this.run;
      const countsForPeak = this.tracking;
      s.meter
        .sample()
        .then((m) => {
          s.current = m;
          if (countsForPeak && run === this.run && (!s.peak || m.bytes > s.peak.bytes)) s.peak = m;
          this.render();
        })
        .catch(() => {})
        .finally(() => {
          s.pending = false;
        });
    }
  }
}
