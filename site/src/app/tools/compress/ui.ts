/**
 * The Compress tool: choose a PDF, set the image limits, then either keep the result in memory
 * as a Blob (download link) or stream it to a file picked with showSaveFilePicker. The work
 * happens in the worker (./job.ts).
 */
import type { CompressReport, ProgressEvent } from '../../../../../src/index.ts';
import { describeError, el, fmtBytes, fmtDuration, fmtInt, refs } from '../../format.ts';
import type { Tool, ToolContext } from '../../tool.ts';
import { download, minimize, save, upload } from '../../../pages/icons.ts';
import type { CompressOutput, CompressSettings } from './job.ts';
import { skipLabel } from './reasons.ts';

const TEMPLATE = `
<div class="tool-layout">
  <form class="card" data-ref="form" novalidate aria-label="Compress a PDF">
    <label class="drop" data-ref="drop">
      <input type="file" id="compress-file" data-ref="file" accept="application/pdf,.pdf">
      ${upload}
      <span class="drop-title" data-ref="fileLabel">Choose a PDF or drop it here</span>
      <span class="small" id="compress-file-hint" data-ref="fileHint">Any size. The file stays on this device.</span>
    </label>
    <fieldset class="options">
      <legend>Images</legend>
      <div class="fields">
        <div class="field">
          <label for="compress-max-width">Max width</label>
          <div class="input-unit"><input type="number" id="compress-max-width" data-ref="maxWidth" min="1" step="1" value="1600" inputmode="numeric" required><span aria-hidden="true">px</span></div>
        </div>
        <div class="field">
          <label for="compress-max-height">Max height</label>
          <div class="input-unit"><input type="number" id="compress-max-height" data-ref="maxHeight" min="1" step="1" value="1600" inputmode="numeric" required><span aria-hidden="true">px</span></div>
        </div>
        <div class="field wide">
          <label for="compress-quality">JPEG quality <output data-ref="qualityValue" for="compress-quality">0.75</output></label>
          <input type="range" id="compress-quality" data-ref="quality" min="0.05" max="1" step="0.05" value="0.75" aria-describedby="compress-quality-ends">
          <div class="range-ends" id="compress-quality-ends"><span>Smaller files</span><span>Better images</span></div>
        </div>
      </div>
      <p class="hint">Larger images are scaled down to fit this box, never up. An image is only replaced when the result is at least 10% smaller, and everything else is copied byte for byte.</p>
    </fieldset>
    <div class="actions">
      <button type="submit" class="button primary" id="compress-start" data-ref="start" disabled>${minimize}Compress</button>
      <button type="button" class="button" id="compress-save" data-ref="save" hidden disabled>${save}Compress to file…</button>
    </div>
    <p class="hint" data-ref="saveHint" hidden>“Compress to file” writes the result to disk while it is being produced, so even a very large output never has to fit in memory.</p>
  </form>
  <div class="stack">
    <section class="card" id="compress-progress" data-ref="progressCard" hidden aria-labelledby="compress-progress-heading">
      <h2 id="compress-progress-heading">Progress</h2>
      <progress id="compress-progress-bar" data-ref="progress" max="1" value="0" aria-labelledby="compress-progress-heading"></progress>
      <div class="progress-row">
        <p id="compress-progress-text" data-ref="progressText"></p>
        <button type="button" class="button" id="compress-cancel" data-ref="cancel" hidden>Cancel</button>
      </div>
    </section>
    <section class="card error-card" id="compress-error" data-ref="error" hidden tabindex="-1" aria-labelledby="compress-error-heading">
      <h2 id="compress-error-heading">Something went wrong</h2>
      <p id="compress-error-text" data-ref="errorText"></p>
    </section>
    <section class="card report" id="compress-report" data-ref="report" hidden tabindex="-1" aria-labelledby="compress-report-heading">
      <h2 id="compress-report-heading">Result</h2>
      <p class="result-headline"><span class="big" id="compress-saved-pct" data-ref="savedPct"></span><span class="muted" data-ref="savedText"></span></p>
      <div class="size-bars" aria-hidden="true">
        <div class="size-bar"><span>Before</span><div class="track"><div class="fill" data-ref="barIn"></div></div></div>
        <div class="size-bar out"><span>After</span><div class="track"><div class="fill" data-ref="barOut"></div></div></div>
      </div>
      <table class="facts">
        <tbody>
          <tr><th scope="row">Input</th><td data-ref="rInput"></td></tr>
          <tr><th scope="row">Output</th><td data-ref="rOutput"></td></tr>
          <tr><th scope="row">Images found</th><td id="compress-r-seen" data-ref="rSeen"></td></tr>
          <tr><th scope="row">Images recompressed</th><td id="compress-r-recompressed" data-ref="rRecompressed"></td></tr>
          <tr><th scope="row">Images skipped</th><td id="compress-r-skipped" data-ref="rSkipped"></td></tr>
          <tr><th scope="row">Time</th><td data-ref="rTime"></td></tr>
          <tr><th scope="row">Peak memory</th><td id="compress-r-memory" data-ref="rMemory"></td></tr>
          <tr data-ref="rWarningsRow" hidden><th scope="row">Warnings</th><td><ul class="warn" id="compress-r-warnings" data-ref="rWarnings"></ul></td></tr>
        </tbody>
      </table>
      <a class="button primary download" id="compress-download" data-ref="download" hidden>${download}<span data-ref="downloadText">Download</span></a>
      <p id="compress-saved-to" data-ref="savedTo" hidden></p>
    </section>
  </div>
</div>`;

const REFS = [
  'form', 'drop', 'file', 'fileLabel', 'fileHint', 'maxWidth', 'maxHeight', 'quality', 'qualityValue', 'start', 'save', 'saveHint',
  'progressCard', 'progress', 'progressText', 'cancel', 'error', 'errorText', 'report', 'savedPct', 'savedText', 'barIn', 'barOut',
  'rInput', 'rOutput', 'rSeen', 'rRecompressed', 'rSkipped', 'rTime', 'rMemory', 'rWarningsRow', 'rWarnings', 'download', 'downloadText', 'savedTo',
] as const;

const outputName = (f: File): string => `${f.name.replace(/\.pdf$/i, '') || 'document'}-compressed.pdf`;

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, REFS);
  const ui = {
    ...r,
    file: r.file as HTMLInputElement,
    maxWidth: r.maxWidth as HTMLInputElement,
    maxHeight: r.maxHeight as HTMLInputElement,
    quality: r.quality as HTMLInputElement,
    start: r.start as HTMLButtonElement,
    save: r.save as HTMLButtonElement,
    cancel: r.cancel as HTMLButtonElement,
    progress: r.progress as HTMLProgressElement,
    download: r.download as HTMLAnchorElement,
  };

  let file: File | null = null;
  let running: AbortController | null = null;
  let downloadUrl: string | null = null;
  let showingReport = false;

  ui.save.hidden = !ctx.canSaveToDisk;
  ui.saveHint.hidden = !ctx.canSaveToDisk;

  const refresh = (): void => {
    const busy = running !== null;
    ui.start.disabled = busy || !file;
    ui.save.disabled = busy || !file;
    ui.file.disabled = busy;
    ui.cancel.hidden = !busy;
  };

  const setFile = (f: File | null): void => {
    file = f;
    ui.drop.classList.toggle('has-file', !!f);
    ui.fileLabel.textContent = f ? f.name : 'Choose a PDF or drop it here';
    ui.fileHint.textContent = f ? `${fmtBytes(f.size)} · choose or drop another file to replace it` : 'Any size. The file stays on this device.';
    refresh();
  };

  const readSettings = (): CompressSettings | string => {
    const maxWidth = Math.floor(Number(ui.maxWidth.value));
    const maxHeight = Math.floor(Number(ui.maxHeight.value));
    const jpegQuality = Number(ui.quality.value);
    if (!(maxWidth >= 1) || !(maxHeight >= 1)) return 'Max width and max height must be at least 1 pixel.';
    if (!(jpegQuality > 0 && jpegQuality <= 1)) return 'JPEG quality must be between 0 and 1.';
    return { maxWidth, maxHeight, jpegQuality };
  };

  const showError = (message: string): void => {
    ui.error.hidden = false;
    ui.errorText.textContent = message;
    ui.error.focus();
    ctx.announce(`Error: ${message}`);
  };

  const onProgress = (p: ProgressEvent): void => {
    ui.progress.max = Math.max(1, p.totalObjects);
    ui.progress.value = p.processedObjects;
    const pct = p.totalObjects ? Math.floor((p.processedObjects / p.totalObjects) * 100) : 0;
    ui.progressText.textContent = `${pct}% · ${fmtInt(p.processedObjects)} of ${fmtInt(p.totalObjects)} objects · ${fmtBytes(p.bytesSaved)} saved so far`;
  };

  const renderMemory = (): void => {
    if (showingReport) ui.rMemory.textContent = ctx.memory.peakSummary();
  };
  ctx.memory.subscribe(renderMemory);

  const showReport = (out: CompressOutput, input: File): void => {
    const rep: CompressReport = out.report;
    const saved = rep.inputBytes - rep.outputBytes;
    const pct = rep.inputBytes ? (saved / rep.inputBytes) * 100 : 0;
    showingReport = true;
    ui.report.hidden = false;
    ui.report.dataset.inputBytes = String(rep.inputBytes);
    ui.report.dataset.outputBytes = String(rep.outputBytes);
    ui.savedPct.textContent = saved > 0 ? `−${pct.toFixed(1)}%` : saved < 0 ? `+${Math.abs(pct).toFixed(1)}%` : '0%';
    ui.savedPct.className = `big ${saved > 0 ? 'good' : 'warn'}`;
    ui.savedText.textContent = saved > 0 ? `${fmtBytes(rep.inputBytes)} → ${fmtBytes(rep.outputBytes)}` : 'No reduction: nothing in this file could be made smaller.';
    const max = Math.max(rep.inputBytes, rep.outputBytes, 1);
    ui.barIn.style.width = `${(rep.inputBytes / max) * 100}%`;
    ui.barOut.style.width = `${(rep.outputBytes / max) * 100}%`;
    ui.rInput.textContent = `${fmtBytes(rep.inputBytes)} (${fmtInt(rep.inputBytes)} bytes)`;
    ui.rOutput.textContent = `${fmtBytes(rep.outputBytes)} (${fmtInt(rep.outputBytes)} bytes)`;
    ui.rSeen.textContent = fmtInt(rep.imagesSeen);
    ui.rRecompressed.textContent = fmtInt(rep.imagesRecompressed);
    const skipped = Object.entries(rep.imagesSkipped).sort((a, b) => b[1] - a[1]);
    ui.rSkipped.textContent = '';
    if (!skipped.length) ui.rSkipped.textContent = '0';
    else {
      const ul = el('ul');
      for (const [reason, n] of skipped) {
        const li = el('li', `${fmtInt(n)} × ${skipLabel(reason)}`);
        li.title = reason;
        li.dataset.reason = reason;
        ul.append(li);
      }
      ui.rSkipped.append(ul);
    }
    ui.rTime.textContent = fmtDuration(out.ms);
    renderMemory();
    const warnings = [...rep.warnings];
    if (rep.signaturesInvalidated) warnings.unshift('The input was digitally signed. Its signatures are not valid in the output.');
    if (rep.xrefRepaired && !warnings.some((w) => /xref|cross-reference/i.test(w))) warnings.push('The cross-reference table was damaged and has been rebuilt.');
    ui.rWarningsRow.hidden = !warnings.length;
    ui.rWarnings.textContent = '';
    for (const w of warnings) ui.rWarnings.append(el('li', w));

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    ui.download.hidden = !out.blob;
    ui.savedTo.hidden = !out.savedTo;
    if (out.blob) {
      downloadUrl = URL.createObjectURL(out.blob);
      ui.download.href = downloadUrl;
      ui.download.download = outputName(input);
      ui.download.dataset.bytes = String(out.blob.size);
      ui.downloadText.textContent = `Download ${outputName(input)} (${fmtBytes(out.blob.size)})`;
    }
    if (out.savedTo) ui.savedTo.textContent = `Saved to ${out.savedTo}.`;
    ui.progress.value = ui.progress.max;
    ui.progressText.textContent = `100% · done in ${fmtDuration(out.ms)}`;
    ctx.announce(saved > 0 ? `Done. ${pct.toFixed(0)}% smaller, ${fmtBytes(rep.outputBytes)}.` : 'Done. The file could not be made smaller.');
    ui.report.focus({ preventScroll: true });
    ui.report.scrollIntoView({ block: 'nearest' });
  };

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    if (!file || running) return;
    const settings = readSettings();
    ui.error.hidden = true;
    if (typeof settings === 'string') {
      showError(settings);
      return;
    }
    const input = file;
    const ctl = new AbortController();
    running = ctl;
    showingReport = false;
    refresh();
    ui.report.hidden = true;
    ui.progressCard.hidden = false;
    ui.progress.removeAttribute('value');
    ui.progressText.textContent = 'Reading the document…';
    ui.cancel.focus();
    ctx.announce('Compressing…');
    ctx.memory.begin();
    try {
      const out = await ctx.worker.run('compress', { file: input, settings, ...(handle ? { handle } : {}) }, { signal: ctl.signal, onProgress });
      showReport(out, input);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        ui.progressText.textContent = 'Cancelled.';
        ctx.announce('Cancelled.');
        ui.start.focus();
      } else {
        ui.progressCard.hidden = true;
        showError(describeError(err));
      }
    } finally {
      ctx.memory.end();
      running = null;
      refresh();
    }
  };

  ui.file.addEventListener('change', () => {
    const f = ui.file.files?.[0] ?? null;
    if (f) setFile(f);
  });
  ui.quality.addEventListener('input', () => {
    ui.qualityValue.textContent = Number(ui.quality.value).toFixed(2);
  });
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  ui.cancel.addEventListener('click', () => {
    ui.progressText.textContent = 'Cancelling…';
    running?.abort(new DOMException('Cancelled', 'AbortError'));
  });
  ui.save.addEventListener('click', async () => {
    if (!file || running) return;
    try {
      const handle = await ctx.pickSaveFile(outputName(file));
      if (handle) await run(handle);
    } catch (err) {
      showError(`Could not open the save dialog. ${describeError(err)}`);
    }
  });
  for (const t of ['dragenter', 'dragover'] as const) ui.drop.addEventListener(t, () => ui.drop.classList.toggle('over', !running));
  for (const t of ['dragleave', 'drop'] as const) ui.drop.addEventListener(t, () => ui.drop.classList.remove('over'));
  refresh();
}

export const compressTool: Tool = {
  id: 'compress',
  label: 'Compress',
  icon: minimize,
  summary: 'Make a PDF smaller by downscaling and re-encoding its images. Text, fonts and vector graphics are copied unchanged.',
  mount,
};
