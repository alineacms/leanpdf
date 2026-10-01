/**
 * The front page app: open a PDF (choose, drop or the sample), read it in the viewer, and work on
 * it with the toolbox next to it. Everything runs in a Web Worker (./client.ts); the document is
 * shared by the viewer and the tools (./document.ts).
 */
import { close, info, unlock as lockIcon, upload } from '../pages/icons.ts';
import { WorkerClient } from './client.ts';
import { DocStore, type DocState } from './document.ts';
import { el, fmtBytes, fmtInt, refs } from './format.ts';
import type { ToolContext } from './tool.ts';
import { TOOLS } from './tools.ts';
import { Viewer } from './viewer.ts';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

const root = document.getElementById('app');
const landing = document.getElementById('landing');
if (!root || !landing) throw new Error('app markup missing');
const picker = (globalThis as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;

// Screen-reader announcements.
const live = el('div', '', 'visually-hidden');
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
document.body.append(live);
const announce = (message: string): void => {
  live.textContent = '';
  // A fresh text node after clearing makes screen readers announce repeated messages too.
  setTimeout(() => (live.textContent = message), 50);
};

const worker = new WorkerClient();
const store = new DocStore(worker);

// ---------------------------------------------------------------------------------------------
// The workspace: viewer and toolbox

root.insertAdjacentHTML(
  'beforeend',
  `<div class="workspace" id="workspace" hidden>
  <section class="viewer-pane" aria-label="Document">
    <div class="viewer-bar" role="toolbar" aria-label="Document">
      <span class="doc-name" id="doc-name" data-ref="name"></span>
      <label class="page-field"><span class="visually-hidden">Page</span><input type="number" class="input" id="view-page" data-ref="page" min="1" value="1" inputmode="numeric"> <span>/ <span id="view-count" data-ref="count">–</span></span></label>
      <div class="zoom" role="group" aria-label="Zoom">
        <button type="button" class="icon-button" id="zoom-out" data-ref="zoomOut" aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" class="button small" id="zoom-fit" data-ref="zoomFit" title="Fit the width">Fit</button>
        <button type="button" class="icon-button" id="zoom-in" data-ref="zoomIn" aria-label="Zoom in" title="Zoom in">+</button>
      </div>
      <span class="bar-gap"></span>
      <label class="button small" title="Open another PDF">${upload}<span>Open</span><input type="file" id="open-another" data-ref="another" accept="application/pdf,.pdf" class="visually-hidden"></label>
      <button type="button" class="button small toolbox-toggle" id="toolbox-toggle" data-ref="toggle" aria-controls="toolbox" aria-expanded="false">${info}<span>Tools</span></button>
      <button type="button" class="icon-button" id="doc-close" data-ref="close" aria-label="Close the document" title="Close">${close}</button>
    </div>
    <p class="viewer-status muted small" id="view-status" data-ref="status" aria-live="polite"></p>
    <div class="viewer-scroll" id="viewer" data-ref="scroller" tabindex="0" aria-label="Pages"></div>
    <div class="viewer-message" id="viewer-message" data-ref="message" hidden></div>
  </section>
  <aside class="toolbox" id="toolbox" data-ref="toolbox" aria-label="Tools"></aside>
</div>`,
);
const w = refs(root, ['name', 'page', 'count', 'zoomOut', 'zoomFit', 'zoomIn', 'another', 'toggle', 'close', 'status', 'scroller', 'message', 'toolbox'] as const);
const workspace = document.getElementById('workspace')!;
const pageInput = w.page as HTMLInputElement;

const viewer = new Viewer(w.scroller, worker, {
  onPage(page, count) {
    if (document.activeElement !== pageInput) pageInput.value = String(page + 1);
    pageInput.max = String(count);
    w.count.textContent = fmtInt(count);
  },
  onStatus(text) {
    w.status.textContent = text;
  },
});

const ctx: ToolContext = {
  worker,
  doc: store,
  goToPage(page) {
    viewer.goTo(page);
    if (matchMedia('(max-width: 900px)').matches) setToolbox(false);
  },
  openResult(blob, name) {
    void store.open(new File([blob], name, { type: 'application/pdf' }));
  },
  announce,
  canSaveToDisk: typeof picker === 'function',
  async pickSaveFile(suggestedName) {
    if (!picker) return null;
    try {
      return await picker({ suggestedName, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
  },
};

// The toolbox: one collapsible section per tool, the first open.
for (const [i, tool] of TOOLS.entries()) {
  const section = el('details', undefined, 'tool');
  section.id = `tool-${tool.id}`;
  section.open = i === 0;
  const summary = el('summary');
  summary.insertAdjacentHTML('afterbegin', tool.icon);
  summary.append(el('span', tool.label, 'tool-name'), el('span', tool.summary, 'tool-summary'));
  const body = el('div', undefined, 'tool-body');
  section.append(summary, body);
  w.toolbox.append(section);
  tool.mount(body, ctx);
}

/** The toolbox is a side panel on wide screens and a sheet over the viewer on narrow ones. */
function setToolbox(open: boolean): void {
  workspace.classList.toggle('toolbox-open', open);
  w.toggle.setAttribute('aria-expanded', String(open));
}
w.toggle.addEventListener('click', () => setToolbox(!workspace.classList.contains('toolbox-open')));

// Viewer controls.
pageInput.addEventListener('change', () => viewer.goTo(Math.floor(Number(pageInput.value)) - 1));
w.zoomIn.addEventListener('click', () => {
  viewer.stepZoom(1);
  w.zoomFit.textContent = viewer.zoomLabel;
});
w.zoomOut.addEventListener('click', () => {
  viewer.stepZoom(-1);
  w.zoomFit.textContent = viewer.zoomLabel;
});
w.zoomFit.addEventListener('click', () => {
  viewer.setZoom(null);
  w.zoomFit.textContent = viewer.zoomLabel;
});
w.close.addEventListener('click', () => store.close());

// ---------------------------------------------------------------------------------------------
// Opening files: the landing page's picker and sample, "Open", and dropping anywhere

const open = (file: File | undefined): void => {
  if (file) void store.open(file);
};
for (const input of [document.getElementById('open-file'), w.another] as HTMLInputElement[]) {
  input?.addEventListener('change', () => {
    open(input.files?.[0]);
    input.value = '';
  });
}
document.getElementById('open-sample')?.addEventListener('click', async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  button.disabled = true;
  try {
    const res = await fetch('/sample.pdf');
    open(new File([await res.blob()], 'leanpdf-sample.pdf', { type: 'application/pdf' }));
  } finally {
    button.disabled = false;
  }
});

// Dropping a PDF anywhere opens it, except on the drop zones of tools that take files of their
// own (Merge), which handle it themselves.
let dragDepth = 0;
addEventListener('dragenter', (e: DragEvent) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
addEventListener('dragover', (e) => {
  if (!(e.target instanceof HTMLInputElement && e.target.type === 'file')) e.preventDefault();
});
addEventListener('drop', (e: DragEvent) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
  e.preventDefault();
  open([...(e.dataTransfer?.files ?? [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ?? e.dataTransfer?.files[0]);
});

// ---------------------------------------------------------------------------------------------
// Following the document

function message(content: Node | string | null): void {
  w.message.hidden = content === null;
  w.scroller.hidden = content !== null;
  w.message.replaceChildren(...(content === null ? [] : [content]));
}

function passwordForm(error?: string): HTMLElement {
  const form = el('form', undefined, 'password-form');
  form.innerHTML = `${lockIcon}<h2>This PDF is protected</h2><p>Enter its password to open it. It stays on this device.</p>
<div class="field"><label for="doc-password">Password</label><input type="password" class="input" id="doc-password" autocomplete="off" spellcheck="false"></div>
<p class="field-note bad" id="doc-password-error"></p>
<button type="submit" class="button primary" id="doc-password-submit">Open</button>`;
  const input = form.querySelector<HTMLInputElement>('#doc-password')!;
  form.querySelector('#doc-password-error')!.textContent = error ?? '';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void store.submitPassword(input.value);
  });
  setTimeout(() => input.focus(), 0);
  return form;
}

let shownId = -1;
store.subscribe((s: DocState) => {
  const active = s.kind !== 'empty';
  document.body.classList.toggle('has-doc', active);
  landing.hidden = active;
  workspace.hidden = !active;
  for (const more of document.querySelectorAll<HTMLElement>('.landing-more')) more.hidden = active;
  if (!active) {
    viewer.clear();
    shownId = -1;
    document.title = 'leanpdf · PDF tools in your browser';
    return;
  }
  const file = s.kind === 'open' ? s.doc.original : s.file;
  w.name.textContent = file.name;
  w.name.title = `${file.name} · ${fmtBytes(file.size)}`;
  document.title = `${file.name} · leanpdf`;
  if (s.kind === 'opening') {
    message(el('p', 'Opening…', 'muted'));
    w.count.textContent = '–';
    w.status.textContent = '';
  } else if (s.kind === 'failed') {
    message(el('p', s.message, 'error-text'));
    w.status.textContent = '';
  } else if (s.kind === 'locked') message(passwordForm(s.error));
  else {
    message(null);
    if (s.doc.id !== shownId) {
      shownId = s.doc.id;
      w.count.textContent = fmtInt(s.doc.probe.pageCount);
      pageInput.value = '1';
      void viewer.show(s.doc.file);
      announce(`${file.name} opened, ${fmtInt(s.doc.probe.pageCount)} pages.`);
      w.scroller.focus({ preventScroll: true });
    }
  }
});

root.dataset.state = 'ready';
