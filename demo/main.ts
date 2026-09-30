/**
 * Demo page logic: collects options, runs the compression in demo/worker.ts, shows progress, the
 * report and memory use. No framework; see demo/index.html for the markup.
 */
import type { CompressReport } from '../src/index.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

declare const __WORKER_SOURCE__: string | undefined;

document.getElementById('not-loaded')?.remove();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const ui = {
  drop: $<HTMLLabelElement>('drop'),
  file: $<HTMLInputElement>('file'),
  fileLabel: $('file-label'),
  fileSize: $('file-size'),
  maxWidth: $<HTMLInputElement>('max-width'),
  maxHeight: $<HTMLInputElement>('max-height'),
  quality: $<HTMLInputElement>('quality'),
  qualityValue: $<HTMLOutputElement>('quality-value'),
  gray: $<HTMLInputElement>('gray'),
  compress: $<HTMLButtonElement>('compress'),
  cancel: $<HTMLButtonElement>('cancel'),
  saveTo: $<HTMLButtonElement>('save-to'),
  saveTarget: $('save-target'),
  progressSection: $('progress-section'),
  progress: $<HTMLProgressElement>('progress'),
  progressText: $('progress-text'),
  memRows: $('mem-rows'),
  memNotes: $('mem-notes'),
  error: $('error'),
  errorText: $('error-text'),
  report: $('report'),
  savedPct: $('saved-pct'),
  savedText: $('saved-text'),
  rInput: $('r-input'),
  rOutput: $('r-output'),
  rSeen: $('r-seen'),
  rRecompressed: $('r-recompressed'),
  rSkipped: $('r-skipped'),
  rTime: $('r-time'),
  rMemory: $('r-memory'),
  rWarningsRow: $('r-warnings-row'),
  rWarnings: $('r-warnings'),
  download: $<HTMLAnchorElement>('download'),
  savedTo: $('saved-to'),
  footer: $('footer'),
};

// ---------------------------------------------------------------------------------------------
// Formatting

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const SKIP_REASONS: Record<string, string> = {
  small: 'below the size threshold',
  noGain: 'no worthwhile saving',
  softMask: 'transparency mask kept as is',
  imageMask: 'stencil mask',
  colorKeyMask: 'colour-key mask',
  matte: 'pre-blended (Matte)',
  cmyk: 'CMYK',
  indexed: 'indexed colour',
  separation: 'spot colour',
  deviceN: 'DeviceN colour',
  lab: 'Lab colour',
  jpx: 'JPEG 2000',
  jbig2: 'JBIG2',
  ccitt: 'CCITT fax',
  bitsPerComponent: 'not 8 bits per sample',
  decode: 'custom /Decode',
  predictor: 'unsupported predictor',
  jpegTransform: 'JPEG with unusual colour transform',
  jpegUnsupported: 'unsupported JPEG variant',
  jpegMismatch: 'JPEG does not match its dictionary',
  jpegInvalid: 'invalid JPEG data',
  decodeError: 'damaged image data',
  codecError: 'browser could not decode it',
  codecDeclined: 'codec declined',
  codecOutputInvalid: 'codec produced unusable output',
  tooLarge: 'too large to decode',
  malformed: 'malformed dictionary',
  filter: 'unsupported filter',
  external: 'external file',
};

// ---------------------------------------------------------------------------------------------
// Memory

interface MemorySample {
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
  sample(): Promise<MemorySample>;
}

/** Every memory API this page can use, best first. */
function availableMeters(): { meters: Meter[]; notes: string[] } {
  const perf = performance as PerformanceWithMemory;
  const meters: Meter[] = [];
  const notes: string[] = [];
  if (typeof perf.measureUserAgentSpecificMemory === 'function' && globalThis.crossOriginIsolated) {
    const measure = perf.measureUserAgentSpecificMemory.bind(perf);
    meters.push({
      label: 'Page + worker',
      method: 'performance.measureUserAgentSpecificMemory()',
      note:
        'measureUserAgentSpecificMemory() covers the JS heaps and DOM of the page and its worker, but not image buffers held by the browser. ' +
        'Chrome answers at the next garbage collection, which can take 10–20 s on an idle page; start Chrome with ' +
        '--enable-blink-features=ForceEagerMeasureMemory for immediate answers.',
      async sample() {
        const m = await measure();
        let worker = 0;
        for (const b of m.breakdown) if (b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')) worker += b.bytes;
        return { bytes: m.bytes, detail: worker ? `worker ${fmtBytes(worker)}` : undefined };
      },
    });
  } else if (typeof perf.measureUserAgentSpecificMemory === 'function') {
    notes.push('measureUserAgentSpecificMemory() needs a crossOriginIsolated page (serve with COOP/COEP headers, e.g. bun demo/serve.ts).');
  }
  if (perf.memory && typeof perf.memory.usedJSHeapSize === 'number') {
    const mem = perf.memory;
    meters.push({
      label: 'Main-thread JS heap',
      method: 'performance.memory.usedJSHeapSize',
      note: 'performance.memory measures the main thread only; the compression itself runs in the worker.',
      sample: async () => ({ bytes: mem.usedJSHeapSize }),
    });
  }
  return { meters, notes: [...meters.map((m) => m.note), ...notes] };
}

interface MeterState {
  meter: Meter;
  pending: boolean;
  current: MemorySample | null;
  peak: MemorySample | null;
  cell: HTMLElement;
}

const describeSample = (s: MemorySample | null): string => (s ? `${fmtBytes(s.bytes)}${s.detail ? ` (${s.detail})` : ''}` : '–');

class MemoryMonitor {
  private readonly states: MeterState[] = [];
  private run = 0;
  private tracking = false;
  onChange: () => void = () => {};

  constructor() {
    const { meters, notes } = availableMeters();
    for (const meter of meters) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = meter.label;
      th.title = meter.method;
      const td = document.createElement('td');
      td.textContent = 'measuring…';
      tr.append(th, td);
      ui.memRows.append(tr);
      this.states.push({ meter, pending: false, current: null, peak: null, cell: td });
    }
    if (!meters.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<th>Memory</th><td>unavailable in this browser</td>';
      ui.memRows.append(tr);
    }
    for (const n of notes) {
      const li = document.createElement('li');
      li.textContent = n;
      ui.memNotes.append(li);
    }
    this.tick();
    setInterval(() => this.tick(), 500);
  }

  get available(): boolean {
    return this.states.length > 0;
  }

  /** Start tracking the peak of a new run. */
  begin(): void {
    this.run++;
    this.tracking = true;
    for (const s of this.states) s.peak = null;
    this.render();
    this.tick();
  }

  /** Stop tracking the peak; measurements already requested during the run still count. */
  end(): void {
    this.tracking = false;
  }

  /** Peak per source for the report. */
  peakSummary(): string {
    if (!this.available) return 'unavailable';
    return this.states.map((s) => `${s.meter.label}: ${s.peak ? describeSample(s.peak) : 'waiting for the browser…'}`).join(' · ');
  }

  private render(): void {
    for (const s of this.states) s.cell.textContent = `${describeSample(s.current)} · peak ${describeSample(s.peak)}`;
    this.onChange();
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

// ---------------------------------------------------------------------------------------------
// State

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

const picker = (globalThis as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
const memory = new MemoryMonitor();
let file: File | null = null;
let saveHandle: FileSystemFileHandle | null = null;
let worker: Worker | null = null;
let busy = false;
let downloadUrl: string | null = null;
let lastRunDone = false;

memory.onChange = () => {
  if (lastRunDone) ui.rMemory.textContent = memory.peakSummary();
};

ui.footer.textContent =
  `crossOriginIsolated: ${globalThis.crossOriginIsolated ? 'yes' : 'no'} · ` +
  `codec: BrowserImageCodec (createImageBitmap + OffscreenCanvas) · streaming save: ${picker ? 'available' : 'not supported here'}`;

const outputName = (f: File): string => `${f.name.replace(/\.pdf$/i, '') || 'document'}-compressed.pdf`;

function setFile(f: File | null): void {
  file = f;
  saveHandle = null;
  ui.saveTarget.textContent = '';
  ui.fileLabel.innerHTML = '';
  if (f) {
    const strong = document.createElement('strong');
    strong.textContent = f.name;
    ui.fileLabel.append(strong);
    ui.fileSize.textContent = `${fmtBytes(f.size)} · click to choose another`;
  } else {
    ui.fileLabel.textContent = 'Choose a PDF or drop it here';
    ui.fileSize.textContent = '';
  }
  refreshButtons();
}

function refreshButtons(): void {
  ui.compress.disabled = busy || !file;
  ui.cancel.hidden = !busy;
  ui.saveTo.hidden = !picker;
  ui.saveTo.disabled = busy || !file;
  ui.file.disabled = busy;
}

function readOptions(): { maxWidth: number; maxHeight: number; jpegQuality: number; preserveGray: boolean } | string {
  const maxWidth = Math.floor(Number(ui.maxWidth.value));
  const maxHeight = Math.floor(Number(ui.maxHeight.value));
  const jpegQuality = Number(ui.quality.value);
  if (!(maxWidth >= 1) || !(maxHeight >= 1)) return 'Max width and height must be at least 1 pixel.';
  if (!(jpegQuality > 0 && jpegQuality <= 1)) return 'Quality must be between 0 and 1.';
  return { maxWidth, maxHeight, jpegQuality, preserveGray: ui.gray.checked };
}

function showError(msg: string): void {
  ui.error.hidden = false;
  ui.errorText.textContent = msg;
}

function getWorker(): Worker {
  if (!worker) {
    // The standalone build (demo/build.ts) inlines the worker; the dev server serves worker.js.
    // The inlined bundle has no imports, so it runs as a classic worker, which (unlike module
    // workers) may start from a Blob URL on file:// pages too.
    worker =
      typeof __WORKER_SOURCE__ === 'string'
        ? new Worker(URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' })))
        : new Worker('worker.js', { type: 'module' });
    worker.onerror = (e) => {
      finish();
      showError(`Worker failed: ${e.message || 'unknown error'}`);
      worker?.terminate();
      worker = null;
    };
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => onWorkerMessage(e.data);
  }
  return worker;
}

function onWorkerMessage(m: WorkerResponse): void {
  if (m.type === 'progress') {
    ui.progress.max = Math.max(1, m.totalObjects);
    ui.progress.value = m.processedObjects;
    const pct = m.totalObjects ? Math.round((m.processedObjects / m.totalObjects) * 100) : 0;
    ui.progressText.textContent = `${pct}% · ${m.processedObjects.toLocaleString()} of ${m.totalObjects.toLocaleString()} objects · ${fmtBytes(m.bytesSaved)} saved so far`;
    return;
  }
  finish();
  if (m.type === 'error') {
    if (m.name === 'AbortError') {
      ui.progressText.textContent = 'Cancelled.';
    } else {
      showError(`${m.name}: ${m.message}`);
    }
    return;
  }
  showReport(m.report, m.ms, m.blob, m.savedTo);
}

function finish(): void {
  busy = false;
  memory.end();
  refreshButtons();
}

function showReport(r: CompressReport, ms: number, blob?: Blob, savedTo?: string): void {
  lastRunDone = true;
  const saved = r.inputBytes - r.outputBytes;
  const pct = r.inputBytes ? (saved / r.inputBytes) * 100 : 0;
  ui.report.hidden = false;
  ui.report.dataset.inputBytes = String(r.inputBytes);
  ui.report.dataset.outputBytes = String(r.outputBytes);
  ui.savedPct.textContent = `${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%`;
  ui.savedPct.className = `big ${saved > 0 ? 'good' : 'warn'}`;
  ui.savedText.textContent = saved > 0 ? `${fmtBytes(saved)} smaller` : 'no reduction';
  ui.rInput.textContent = `${fmtBytes(r.inputBytes)} (${r.inputBytes.toLocaleString()} bytes)`;
  ui.rOutput.textContent = `${fmtBytes(r.outputBytes)} (${r.outputBytes.toLocaleString()} bytes)`;
  ui.rSeen.textContent = String(r.imagesSeen);
  ui.rRecompressed.textContent = String(r.imagesRecompressed);
  const skipped = Object.entries(r.imagesSkipped).sort((a, b) => b[1] - a[1]);
  ui.rSkipped.textContent = '';
  if (!skipped.length) ui.rSkipped.textContent = '0';
  else {
    const ul = document.createElement('ul');
    for (const [reason, n] of skipped) {
      const li = document.createElement('li');
      li.textContent = `${n} × ${SKIP_REASONS[reason] ?? reason}`;
      li.title = reason;
      ul.append(li);
    }
    ui.rSkipped.append(ul);
  }
  ui.rTime.textContent = `${(ms / 1000).toFixed(2)} s`;
  ui.rMemory.textContent = memory.peakSummary();
  const warnings = [...r.warnings];
  if (r.xrefRepaired && !warnings.some((w) => /xref|cross-reference/i.test(w))) warnings.push('The cross-reference table was damaged and has been rebuilt.');
  ui.rWarningsRow.hidden = !warnings.length;
  ui.rWarnings.textContent = '';
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    ui.rWarnings.append(li);
  }

  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  ui.download.hidden = !blob;
  ui.savedTo.hidden = !savedTo;
  if (blob && file) {
    downloadUrl = URL.createObjectURL(blob);
    ui.download.href = downloadUrl;
    ui.download.download = outputName(file);
    ui.download.dataset.bytes = String(blob.size);
    ui.download.textContent = `Download ${outputName(file)} (${fmtBytes(blob.size)})`;
  }
  if (savedTo) {
    ui.savedTo.textContent = `Saved to ${savedTo}.`;
    // One save location per run, so a second run cannot silently overwrite the file.
    saveHandle = null;
    ui.saveTarget.textContent = '';
  }
  ui.progress.value = ui.progress.max;
}

function start(): void {
  if (!file || busy) return;
  const options = readOptions();
  ui.error.hidden = true;
  if (typeof options === 'string') {
    showError(options);
    return;
  }
  busy = true;
  lastRunDone = false;
  refreshButtons();
  ui.report.hidden = true;
  ui.progressSection.hidden = false;
  ui.progress.value = 0;
  ui.progressText.textContent = 'Reading the document…';
  memory.begin();
  const req: WorkerRequest = { type: 'start', file, options, ...(saveHandle ? { handle: saveHandle } : {}) };
  getWorker().postMessage(req);
}

// ---------------------------------------------------------------------------------------------
// Events

ui.file.addEventListener('change', () => setFile(ui.file.files?.[0] ?? null));
ui.quality.addEventListener('input', () => {
  ui.qualityValue.textContent = Number(ui.quality.value).toFixed(2);
});
ui.compress.addEventListener('click', start);
ui.cancel.addEventListener('click', () => {
  ui.progressText.textContent = 'Cancelling…';
  worker?.postMessage({ type: 'cancel' } satisfies WorkerRequest);
});
ui.saveTo.addEventListener('click', async () => {
  if (!picker || !file) return;
  try {
    saveHandle = await picker({ suggestedName: outputName(file), types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
    ui.saveTarget.textContent = `→ ${saveHandle.name}`;
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) showError(`Could not open the save dialog: ${String(e)}`);
  }
});

for (const t of ['dragenter', 'dragover'] as const) {
  ui.drop.addEventListener(t, (e) => {
    e.preventDefault();
    if (!busy) ui.drop.classList.add('over');
  });
}
for (const t of ['dragleave', 'drop'] as const) ui.drop.addEventListener(t, () => ui.drop.classList.remove('over'));
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && !busy) setFile(f);
});

refreshButtons();
