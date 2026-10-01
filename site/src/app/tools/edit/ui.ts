/**
 * The Pages & cleanup tool: keep, reorder and rotate pages, and remove metadata, JavaScript,
 * attachments and unused objects, all in one rewrite (./job.ts).
 */
import { scissors } from '../../../pages/icons.ts';
import { fmtBytes, fmtInt } from '../../format.ts';
import { actionsHtml, outputName, Result, resultHtml, Runner, sizeFacts, statusHtml, warningsFact, wireActions } from '../../kit.ts';
import { firstRepeat, pagesText, parseRanges } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';
import type { EditInput } from './job.ts';

const CLEANUP = [
  ['stripMetadata', 'Remove metadata', 'Title, author, dates, XMP and page thumbnails.'],
  ['removeJavaScript', 'Remove JavaScript', 'Scripts and script actions.'],
  ['removeAttachments', 'Remove attachments', 'Embedded files.'],
  ['removeUnused', 'Remove unused objects', 'Leftovers nothing refers to, such as old revisions.'],
  ['recompressStreams', 'Compress uncompressed streams', 'Page contents, fonts and images stored as is.'],
  ['repairStreams', 'Repair broken streams', 'Wrong lengths, cut-off data.'],
] as const;

type CleanupKey = (typeof CLEANUP)[number][0];

const TEMPLATE = `
<form class="tool-form" data-ref="form" novalidate aria-label="Pages and cleanup">
  <div class="field">
    <label for="edit-keep">Pages to keep, in order</label>
    <input type="text" class="input" id="edit-keep" data-ref="keep" placeholder="All, e.g. 1-3, 6, 4" autocomplete="off" spellcheck="false" aria-describedby="edit-keep-note">
    <p class="field-note" id="edit-keep-note" data-ref="keepNote" aria-live="polite"></p>
  </div>
  <div class="fields two">
    <div class="field">
      <label for="edit-rotate">Rotate</label>
      <select class="input" id="edit-rotate" data-ref="rotate">
        <option value="0">No</option>
        <option value="90">90° right</option>
        <option value="180">180°</option>
        <option value="270">90° left</option>
      </select>
    </div>
    <div class="field">
      <label for="edit-rotate-pages">Which pages</label>
      <input type="text" class="input" id="edit-rotate-pages" data-ref="rotatePages" placeholder="All" autocomplete="off" spellcheck="false" aria-describedby="edit-rotate-note">
    </div>
  </div>
  <p class="field-note" id="edit-rotate-note" data-ref="rotateNote" aria-live="polite"></p>
  <p class="hint">Numbers refer to the pages as they are now. <code>5-2</code> runs backwards; <code>8-</code> runs to the end.</p>
  <fieldset class="checks">
    <legend>Clean up</legend>
    ${CLEANUP.map(([key, label, hint]) => `<label class="check"><input type="checkbox" id="edit-${key}" data-ref="${key}"${key === 'removeUnused' ? ' checked' : ''}><span>${label}</span><small>${hint}</small></label>`).join('\n    ')}
  </fieldset>
  ${actionsHtml('edit', 'Apply', scissors)}
</form>
${statusHtml('edit')}
${resultHtml('edit')}`;

function mount(section: HTMLElement, ctx: ToolContext): void {
  section.insertAdjacentHTML('beforeend', TEMPLATE);
  const q = <T extends HTMLElement>(ref: string): T => section.querySelector<T>(`[data-ref="${ref}"]`)!;
  const form = q<HTMLFormElement>('form');
  const keep = q<HTMLInputElement>('keep');
  const keepNote = q('keepNote');
  const rotate = q<HTMLSelectElement>('rotate');
  const rotatePages = q<HTMLInputElement>('rotatePages');
  const rotateNote = q('rotateNote');
  const checks = Object.fromEntries(CLEANUP.map(([key]) => [key, q<HTMLInputElement>(key)])) as Record<CleanupKey, HTMLInputElement>;
  const result = new Result(section, ctx.openResult);
  const runner = new Runner(section, ctx, () => refresh());
  const count = (): number => ctx.doc.doc?.probe.pageCount ?? 0;

  /** The page selection, or an error message. */
  const readKeep = (): number[] | null | string => {
    if (!count()) return null;
    const sel = parseRanges(keep.value, count());
    if (typeof sel === 'string' || !sel) return sel;
    const twice = firstRepeat(sel);
    return twice ? `Page ${twice} is listed twice; each page can be kept once.` : sel;
  };
  const readRotate = (): EditInput['rotate'] | string | undefined => {
    const by = Number(rotate.value);
    rotatePages.disabled = !by || runner.busy;
    if (!by || !count()) return undefined;
    const pages = parseRanges(rotatePages.value, count());
    if (typeof pages === 'string') return pages;
    return pages ? { by, pages } : { by };
  };

  const notes = (): void => {
    const k = readKeep();
    const r = readRotate();
    const n = count();
    keepNote.classList.toggle('bad', typeof k === 'string');
    keepNote.textContent = !n ? '' : typeof k === 'string' ? k : k ? `${pagesText(k.length)}${k.length < n ? `, ${fmtInt(n - k.length)} removed` : ''}.` : `All ${pagesText(n)}.`;
    rotateNote.classList.toggle('bad', typeof r === 'string');
    rotateNote.textContent = typeof r === 'string' ? r : '';
  };

  const refresh = (): void => {
    const ready = !!ctx.doc.doc && !runner.busy;
    actions.start.disabled = !ready;
    actions.save.disabled = !ready;
    notes();
  };

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    const doc = ctx.doc.doc;
    if (!doc || runner.busy) return;
    const k = readKeep();
    const r = readRotate();
    if (typeof k === 'string' || typeof r === 'string') {
      runner.error(typeof k === 'string' ? k : (r as string));
      return;
    }
    const input: EditInput = { file: doc.file, ...(k ? { keep: k } : {}), ...(r ? { rotate: r } : {}), ...(handle ? { handle } : {}) };
    for (const [key] of CLEANUP) if (checks[key].checked) input[key] = true;
    result.hide();
    const out = await runner.run('Rewriting…', (signal) =>
      ctx.worker.run('edit', input, {
        signal,
        onProgress: (p) => runner.progress(p.processedObjects, p.totalObjects, `${p.totalObjects ? Math.floor((p.processedObjects / p.totalObjects) * 100) : 0}%`),
      }),
    );
    if (!out || ctx.doc.doc !== doc) return;
    const rep = out.report;
    const facts = sizeFacts(rep.inputBytes, rep.outputBytes, out.ms);
    facts.splice(2, 0, ['Pages', k ? `${fmtInt(k.length)} of ${fmtInt(doc.probe.pageCount)}` : fmtInt(doc.probe.pageCount), 'pages']);
    const w = warningsFact(rep.warnings, rep.signaturesInvalidated, rep.xrefRepaired);
    if (w) facts.push(w);
    runner.done('Done.');
    ctx.announce(`Done. ${fmtBytes(rep.outputBytes)}.`);
    result.show(facts, out, outputName(doc.original, 'edited'));
  };

  const actions = wireActions(section, form, ctx, run, () => (ctx.doc.doc ? outputName(ctx.doc.doc.original, 'edited') : null), (m) => runner.error(m));
  for (const input of [keep, rotatePages]) input.addEventListener('input', notes);
  rotate.addEventListener('change', notes);
  ctx.doc.subscribe(() => {
    result.hide();
    runner.hideProgress();
    runner.clearError();
    refresh();
  });
  refresh();
}

export const editTool: Tool = {
  id: 'edit',
  label: 'Pages & cleanup',
  icon: scissors,
  summary: 'Keep, reorder and rotate pages; remove metadata and scripts.',
  mount,
};
