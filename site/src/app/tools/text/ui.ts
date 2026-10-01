/**
 * The Text tool: extract the text of the open document (./job.ts), search it (a match takes the
 * viewer to its page), copy or download it.
 */
import type { PageText } from '../../../../../src/index.ts';
import { copy, download, fileText } from '../../../pages/icons.ts';
import { el, fmtDuration, fmtInt, refs } from '../../format.ts';
import { Runner, statusHtml } from '../../kit.ts';
import { pagesText, parseRanges } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';

const MAX_HITS = 100;
const CONTEXT = 60;

const TEMPLATE = `
<form class="tool-form" data-ref="form" novalidate aria-label="Extract text">
  <div class="field">
    <label for="text-pages">Pages</label>
    <input type="text" class="input" id="text-pages" data-ref="pages" placeholder="All, e.g. 1-5, 9" autocomplete="off" spellcheck="false" aria-describedby="text-pages-note">
    <p class="field-note" id="text-pages-note" data-ref="pagesNote" aria-live="polite"></p>
  </div>
  <div class="actions">
    <button type="submit" class="button primary" id="text-start" data-ref="start" disabled>${fileText}Extract text</button>
  </div>
</form>
${statusHtml('text')}
<section class="report" id="text-report" data-ref="report" hidden tabindex="-1" aria-label="Text">
  <p class="muted small" id="text-summary" data-ref="summary"></p>
  <div class="field">
    <label for="text-find">Find</label>
    <input type="search" class="input" id="text-find" data-ref="find" placeholder="Search the text" autocomplete="off" aria-describedby="text-find-note">
    <p class="field-note" id="text-find-note" data-ref="findNote" aria-live="polite"></p>
  </div>
  <ul class="hits" id="text-hits" data-ref="hits" aria-label="Matches"></ul>
  <textarea class="text-output" id="text-output" data-ref="output" readonly rows="10" aria-label="Extracted text" spellcheck="false"></textarea>
  <div class="row-actions">
    <button type="button" class="button" id="text-copy" data-ref="copy">${copy}<span data-ref="copyText">Copy</span></button>
    <a class="button" id="text-download" data-ref="download">${download}Download .txt</a>
  </div>
</section>`;

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

  let pages: PageText[] = [];
  let url: string | null = null;
  const runner = new Runner(panel, ctx, () => refresh());
  const count = (): number => ctx.doc.doc?.probe.pageCount ?? 0;

  const readPages = (): number[] | null | string => (count() ? parseRanges(pagesInput.value, count()) : null);

  const refresh = (): void => {
    const sel = readPages();
    const n = count();
    r.pagesNote.classList.toggle('bad', typeof sel === 'string');
    r.pagesNote.textContent = !n ? '' : typeof sel === 'string' ? sel : sel ? `${pagesText(new Set(sel).size)} of ${fmtInt(n)}.` : `All ${pagesText(n)}.`;
    start.disabled = !ctx.doc.doc || runner.busy;
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
          li.dataset.page = String(p.pageIndex);
          li.tabIndex = 0;
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
    const doc = ctx.doc.doc;
    if (!doc || runner.busy) return;
    const sel = readPages();
    if (typeof sel === 'string') {
      runner.error(sel);
      return;
    }
    const f = doc.original;
    r.report.hidden = true;
    // extractText yields pages in document order, whatever order they were asked in.
    const wanted = sel ? [...new Set(sel)].sort((a, b) => a - b) : undefined;
    const out = await runner.run('Extracting text…', (signal) =>
      ctx.worker.run('text', { file: doc.file, ...(wanted ? { pages: wanted } : {}) }, {
        signal,
        onProgress: (p) => runner.progress(p.done, p.total, `${fmtInt(p.done)} of ${pagesText(p.total)}`),
      }),
    );
    if (!out || ctx.doc.doc !== doc) return;
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
  // A match shows its page.
  const goToHit = (e: Event): void => {
    const li = (e.target as Element).closest<HTMLElement>('li[data-page]');
    if (li) ctx.goToPage(Number(li.dataset.page));
  };
  r.hits.addEventListener('click', goToHit);
  r.hits.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToHit(e);
  });
  ctx.doc.subscribe(() => {
    r.report.hidden = true;
    pages = [];
    runner.hideProgress();
    runner.clearError();
    refresh();
  });
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
  summary: 'Extract it to search, copy or save.',
  mount,
};
