/**
 * Building blocks shared by the tools: the file drop zone, the progress and error cards with the
 * run/cancel logic behind them, and the result card with its download link or "saved to" note.
 * Markup helpers return HTML strings with data-ref attributes; the matching controllers look them
 * up with refs().
 */
import { download, eye, save, upload } from '../pages/icons.ts';
import { describeError, el, fmtBytes, fmtDuration, refs } from './format.ts';
import type { ToolContext } from './tool.ts';

const DROP_HINT = 'Any size. The file stays on this device.';

export function dropHtml(id: string, opts: { multiple?: boolean; title?: string; hint?: string } = {}): string {
  return `<label class="drop" data-ref="drop">
      <input type="file" id="${id}-file" data-ref="file" accept="application/pdf,.pdf"${opts.multiple ? ' multiple' : ''}>
      ${upload}
      <span class="drop-title" data-ref="fileLabel">${opts.title ?? 'Choose a PDF or drop it here'}</span>
      <span class="small" data-ref="fileHint">${opts.hint ?? DROP_HINT}</span>
    </label>`;
}

/** The drop zone made by dropHtml. `onFiles` gets the chosen files (never an empty list). */
export class Drop {
  readonly input: HTMLInputElement;
  private readonly r: Record<'drop' | 'fileLabel' | 'fileHint', HTMLElement>;
  private readonly title: string;

  constructor(root: ParentNode, onFiles: (files: File[]) => void) {
    const r = refs(root, ['drop', 'file', 'fileLabel', 'fileHint'] as const);
    this.r = r;
    this.input = r.file as HTMLInputElement;
    this.title = r.fileLabel.textContent ?? '';
    this.input.addEventListener('change', () => {
      const files = [...(this.input.files ?? [])];
      // Let the same file be chosen again (a multiple picker adds rather than replaces).
      if (this.input.multiple) this.input.value = '';
      if (files.length) onFiles(files);
    });
    for (const t of ['dragenter', 'dragover'] as const) r.drop.addEventListener(t, () => r.drop.classList.toggle('over', !this.input.disabled));
    for (const t of ['dragleave', 'drop'] as const) r.drop.addEventListener(t, () => r.drop.classList.remove('over'));
  }

  /** Show the chosen file (or reset to the prompt). */
  show(file: File | null, hint?: string): void {
    this.r.drop.classList.toggle('has-file', !!file);
    this.r.fileLabel.textContent = file ? file.name : this.title;
    this.r.fileHint.textContent = file ? (hint ?? `${fmtBytes(file.size)} · choose or drop another file to replace it`) : DROP_HINT;
  }

  set disabled(v: boolean) {
    this.input.disabled = v;
  }
}

export function statusHtml(id: string): string {
  return `<section class="card" id="${id}-progress" data-ref="progressCard" hidden aria-labelledby="${id}-progress-heading">
      <h2 id="${id}-progress-heading">Progress</h2>
      <progress id="${id}-progress-bar" data-ref="progress" max="1" value="0" aria-labelledby="${id}-progress-heading"></progress>
      <div class="progress-row">
        <p id="${id}-progress-text" data-ref="progressText"></p>
        <button type="button" class="button" id="${id}-cancel" data-ref="cancel" hidden>Cancel</button>
      </div>
    </section>
    <section class="card error-card" id="${id}-error" data-ref="error" hidden tabindex="-1" aria-labelledby="${id}-error-heading">
      <h2 id="${id}-error-heading">Something went wrong</h2>
      <p id="${id}-error-text" data-ref="errorText"></p>
    </section>`;
}

/**
 * Runs one job at a time for a tool, driving the cards made by statusHtml: progress, cancel,
 * errors (described for people). `onChange` is called when a run starts
 * or ends, to update buttons.
 */
export class Runner {
  private current: AbortController | null = null;
  private readonly r: Record<'progressCard' | 'progressText' | 'error' | 'errorText', HTMLElement>;
  private readonly bar: HTMLProgressElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly ctx: ToolContext;
  private readonly onChange: () => void;

  constructor(root: ParentNode, ctx: ToolContext, onChange: () => void) {
    this.ctx = ctx;
    this.onChange = onChange;
    const r = refs(root, ['progressCard', 'progress', 'progressText', 'cancel', 'error', 'errorText'] as const);
    this.r = r;
    this.bar = r.progress as HTMLProgressElement;
    this.cancelButton = r.cancel as HTMLButtonElement;
    this.cancelButton.addEventListener('click', () => {
      r.progressText.textContent = 'Cancelling…';
      this.current?.abort(new DOMException('Cancelled', 'AbortError'));
    });
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Run `work` with a fresh AbortSignal. Returns its result, or undefined when it failed (the
   * error card then says why) or was cancelled. `quiet` runs (probing a file) show no progress.
   */
  async run<T>(label: string, work: (signal: AbortSignal) => Promise<T>, opts: { quiet?: boolean; describe?: (err: unknown) => string | undefined } = {}): Promise<T | undefined> {
    if (this.current) return undefined;
    const ctl = new AbortController();
    this.current = ctl;
    this.clearError();
    this.onChange();
    if (!opts.quiet) {
      this.r.progressCard.hidden = false;
      this.bar.removeAttribute('value');
      this.r.progressText.textContent = label;
      this.cancelButton.hidden = false;
      this.cancelButton.focus();
      this.ctx.announce(label);
    }
    try {
      const out = await work(ctl.signal);
      if (!opts.quiet) {
        this.bar.max = 1;
        this.bar.value = 1;
      }
      return out;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.r.progressText.textContent = 'Cancelled.';
        this.ctx.announce('Cancelled.');
      } else {
        this.r.progressCard.hidden = true;
        this.error(opts.describe?.(err) ?? describeError(err));
      }
      return undefined;
    } finally {
      this.cancelButton.hidden = true;
      this.current = null;
      this.onChange();
    }
  }

  /** Update the progress bar; `value` null for indeterminate. */
  progress(value: number | null, max: number, text: string): void {
    if (value === null) this.bar.removeAttribute('value');
    else {
      this.bar.max = Math.max(1, max);
      this.bar.value = value;
    }
    this.r.progressText.textContent = text;
  }

  /** The run succeeded and its result is shown: the progress card goes. */
  done(text: string): void {
    this.r.progressText.textContent = text;
    this.r.progressCard.hidden = true;
  }

  hideProgress(): void {
    this.r.progressCard.hidden = true;
  }

  error(message: string): void {
    this.r.error.hidden = false;
    this.r.errorText.textContent = message;
    this.r.error.focus();
    this.ctx.announce(`Error: ${message}`);
  }

  clearError(): void {
    this.r.error.hidden = true;
  }
}

/** Primary action plus, where the browser can stream to disk, a "… to file" action. */
export function actionsHtml(id: string, label: string, icon: string): string {
  return `<div class="actions">
      <button type="submit" class="button primary" id="${id}-start" data-ref="start" disabled>${icon}${label}</button>
      <button type="button" class="button" id="${id}-save" data-ref="save" hidden disabled>${save}${label} to file…</button>
    </div>
    <p class="hint" data-ref="saveHint" hidden>“${label} to file” streams the result to disk, so large outputs never sit in memory.</p>`;
}

export function resultHtml(id: string, heading = 'Result'): string {
  return `<section class="card report" id="${id}-report" data-ref="report" hidden tabindex="-1" aria-labelledby="${id}-report-heading">
      <h2 id="${id}-report-heading">${heading}</h2>
      <table class="facts"><tbody id="${id}-facts" data-ref="facts"></tbody></table>
      <div class="row-actions">
        <a class="button primary download" id="${id}-download" data-ref="download" hidden>${download}<span data-ref="downloadText">Download</span></a>
        <button type="button" class="button" id="${id}-view" data-ref="view" hidden>${eye}View it</button>
      </div>
      <p id="${id}-saved-to" data-ref="savedTo" hidden></p>
    </section>`;
}

/** What a job that writes a PDF returns (see ../output.ts). */
export interface WrittenOutput {
  blob?: Blob;
  savedTo?: string;
  ms: number;
}

export type Fact = [label: string, value: string | Node, key?: string];

/** The result card made by resultHtml: a facts table and the download link or saved-to note. */
export class Result {
  private readonly r: Record<'report' | 'facts' | 'download' | 'downloadText' | 'view' | 'savedTo', HTMLElement>;
  private url: string | null = null;
  private blob: { blob: Blob; name: string } | null = null;

  /** `onView` opens a result kept in memory in the viewer. */
  constructor(root: ParentNode, onView?: (blob: Blob, name: string) => void) {
    this.r = refs(root, ['report', 'facts', 'download', 'downloadText', 'view', 'savedTo'] as const);
    this.r.view.addEventListener('click', () => this.blob && onView?.(this.blob.blob, this.blob.name));
    if (!onView) this.r.view.remove();
  }

  hide(): void {
    this.r.report.hidden = true;
  }

  show(facts: Fact[], out: WrittenOutput, name: string): void {
    const { report, download: link, downloadText, savedTo } = this.r;
    this.r.facts.textContent = '';
    for (const [label, value, key] of facts) {
      const tr = el('tr');
      if (key) tr.dataset.fact = key;
      const th = el('th', label);
      th.scope = 'row';
      const td = el('td');
      td.append(value);
      tr.append(th, td);
      this.r.facts.append(tr);
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    const a = link as HTMLAnchorElement;
    a.hidden = !out.blob;
    this.r.view.hidden = !out.blob;
    this.blob = out.blob ? { blob: out.blob, name } : null;
    savedTo.hidden = !out.savedTo;
    if (out.blob) {
      this.url = URL.createObjectURL(out.blob);
      a.href = this.url;
      a.download = name;
      a.dataset.bytes = String(out.blob.size);
      downloadText.textContent = `Download ${name} (${fmtBytes(out.blob.size)})`;
    }
    if (out.savedTo) savedTo.textContent = `Saved to ${out.savedTo}.`;
    report.hidden = false;
    report.focus({ preventScroll: true });
    report.scrollIntoView({ block: 'nearest' });
  }
}

/** Common facts of a written PDF. */
export function sizeFacts(inputBytes: number, outputBytes: number, ms: number): Fact[] {
  const pct = inputBytes ? ((outputBytes - inputBytes) / inputBytes) * 100 : 0;
  const change = !inputBytes ? '' : Math.abs(pct) < 0.05 ? ' (±0%)' : ` (${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`;
  return [
    ['Input', fmtBytes(inputBytes), 'input'],
    ['Output', `${fmtBytes(outputBytes)}${change}`, 'output'],
    ['Time', fmtDuration(ms), 'time'],
  ];
}

/** Warnings as a list, or null when there are none. */
export function warningsFact(warnings: string[], signed = false, repaired = false): Fact | null {
  const all = [...warnings];
  if (signed) all.unshift('The input was digitally signed. Its signatures are not valid in the output.');
  if (repaired && !all.some((w) => /xref|cross-reference/i.test(w))) all.push('The cross-reference table was damaged and has been rebuilt.');
  if (!all.length) return null;
  const ul = el('ul', undefined, 'warn');
  for (const w of all) ul.append(el('li', w));
  return ['Warnings', ul, 'warnings'];
}

/** "report.pdf" -> "report-<suffix>.pdf". */
export const outputName = (f: File, suffix: string): string => `${f.name.replace(/\.pdf$/i, '') || 'document'}-${suffix}.pdf`;

/**
 * Wire the start and "to file" buttons made by actionsHtml to `run`, which gets the file handle
 * to stream to (or none: keep the result in memory).
 */
export function wireActions(
  root: ParentNode,
  form: HTMLFormElement,
  ctx: ToolContext,
  run: (handle?: FileSystemFileHandle) => Promise<void>,
  suggestName: () => string | null,
  onPickError: (message: string) => void,
): { start: HTMLButtonElement; save: HTMLButtonElement } {
  const r = refs(root, ['start', 'save', 'saveHint'] as const);
  const start = r.start as HTMLButtonElement;
  const saveButton = r.save as HTMLButtonElement;
  saveButton.hidden = !ctx.canSaveToDisk;
  r.saveHint.hidden = !ctx.canSaveToDisk;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  saveButton.addEventListener('click', async () => {
    const name = suggestName();
    if (!name) return;
    try {
      const handle = await ctx.pickSaveFile(name);
      if (handle) await run(handle);
    } catch (err) {
      onPickError(`Could not open the save dialog. ${describeError(err)}`);
    }
  });
  return { start, save: saveButton };
}
