/**
 * App page script: renders one tab per tool from ./tools.ts (WAI-ARIA tabs, selected by the URL
 * hash, e.g. /app/#compress), mounts a tool the first time its tab is shown, and provides the
 * shared worker, memory monitor and helpers (./tool.ts).
 */
import { WorkerClient } from './client.ts';
import { el } from './format.ts';
import { MemoryMonitor } from './memory.ts';
import type { Tool, ToolContext } from './tool.ts';
import { TOOLS } from './tools.ts';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

const root = document.getElementById('app');
const memoryCard = document.getElementById('memory');
if (!root || !memoryCard) throw new Error('app markup missing');

const picker = (globalThis as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;

// Screen-reader announcements.
const live = el('div', '', 'visually-hidden');
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
document.body.append(live);

const ctx: ToolContext = {
  worker: new WorkerClient(),
  memory: new MemoryMonitor(memoryCard),
  announce(message) {
    live.textContent = '';
    // A fresh text node after clearing makes screen readers announce repeated messages too.
    setTimeout(() => {
      live.textContent = message;
    }, 50);
  },
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

// Environment notes under the memory table.
const env = el('ul', undefined, 'env');
env.id = 'environment';
env.append(
  el('li', `Cross-origin isolated: ${globalThis.crossOriginIsolated ? 'yes' : 'no'}`),
  el('li', `Stream the result to disk: ${ctx.canSaveToDisk ? 'available (showSaveFilePicker)' : 'not supported in this browser, results are kept in memory until you download them'}`),
  el('li', 'Image codec: BrowserImageCodec (createImageBitmap and OffscreenCanvas)'),
);
memoryCard.append(env);

// Dropping a file outside the drop zone would navigate away from the page.
for (const t of ['dragover', 'drop'] as const) {
  addEventListener(t, (e) => {
    if (!(e.target instanceof HTMLInputElement && e.target.type === 'file')) e.preventDefault();
  });
}

// Tabs.
const tablist = el('div', undefined, 'tabs');
tablist.setAttribute('role', 'tablist');
tablist.setAttribute('aria-label', 'Tools');
const tabs: HTMLButtonElement[] = [];
const panels: HTMLElement[] = [];
const mounted = new Set<string>();

for (const tool of TOOLS) {
  const tab = el('button', undefined, 'tab');
  tab.type = 'button';
  tab.id = `tab-${tool.id}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', `panel-${tool.id}`);
  tab.dataset.tool = tool.id;
  if (tool.icon) tab.insertAdjacentHTML('afterbegin', tool.icon);
  tab.append(tool.label);
  const panel = el('div', undefined, 'tab-panel');
  panel.id = `panel-${tool.id}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  panel.append(el('p', tool.summary, 'tool-intro'));
  tabs.push(tab);
  panels.push(panel);
  tablist.append(tab);
}

function select(tool: Tool, focus = false): void {
  TOOLS.forEach((t, i) => {
    const on = t === tool;
    tabs[i].setAttribute('aria-selected', String(on));
    tabs[i].tabIndex = on ? 0 : -1;
    panels[i].hidden = !on;
  });
  const i = TOOLS.indexOf(tool);
  if (!mounted.has(tool.id)) {
    mounted.add(tool.id);
    tool.mount(panels[i], ctx);
  }
  if (focus) tabs[i].focus();
}

const toolFromHash = (): Tool => TOOLS.find((t) => `#${t.id}` === location.hash) ?? TOOLS[0];

tablist.addEventListener('click', (e) => {
  const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]');
  const tool = TOOLS.find((t) => t.id === tab?.dataset.tool);
  if (!tool) return;
  history.replaceState(null, '', `#${tool.id}`);
  select(tool);
});
tablist.addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const tool = TOOLS[(next + TOOLS.length) % TOOLS.length];
  history.replaceState(null, '', `#${tool.id}`);
  select(tool, true);
});
addEventListener('hashchange', () => select(toolFromHash()));

root.textContent = '';
root.append(tablist, ...panels);
root.dataset.state = 'ready';
select(toolFromHash());
