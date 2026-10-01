/**
 * The Compress tool: set the image limits, then keep the result in memory (download it, or view
 * it in place of the original) or stream it to a file picked with showSaveFilePicker. The work
 * happens in the worker (./job.ts).
 */
import type { CompressReport } from '../../../../../src/index.ts';
import { download, eye, minimize } from '../../../pages/icons.ts';
import { el, fmtBytes, fmtDuration, fmtInt, refs } from '../../format.ts';
import { actionsHtml, outputName, Runner, statusHtml, wireActions } from '../../kit.ts';
import type { Tool, ToolContext } from '../../tool.ts';
import type { CompressOutput, CompressSettings } from './job.ts';
import { skipLabel } from './reasons.ts';

const TEMPLATE = `
<form class="tool-form" data-ref="form" novalidate aria-label="Compress">
  <div class="fields two">
    <div class="field">
      <label for="compress-max-width">Max width</label>
      <div class="input-unit"><input type="number" id="compress-max-width" data-ref="maxWidth" min="1" step="1" value="1600" inputmode="numeric" required><span aria-hidden="true">px</span></div>
    </div>
    <div class="field">
      <label for="compress-max-height">Max height</label>
      <div class="input-unit"><input type="number" id="compress-max-height" data-ref="maxHeight" min="1" step="1" value="1600" inputmode="numeric" required><span aria-hidden="true">px</span></div>
    </div>
  </div>
  <div class="field">
    <label for="compress-quality">JPEG quality <output data-ref="qualityValue" for="compress-quality">0.75</output></label>
    <input type="range" id="compress-quality" data-ref="quality" min="0.05" max="1" step="0.05" value="0.75" aria-describedby="compress-quality-ends">
    <div class="range-ends" id="compress-quality-ends"><span>Smaller file</span><span>Better images</span></div>
  </div>
  <p class="hint">Images are scaled down to fit, never up, and only replaced when at least 10% smaller.</p>
  ${actionsHtml('compress', 'Compress', minimize)}
</form>
${statusHtml('compress')}
<section class="report" id="compress-report" data-ref="report" hidden tabindex="-1" aria-label="Compression result">
  <p class="result-headline"><span class="big" id="compress-saved-pct" data-ref="savedPct"></span><span class="muted" data-ref="savedText"></span></p>
  <div class="size-bars" aria-hidden="true">
    <div class="size-bar"><span>Before</span><div class="track"><div class="fill" data-ref="barIn"></div></div></div>
    <div class="size-bar out"><span>After</span><div class="track"><div class="fill" data-ref="barOut"></div></div></div>
  </div>
  <table class="facts">
    <tbody>
      <tr><th scope="row">Images found</th><td id="compress-r-seen" data-ref="rSeen"></td></tr>
      <tr><th scope="row">Recompressed</th><td id="compress-r-recompressed" data-ref="rRecompressed"></td></tr>
      <tr><th scope="row">Skipped</th><td id="compress-r-skipped" data-ref="rSkipped"></td></tr>
      <tr><th scope="row">Time</th><td data-ref="rTime"></td></tr>
      <tr data-ref="rWarningsRow" hidden><th scope="row">Warnings</th><td><ul class="warn" id="compress-r-warnings" data-ref="rWarnings"></ul></td></tr>
    </tbody>
  </table>
  <div class="row-actions">
    <a class="button primary download" id="compress-download" data-ref="download" hidden>${download}<span data-ref="downloadText">Download</span></a>
    <button type="button" class="button" id="compress-view" data-ref="view" hidden>${eye}View it</button>
  </div>
  <p id="compress-saved-to" data-ref="savedTo" hidden></p>
</section>`;

const REFS = [
  'form', 'maxWidth', 'maxHeight', 'quality', 'qualityValue', 'report', 'savedPct', 'savedText', 'barIn', 'barOut',
  'rSeen', 'rRecompressed', 'rSkipped', 'rTime', 'rWarningsRow', 'rWarnings', 'download', 'downloadText', 'view', 'savedTo',
] as const;

function mount(section: HTMLElement, ctx: ToolContext): void {
  section.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(section, REFS);
  const maxWidth = r.maxWidth as HTMLInputElement;
  const maxHeight = r.maxHeight as HTMLInputElement;
  const quality = r.quality as HTMLInputElement;
  const link = r.download as HTMLAnchorElement;
  let url: string | null = null;
  let result: { blob: Blob; name: string } | null = null;
  const runner = new Runner(section, ctx, () => refresh());

  const refresh = (): void => {
    const ready = !!ctx.doc.doc && !runner.busy;
    actions.start.disabled = !ready;
    actions.save.disabled = !ready;
  };

  const readSettings = (): CompressSettings | string => {
    const w = Math.floor(Number(maxWidth.value));
    const h = Math.floor(Number(maxHeight.value));
    const jpegQuality = Number(quality.value);
    if (!(w >= 1) || !(h >= 1)) return 'Max width and max height must be at least 1 pixel.';
    if (!(jpegQuality > 0 && jpegQuality <= 1)) return 'JPEG quality must be between 0 and 1.';
    return { maxWidth: w, maxHeight: h, jpegQuality };
  };

  const showReport = (out: CompressOutput, name: string): void => {
    const rep: CompressReport = out.report;
    const saved = rep.inputBytes - rep.outputBytes;
    const pct = rep.inputBytes ? (saved / rep.inputBytes) * 100 : 0;
    r.report.dataset.inputBytes = String(rep.inputBytes);
    r.report.dataset.outputBytes = String(rep.outputBytes);
    r.savedPct.textContent = saved > 0 ? `−${pct.toFixed(1)}%` : saved < 0 ? `+${Math.abs(pct).toFixed(1)}%` : '0%';
    r.savedPct.className = `big ${saved > 0 ? 'good' : 'warn'}`;
    r.savedText.textContent = saved > 0 ? `${fmtBytes(rep.inputBytes)} → ${fmtBytes(rep.outputBytes)}` : 'Nothing in this file could be made smaller.';
    const max = Math.max(rep.inputBytes, rep.outputBytes, 1);
    r.barIn.style.width = `${(rep.inputBytes / max) * 100}%`;
    r.barOut.style.width = `${(rep.outputBytes / max) * 100}%`;
    r.rSeen.textContent = fmtInt(rep.imagesSeen);
    r.rRecompressed.textContent = fmtInt(rep.imagesRecompressed);
    const skipped = Object.entries(rep.imagesSkipped).sort((a, b) => b[1] - a[1]);
    r.rSkipped.textContent = '';
    if (!skipped.length) r.rSkipped.textContent = '0';
    else {
      const ul = el('ul');
      for (const [reason, n] of skipped) {
        const li = el('li', `${fmtInt(n)} × ${skipLabel(reason)}`);
        li.title = reason;
        li.dataset.reason = reason;
        ul.append(li);
      }
      r.rSkipped.append(ul);
    }
    r.rTime.textContent = fmtDuration(out.ms);
    const warnings = [...rep.warnings];
    if (rep.signaturesInvalidated) warnings.unshift('The input was digitally signed. Its signatures are not valid in the output.');
    if (rep.xrefRepaired && !warnings.some((w) => /xref|cross-reference/i.test(w))) warnings.push('The cross-reference table was damaged and has been rebuilt.');
    r.rWarningsRow.hidden = !warnings.length;
    r.rWarnings.textContent = '';
    for (const w of warnings) r.rWarnings.append(el('li', w));

    if (url) URL.revokeObjectURL(url);
    url = null;
    result = out.blob ? { blob: out.blob, name } : null;
    link.hidden = r.view.hidden = !out.blob;
    r.savedTo.hidden = !out.savedTo;
    if (out.blob) {
      url = URL.createObjectURL(out.blob);
      link.href = url;
      link.download = name;
      link.dataset.bytes = String(out.blob.size);
      r.downloadText.textContent = `Download (${fmtBytes(out.blob.size)})`;
    }
    if (out.savedTo) r.savedTo.textContent = `Saved to ${out.savedTo}.`;
    r.report.hidden = false;
    runner.done(`Done in ${fmtDuration(out.ms)}.`);
    ctx.announce(saved > 0 ? `Done. ${pct.toFixed(0)}% smaller, ${fmtBytes(rep.outputBytes)}.` : 'Done. The file could not be made smaller.');
    r.report.focus({ preventScroll: true });
    r.report.scrollIntoView({ block: 'nearest' });
  };

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    const doc = ctx.doc.doc;
    if (!doc || runner.busy) return;
    const settings = readSettings();
    if (typeof settings === 'string') {
      runner.error(settings);
      return;
    }
    r.report.hidden = true;
    const name = outputName(doc.original, 'compressed');
    const out = await runner.run('Reading the document…', (signal) =>
      ctx.worker.run('compress', { file: doc.file, settings, ...(handle ? { handle } : {}) }, {
        signal,
        onProgress: (p) => {
          const pct = p.totalObjects ? Math.floor((p.processedObjects / p.totalObjects) * 100) : 0;
          runner.progress(p.processedObjects, p.totalObjects, `${pct}% · ${fmtBytes(p.bytesSaved)} saved so far`);
        },
      }),
    );
    if (out && ctx.doc.doc === doc) showReport(out, name);
  };

  const actions = wireActions(section, r.form as HTMLFormElement, ctx, run, () => (ctx.doc.doc ? outputName(ctx.doc.doc.original, 'compressed') : null), (m) => runner.error(m));
  quality.addEventListener('input', () => {
    r.qualityValue.textContent = Number(quality.value).toFixed(2);
  });
  r.view.addEventListener('click', () => result && ctx.openResult(result.blob, result.name));
  ctx.doc.subscribe(() => {
    r.report.hidden = true;
    runner.hideProgress();
    runner.clearError();
    refresh();
  });
  refresh();
}

export const compressTool: Tool = {
  id: 'compress',
  label: 'Compress',
  icon: minimize,
  summary: 'Make it smaller by downscaling its images.',
  mount,
};
