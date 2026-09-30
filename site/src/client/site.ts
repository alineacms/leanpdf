/**
 * Progressive enhancements for the content pages (home, docs, benchmarks). Everything works
 * without this script: it adds copy buttons to code, collapses the docs table of contents on
 * small screens and highlights the section being read.
 */

function addCopyButton(container: HTMLElement, getText: () => string, label: string): void {
  if (!navigator.clipboard) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', label);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
  });
  container.append(button);
}

for (const block of document.querySelectorAll<HTMLElement>('.code')) {
  const code = block.querySelector('code');
  if (!code) continue;
  const head = block.querySelector<HTMLElement>('.code-head');
  const label = head?.querySelector('span')?.textContent;
  addCopyButton(head ?? block, () => code.textContent ?? '', label ? `Copy ${label} code` : 'Copy code');
}

const install = document.querySelector<HTMLElement>('.install');
const installCode = document.getElementById('install-cmd');
if (install && installCode) {
  addCopyButton(install, () => installCode.textContent ?? '', 'Copy install command');
}

// Docs: collapse the table of contents on narrow screens, highlight the current section.
const toc = document.querySelector<HTMLElement>('.toc');
if (toc) {
  const details = toc.querySelector('details');
  if (details && matchMedia('(max-width: 959px)').matches) details.open = false;
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) links.set(decodeURIComponent(a.hash.slice(1)), a);
  const headings = [...document.querySelectorAll<HTMLElement>('.prose h2[id], .prose h3[id]')].filter((h) => links.has(h.id));
  let current: HTMLAnchorElement | undefined;
  const update = (): void => {
    const y = 120;
    let active: HTMLElement | undefined;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= y) active = h;
      else break;
    }
    const link = active ? links.get(active.id) : undefined;
    if (link === current) return;
    current?.removeAttribute('aria-current');
    link?.setAttribute('aria-current', 'true');
    current = link;
  };
  let queued = false;
  addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    },
    { passive: true },
  );
  update();
}
