/**
 * The Merge tool: put the pages of several PDFs, in the order listed, into one (./job.ts). Each
 * file can contribute some of its pages, in any order.
 */
import { chevronDown, chevronUp, close, layers } from '../../../pages/icons.ts';
import { describeError, el, fmtBytes, fmtInt, refs } from '../../format.ts';
import { actionsHtml, Drop, dropHtml, Result, resultHtml, Runner, sizeFacts, statusHtml, warningsFact, wireActions } from '../../kit.ts';
import type { Probe } from '../../probe.ts';
import { pagesText, parseRanges } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';

const TEMPLATE = `
<div class="tool-layout">
  <form class="card" data-ref="form" novalidate aria-label="Merge PDFs">
    ${dropHtml('merge', { multiple: true, title: 'Choose PDFs or drop them here', hint: 'Add as many as you like, in one go or one by one. The files stay on this device.' })}
    <ol class="file-list" id="merge-list" data-ref="list" aria-label="Files to merge, in order"></ol>
    <p class="status-line" id="merge-total" data-ref="total" aria-live="polite"></p>
    ${actionsHtml('merge', 'Merge', layers)}
  </form>
  <div class="stack">
    ${statusHtml('merge')}
    ${resultHtml('merge')}
  </div>
</div>`;

interface Item {
  id: number;
  file: File;
  /** Page count and encryption, once known; a string when the file could not be read. */
  probe?: Probe | string;
  pages: string;
}

const iconButton = (icon: string, label: string, action: string): HTMLButtonElement => {
  const b = el('button', undefined, 'icon-button');
  b.type = 'button';
  b.dataset.action = action;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.insertAdjacentHTML('afterbegin', icon);
  return b;
};

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, ['form', 'list', 'total'] as const);

  let items: Item[] = [];
  let nextId = 1;
  const result = new Result(panel);
  const runner = new Runner(panel, ctx, () => refresh());
  const drop = new Drop(panel, (files) => add(files));

  /** An item's page selection, or an error message. */
  const selection = (it: Item): number[] | null | string => {
    if (typeof it.probe !== 'object') return null;
    return parseRanges(it.pages, it.probe.pageCount);
  };

  const problems = (): string[] => {
    const out: string[] = [];
    items.forEach((it, i) => {
      const n = `File ${i + 1} (${it.file.name})`;
      if (it.probe === undefined) out.push(`${n} is still being read.`);
      else if (typeof it.probe === 'string') out.push(`${n} can’t be read: ${it.probe}`);
      else if (it.probe.encrypted) out.push(`${n} is encrypted. Unlock it first.`);
      else if (typeof selection(it) === 'string') out.push(`${n}: ${selection(it)}`);
    });
    return out;
  };

  const refresh = (): void => {
    const ok = items.length > 0 && !problems().length && !runner.busy;
    actions.start.disabled = !ok;
    actions.save.disabled = !ok;
    drop.disabled = runner.busy;
    // Up on the first file and down on the last stay disabled (data-edge).
    for (const b of r.list.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) b.disabled = runner.busy || 'edge' in b.dataset;
    let pages = 0;
    for (const it of items) {
      const sel = selection(it);
      if (typeof it.probe === 'object' && typeof sel !== 'string') pages += sel ? sel.length : it.probe.pageCount;
    }
    r.total.textContent = items.length ? `${items.length} ${items.length === 1 ? 'file' : 'files'}, ${fmtBytes(items.reduce((n, it) => n + it.file.size, 0))} · the result has ${pagesText(pages)}.` : '';
  };

  const renderItem = (it: Item, i: number): HTMLLIElement => {
    const li = el('li', undefined, 'file-item');
    li.dataset.id = String(it.id);
    const name = el('div', it.file.name, 'name');
    const meta = el('span', undefined, 'meta');
    const sel = selection(it);
    if (it.probe === undefined) meta.textContent = `${fmtBytes(it.file.size)} · reading…`;
    else if (typeof it.probe === 'string') {
      meta.textContent = `Can’t be read: ${it.probe}`;
      meta.classList.add('bad');
    } else if (it.probe.encrypted) {
      meta.textContent = `${fmtBytes(it.file.size)} · encrypted: unlock it first`;
      meta.classList.add('bad');
    } else meta.textContent = `${fmtBytes(it.file.size)} · ${pagesText(it.probe.pageCount)}`;
    name.append(meta);
    const buttons = el('div', undefined, 'icon-buttons');
    const up = iconButton(chevronUp, `Move ${it.file.name} up`, 'up');
    const down = iconButton(chevronDown, `Move ${it.file.name} down`, 'down');
    if (i === 0) up.dataset.edge = '';
    if (i === items.length - 1) down.dataset.edge = '';
    buttons.append(up, down, iconButton(close, `Remove ${it.file.name}`, 'remove'));
    li.append(name, buttons);
    if (typeof it.probe === 'object' && !it.probe.encrypted) {
      const input = el('input', undefined, 'input');
      input.type = 'text';
      input.value = it.pages;
      input.placeholder = 'All pages, e.g. 1-3, 7';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.action = 'pages';
      input.setAttribute('aria-label', `Pages of ${it.file.name}`);
      const note = el('p', typeof sel === 'string' ? sel : '', `field-note${typeof sel === 'string' ? ' bad' : ''}`);
      note.dataset.note = '';
      li.append(input, note);
    }
    return li;
  };

  /** Re-render the list; `focus` keeps the keyboard on the moved file's button (or its other arrow at the ends). */
  const render = (focus?: { id: number; action: string }): void => {
    r.list.textContent = '';
    items.forEach((it, i) => r.list.append(renderItem(it, i)));
    refresh();
    if (focus) {
      const row = r.list.querySelector<HTMLElement>(`[data-id="${focus.id}"]`);
      const b = row?.querySelector<HTMLButtonElement>(`[data-action="${focus.action}"]`);
      (b && !b.disabled ? b : row?.querySelector<HTMLButtonElement>('[data-action="up"]:not(:disabled), [data-action="down"]:not(:disabled)'))?.focus();
    }
  };

  const add = (files: File[]): void => {
    if (runner.busy) return;
    result.hide();
    runner.clearError();
    const added = files.map((file) => ({ id: nextId++, file, pages: '' }) as Item);
    items = [...items, ...added];
    render();
    for (const it of added) {
      ctx.worker.run('probe', { file: it.file }).then(
        (p) => (it.probe = p),
        (e) => (it.probe = describeError(e)),
      ).finally(() => {
        if (items.includes(it)) render();
      });
    }
  };

  r.list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const li = b?.closest<HTMLElement>('[data-id]');
    if (!b || !li || runner.busy) return;
    const i = items.findIndex((it) => it.id === Number(li.dataset.id));
    const action = b.dataset.action;
    if (action === 'remove') {
      items.splice(i, 1);
      render();
      const next = items[Math.min(i, items.length - 1)];
      if (next) r.list.querySelector<HTMLElement>(`[data-id="${next.id}"] [data-action="remove"]`)?.focus();
      else drop.input.focus();
      return;
    }
    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render({ id: items[j].id, action: action! });
  });
  r.list.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const li = input.closest<HTMLElement>('[data-id]');
    const it = items.find((x) => x.id === Number(li?.dataset.id));
    if (!it || input.dataset.action !== 'pages') return;
    it.pages = input.value;
    const sel = selection(it);
    const note = li!.querySelector<HTMLElement>('[data-note]');
    if (note) {
      note.textContent = typeof sel === 'string' ? sel : '';
      note.classList.toggle('bad', typeof sel === 'string');
    }
    refresh();
  });

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    if (!items.length || runner.busy) return;
    const issues = problems();
    if (issues.length) {
      runner.error(issues[0]);
      return;
    }
    const inputs = items.map((it) => {
      const sel = selection(it) as number[] | null;
      return { file: it.file, ...(sel ? { pages: sel } : {}) };
    });
    const pageCount = items.reduce((n, it) => {
      const sel = selection(it) as number[] | null;
      return n + (sel ? sel.length : (it.probe as Probe).pageCount);
    }, 0);
    result.hide();
    const out = await runner.run('Merging…', (signal) =>
      ctx.worker.run('merge', { inputs, ...(handle ? { handle } : {}) }, {
        signal,
        onProgress: (p) => {
          const within = p.totalObjects ? p.processedObjects / p.totalObjects : 0;
          runner.progress(p.input + within, p.inputCount, `File ${p.input + 1} of ${p.inputCount} · ${Math.floor(within * 100)}%`);
        },
      }),
    );
    if (!out) return;
    const rep = out.report;
    const facts = sizeFacts(rep.inputBytes, rep.outputBytes, out.ms);
    facts[0][0] = `Input (${items.length} ${items.length === 1 ? 'file' : 'files'})`;
    facts.splice(2, 0, ['Pages', fmtInt(rep.pageCount || pageCount), 'pages']);
    const w = warningsFact(rep.warnings);
    if (w) facts.push(w);
    runner.done('Done.');
    ctx.announce(`Done. ${pagesText(rep.pageCount)}, ${fmtBytes(rep.outputBytes)}.`);
    result.show(facts, out, 'merged.pdf');
  };

  const actions = wireActions(panel, r.form as HTMLFormElement, ctx, run, () => (items.length ? 'merged.pdf' : null), (m) => runner.error(m));
  refresh();
}

export const mergeTool: Tool = {
  id: 'merge',
  label: 'Merge',
  icon: layers,
  summary: 'Combine PDFs into one, in the order you choose, taking all pages of each file or just some. Bookmarks and form fields come along.',
  mount,
};
