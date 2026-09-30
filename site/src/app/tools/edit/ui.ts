/**
 * The Pages & cleanup tool: keep, reorder and rotate pages, and remove metadata, JavaScript,
 * attachments and unused objects, all in one rewrite (./job.ts).
 */
import { scissors } from '../../../pages/icons.ts';
import { fmtBytes, fmtInt } from '../../format.ts';
import { actionsHtml, Drop, dropHtml, outputName, Result, resultHtml, Runner, sizeFacts, statusHtml, warningsFact, wireActions } from '../../kit.ts';
import type { Probe } from '../../probe.ts';
import { firstRepeat, pagesText, parseRanges } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';
import type { EditInput } from './job.ts';

const CLEANUP = [
  ['stripMetadata', 'Remove metadata', 'Title, author, dates, XMP and page thumbnails.'],
  ['removeJavaScript', 'Remove JavaScript', 'Document scripts and script actions on links, fields and pages.'],
  ['removeAttachments', 'Remove attachments', 'Embedded files and file attachment annotations.'],
  ['removeUnused', 'Remove unused objects', 'Leftovers that nothing refers to, such as old revisions.'],
  ['recompressStreams', 'Compress uncompressed streams', 'Flate-compresses page contents, fonts and images stored without compression.'],
  ['repairStreams', 'Repair broken streams', 'Fixes streams whose length is wrong or that are cut off.'],
] as const;

type CleanupKey = (typeof CLEANUP)[number][0];

const TEMPLATE = `
<div class="tool-layout">
  <form class="card" data-ref="form" novalidate aria-label="Edit pages and clean up a PDF">
    ${dropHtml('edit')}
    <fieldset class="options" data-ref="pagesSet">
      <legend>Pages</legend>
      <div class="fields">
        <div class="field wide">
          <label for="edit-keep">Pages to keep, in order</label>
          <input type="text" class="input" id="edit-keep" data-ref="keep" placeholder="All pages, e.g. 1-3, 6, 4" autocomplete="off" spellcheck="false" aria-describedby="edit-keep-note">
          <p class="field-note" id="edit-keep-note" data-ref="keepNote" aria-live="polite"></p>
        </div>
        <div class="field">
          <label for="edit-rotate">Rotate</label>
          <select class="input" id="edit-rotate" data-ref="rotate">
            <option value="0">Don’t rotate</option>
            <option value="90">90° clockwise</option>
            <option value="180">180°</option>
            <option value="270">90° counter-clockwise</option>
          </select>
        </div>
        <div class="field">
          <label for="edit-rotate-pages">Pages to rotate</label>
          <input type="text" class="input" id="edit-rotate-pages" data-ref="rotatePages" placeholder="All pages" autocomplete="off" spellcheck="false" aria-describedby="edit-rotate-note">
          <p class="field-note" id="edit-rotate-note" data-ref="rotateNote" aria-live="polite"></p>
        </div>
      </div>
      <p class="hint">Page numbers always refer to the original document. <code>5-2</code> runs backwards, <code>8-</code> runs to the last page.</p>
    </fieldset>
    <fieldset class="options">
      <legend>Clean up</legend>
      <div class="checks">
        ${CLEANUP.map(([key, label, hint]) => `<label class="check"><input type="checkbox" id="edit-${key}" data-ref="${key}"${key === 'removeUnused' ? ' checked' : ''}><span>${label}</span><small>${hint}</small></label>`).join('\n        ')}
      </div>
    </fieldset>
    ${actionsHtml('edit', 'Apply', scissors)}
  </form>
  <div class="stack">
    ${statusHtml('edit')}
    ${resultHtml('edit')}
  </div>
</div>`;

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const q = <T extends HTMLElement>(ref: string): T => panel.querySelector<T>(`[data-ref="${ref}"]`)!;
  const form = q<HTMLFormElement>('form');
  const keep = q<HTMLInputElement>('keep');
  const keepNote = q('keepNote');
  const rotate = q<HTMLSelectElement>('rotate');
  const rotatePages = q<HTMLInputElement>('rotatePages');
  const rotateNote = q('rotateNote');
  const checks = Object.fromEntries(CLEANUP.map(([key]) => [key, q<HTMLInputElement>(key)])) as Record<CleanupKey, HTMLInputElement>;

  let file: File | null = null;
  let probe: Probe | null = null;
  const result = new Result(panel);
  const runner = new Runner(panel, ctx, () => refresh());
  const drop = new Drop(panel, (files) => void choose(files[0]));

  /** The page selection, or an error message. */
  const readKeep = (): number[] | null | string => {
    if (!probe) return null;
    const sel = parseRanges(keep.value, probe.pageCount);
    if (typeof sel === 'string' || !sel) return sel;
    const twice = firstRepeat(sel);
    return twice ? `Page ${twice} is listed twice; each page can be kept once.` : sel;
  };
  const readRotate = (): EditInput['rotate'] | string | undefined => {
    const by = Number(rotate.value);
    rotatePages.disabled = !by || runner.busy;
    if (!by || !probe) return undefined;
    const pages = parseRanges(rotatePages.value, probe.pageCount);
    if (typeof pages === 'string') return pages;
    return pages ? { by, pages } : { by };
  };

  const notes = (): boolean => {
    const k = readKeep();
    const r = readRotate();
    keepNote.classList.toggle('bad', typeof k === 'string');
    keepNote.textContent = !probe ? '' : typeof k === 'string' ? k : k ? `The result has ${pagesText(k.length)}${k.length < probe.pageCount ? `, ${fmtInt(probe.pageCount - k.length)} removed` : ''}.` : `All ${pagesText(probe.pageCount)}, in their order.`;
    rotateNote.classList.toggle('bad', typeof r === 'string');
    rotateNote.textContent = typeof r === 'string' ? r : '';
    return typeof k !== 'string' && typeof r !== 'string';
  };

  const refresh = (): void => {
    const ready = !!file && !!probe && !probe.encrypted && !runner.busy;
    actions.start.disabled = !ready;
    actions.save.disabled = !ready;
    drop.disabled = runner.busy;
    notes();
  };

  const choose = async (f: File): Promise<void> => {
    if (runner.busy) return;
    file = f;
    probe = null;
    result.hide();
    runner.hideProgress();
    drop.show(f, `${fmtBytes(f.size)} · reading…`);
    const p = await runner.run('Reading the document…', (signal) => ctx.worker.run('probe', { file: f }, { signal }), { quiet: true });
    if (file !== f) return;
    probe = p ?? null;
    drop.show(f, p ? `${fmtBytes(f.size)} · ${pagesText(p.pageCount)} · choose or drop another file to replace it` : undefined);
    if (p?.encrypted) runner.error('This PDF is encrypted. Unlock it with the Unlock tool first, then edit the unlocked copy.');
    refresh();
  };

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    if (!file || !probe || runner.busy) return;
    const k = readKeep();
    const r = readRotate();
    if (typeof k === 'string' || typeof r === 'string') {
      runner.error(typeof k === 'string' ? k : (r as string));
      return;
    }
    const input: EditInput = { file, ...(k ? { keep: k } : {}), ...(r ? { rotate: r } : {}), ...(handle ? { handle } : {}) };
    for (const [key] of CLEANUP) if (checks[key].checked) input[key] = true;
    const f = file;
    result.hide();
    const out = await runner.run('Rewriting…', (signal) =>
      ctx.worker.run('edit', input, {
        signal,
        onProgress: (p) => runner.progress(p.processedObjects, p.totalObjects, `${p.totalObjects ? Math.floor((p.processedObjects / p.totalObjects) * 100) : 0}% · ${fmtInt(p.processedObjects)} of ${fmtInt(p.totalObjects)} objects`),
      }),
    );
    if (!out) return;
    const rep = out.report;
    const facts = sizeFacts(rep.inputBytes, rep.outputBytes, out.ms);
    facts.splice(2, 0, ['Pages', k ? `${fmtInt(k.length)} of ${fmtInt(probe.pageCount)}` : fmtInt(probe.pageCount), 'pages']);
    const w = warningsFact(rep.warnings, rep.signaturesInvalidated, rep.xrefRepaired);
    if (w) facts.push(w);
    runner.done('Done.');
    ctx.announce(`Done. ${fmtBytes(rep.outputBytes)}.`);
    result.show(facts, out, outputName(f, 'edited'));
  };

  const actions = wireActions(panel, form, ctx, run, () => (file ? outputName(file, 'edited') : null), (m) => runner.error(m));
  for (const input of [keep, rotatePages]) input.addEventListener('input', notes);
  rotate.addEventListener('change', notes);
  refresh();
}

export const editTool: Tool = {
  id: 'edit',
  label: 'Pages & cleanup',
  icon: scissors,
  summary: 'Keep, reorder and rotate pages, and remove metadata, JavaScript, attachments and leftovers. Everything else is copied byte for byte.',
  mount,
};
