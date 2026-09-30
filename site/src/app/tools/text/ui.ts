/**
 * The Text tool: extract the text of a PDF (./job.ts), read it, search it, copy or download it.
 */
import type { PageText } from '../../../../../src/index.ts';
import { copy, download, fileText } from '../../../pages/icons.ts';
import { el, fmtBytes, fmtDuration, fmtInt, refs } from '../../format.ts';
import { Drop, dropHtml, Runner, statusHtml } from '../../kit.ts';
import type { Probe } from '../../probe.ts';
import { pagesText, parseRanges } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';

const MAX_HITS = 100;
const CONTEXT = 60;

const TEMPLATE = `
<div class="tool-layout">
  <form class="card" data-ref="form" novalidate aria-label="Extract text from a PDF">
    ${dropHtml('text')}
    <fieldset class="options">
      <legend>Pages</legend>
      <div class="field">
        <label for="text-pages">Pages to read</label>
        <input type="text" class="input" id="text-pages" data-ref="pages" placeholder="All pages, e.g. 1-5, 9" autocomplete="off" spellcheck="false" aria-describedby="text-pages-note">
        <p class="field-note" id="text-pages-note" data-ref="pagesNote" aria-live="polite"></p>
      </div>
      <p class="hint">Scanned pages are images and have no text.</p>
    </fieldset>
    <div class="actions">
      <button type="submit" class="button primary" id="text-start" data-ref="start" disabled>${fileText}Extract text</button>
    </div>
  </form>
  <div class="stack">
    ${statusHtml('text')}
    <section class="card report" id="text-report" data-ref="report" hidden tabindex="-1" aria-labelledby="text-report-heading">
      <h2 id="text-report-heading">Text</h2>
      <p class="muted" id="text-summary" data-ref="summary"></p>
      <div class="field">
        <label for="text-find">Find</label>
        <input type="search" class="input" id="text-find" data-ref="find" placeholder="Search the text" autocomplete="off" aria-describedby="text-find-note">
        <p class="field-note" id="text-find-note" data-ref="findNote" aria-live="polite"></p>
      </div>
      <ul class="hits" id="text-hits" data-ref="hits" aria-label="Matches"></ul>
      <textarea class="text-output" id="text-output" data-ref="output" readonly rows="16" aria-label="Extracted text" spellcheck="false"></textarea>
      <div class="row-actions">
        <button type="button" class="button" id="text-copy" data-ref="copy">${copy}<span data-ref="copyText">Copy</span></button>
        <a class="button" id="text-download" data-ref="download">${download}Download .txt</a>
      </div>
    </section>
  </div>
</div>`;

const REFS = ['form', 'pages', 'pagesNote', 'start', 'report', 'summary', 'find', 'findNote', 'hits', 'output', 'copy', 'copyText', 'download'] as const;

/** All the text, one block per page under a "Page n" line. */
const joined = (pages: PageText[]): string => pages.map((p) => `--- Page ${p.pageIndex + 1} ---\n${p.text}`).join('\n\n');

const countWords = (s: string): number => s.match(/\S+/g)?.length ?? 0;

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, REFS);
  const pagesInput = r.pages as HTMLInputElement;
  const start = r.start as HTMLButtonElement;
  const find = r.find as HTMLInputElement;
  const output = r.output as HTMLTextAreaElement;
  const link = r.download as HTMLAnchorElement;

  let file: File | null = null;
  let probe: Probe | null = null;
  let pages: PageText[] = [];
  let url: string | null = null;
  const runner = new Runner(panel, ctx, () => refresh());
  const drop = new Drop(panel, (files) => void choose(files[0]));

  const readPages = (): number[] | null | string => (probe ? parseRanges(pagesInput.value, probe.pageCount) : null);

  const refresh = (): void => {
    const sel = readPages();
    r.pagesNote.classList.toggle('bad', typeof sel === 'string');
    r.pagesNote.textContent = !probe ? '' : typeof sel === 'string' ? sel : sel ? `${pagesText(new Set(sel).size)} of ${fmtInt(probe.pageCount)}.` : `All ${pagesText(probe.pageCount)}.`;
    start.disabled = !file || !probe || probe.encrypted || runner.busy;
    drop.disabled = runner.busy;
  };

  const choose = async (f: File): Promise<void> => {
    if (runner.busy) return;
    file = f;
    probe = null;
    r.report.hidden = true;
    runner.hideProgress();
    drop.show(f, `${fmtBytes(f.size)} · reading…`);
    const p = await runner.run('Reading the document…', (signal) => ctx.worker.run('probe', { file: f }, { signal }), { quiet: true });
    if (file !== f) return;
    probe = p ?? null;
    drop.show(f, p ? `${fmtBytes(f.size)} · ${pagesText(p.pageCount)} · choose or drop another file to replace it` : undefined);
    if (p?.encrypted) runner.error('This PDF is encrypted. Unlock it with the Unlock tool first, then extract the text from the unlocked copy.');
    refresh();
  };

  const search = (): void => {
    const q = find.value.trim().toLowerCase();
    r.hits.textContent = '';
    if (!q) {
      r.findNote.textContent = '';
      return;
    }
    let total = 0;
    let pagesWith = 0;
    for (const p of pages) {
      const lower = p.text.toLowerCase();
      let at = lower.indexOf(q);
      if (at >= 0) pagesWith++;
      while (at >= 0) {
        total++;
        if (r.hits.childElementCount < MAX_HITS) {
          const li = el('li');
          const s = Math.max(0, at - CONTEXT);
          const e = Math.min(p.text.length, at + q.length + CONTEXT);
          li.append(el('b', `Page ${p.pageIndex + 1}: `), `${s > 0 ? '…' : ''}${p.text.slice(s, at).replace(/\s+/g, ' ')}`, el('mark', p.text.slice(at, at + q.length)), `${p.text.slice(at + q.length, e).replace(/\s+/g, ' ')}${e < p.text.length ? '…' : ''}`);
          r.hits.append(li);
        }
        at = lower.indexOf(q, at + q.length);
      }
    }
    r.findNote.textContent = total
      ? `${fmtInt(total)} ${total === 1 ? 'match' : 'matches'} on ${pagesText(pagesWith)}${total > MAX_HITS ? `, the first ${MAX_HITS} shown` : ''}.`
      : 'No matches.';
  };

  const run = async (): Promise<void> => {
    if (!file || !probe || runner.busy) return;
    const sel = readPages();
    if (typeof sel === 'string') {
      runner.error(sel);
      return;
    }
    const f = file;
    r.report.hidden = true;
    // extractText yields pages in document order, whatever order they were asked in.
    const wanted = sel ? [...new Set(sel)].sort((a, b) => a - b) : undefined;
    const out = await runner.run('Extracting text…', (signal) =>
      ctx.worker.run('text', { file: f, ...(wanted ? { pages: wanted } : {}) }, {
        signal,
        onProgress: (p) => runner.progress(p.done, p.total, `${fmtInt(p.done)} of ${pagesText(p.total)}`),
      }),
    );
    if (!out) return;
    pages = out.pages;
    const text = joined(pages);
    const chars = pages.reduce((n, p) => n + p.text.length, 0);
    const words = pages.reduce((n, p) => n + countWords(p.text), 0);
    const empty = pages.filter((p) => !p.text.trim()).length;
    r.summary.textContent = `${pagesText(pages.length)} · ${fmtInt(words)} words · ${fmtInt(chars)} characters · ${fmtDuration(out.ms)}` +
      (empty === pages.length ? '. No text found: the pages may be scanned images.' : empty ? `. ${pagesText(empty)} without text.` : '.');
    output.value = text;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    link.href = url;
    link.download = `${f.name.replace(/\.pdf$/i, '') || 'document'}.txt`;
    r.copyText.textContent = 'Copy';
    runner.done(`Done in ${fmtDuration(out.ms)}.`);
    ctx.announce(`Done. ${fmtInt(words)} words.`);
    r.report.hidden = false;
    search();
    r.report.focus({ preventScroll: true });
    r.report.scrollIntoView({ block: 'nearest' });
  };

  r.form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  pagesInput.addEventListener('input', refresh);
  find.addEventListener('input', search);
  r.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      r.copyText.textContent = 'Copied';
    } catch {
      output.select();
      r.copyText.textContent = 'Press Ctrl+C to copy';
    }
  });
  refresh();
}

export const textTool: Tool = {
  id: 'text',
  label: 'Text',
  icon: fileText,
  summary: 'Extract the text to search, copy or save it.',
  mount,
};
