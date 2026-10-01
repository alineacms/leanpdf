/**
 * The Document section: what the open PDF contains (./job.ts), read as soon as it opens:
 * metadata and flags, page sizes, bookmarks (which take the viewer to their page), attachments,
 * images, form fields and links. Images and attachments can be saved one by one. When the file
 * was encrypted, it says so and offers the decrypted copy the page works on.
 */
import type { FormField, OutlineItem } from '../../../../../src/index.ts';
import { download, info } from '../../../pages/icons.ts';
import { describeError, el, fmtBytes, fmtInt, refs } from '../../format.ts';
import { outputName, Runner, statusHtml } from '../../kit.ts';
import type { Tool, ToolContext } from '../../tool.ts';
import type { ExtractedFile, InspectOutput, PageSize, Section } from './job.ts';

const TEMPLATE = `
<div class="notice unlocked" id="inspect-unlocked" data-ref="unlocked" hidden>
  <p data-ref="unlockedText"></p>
  <a class="button" id="inspect-unlocked-download" data-ref="unlockedLink">${download}Download the decrypted copy</a>
</div>
${statusHtml('inspect')}
<div id="inspect-document" data-ref="docCard" hidden>
  <p class="tags" id="inspect-tags" data-ref="tags"></p>
  <table class="facts"><tbody id="inspect-facts" data-ref="facts"></tbody></table>
  <details class="metadata" data-ref="xmp" hidden><summary data-ref="xmpSummary">XMP metadata</summary><pre data-ref="xmpText"></pre></details>
</div>
<div class="sub-sections" id="inspect-sections" data-ref="sections"></div>`;

const PAPER: [string, number, number][] = [
  ['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['Letter', 612, 792], ['Legal', 612, 1008], ['Tabloid', 792, 1224],
];

/** "A4 portrait · 210 × 297 mm" for a page as shown (rotation applied). */
function pageSize(s: PageSize): string {
  const turned = s.rotate === 90 || s.rotate === 270;
  const w = turned ? s.height : s.width;
  const h = turned ? s.width : s.height;
  const [short, long] = w < h ? [w, h] : [h, w];
  const paper = PAPER.find(([, pw, ph]) => Math.abs(pw - short) <= 3 && Math.abs(ph - long) <= 3);
  const mm = (pt: number): number => Math.round((pt * 25.4) / 72);
  const orientation = Math.abs(w - h) < 1 ? 'square' : w < h ? 'portrait' : 'landscape';
  return `${paper ? `${paper[0]} ` : ''}${orientation} · ${mm(w)} × ${mm(h)} mm${s.rotate ? ` (rotated ${s.rotate}°)` : ''}`;
}

const fmtDate = (d: Date): string => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** A collapsible sub-section appended to `parent`; returns its body. */
function card(parent: HTMLElement, id: string, title: string, count?: number, open = false): HTMLElement {
  const section = el('details', undefined, 'sub');
  section.id = `inspect-${id}`;
  section.open = open;
  const summary = el('summary', count === undefined ? title : `${title} (${fmtInt(count)})`);
  summary.id = `inspect-${id}-heading`;
  section.append(summary);
  parent.append(section);
  return section;
}

function table(headers: string[], rows: (string | Node)[][], numeric: number[] = []): HTMLElement {
  const wrap = el('div', undefined, 'table-wrap scroll');
  const t = el('table');
  const head = el('tr');
  headers.forEach((h, i) => {
    const th = el('th', h, numeric.includes(i) ? 'num' : undefined);
    th.scope = 'col';
    head.append(th);
  });
  t.createTHead().append(head);
  const body = t.createTBody();
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((c, i) => {
      const td = el('td', undefined, numeric.includes(i) ? 'num' : undefined);
      td.append(c);
      tr.append(td);
    });
    body.append(tr);
  }
  wrap.append(t);
  return wrap;
}

function outlineList(items: OutlineItem[]): HTMLUListElement {
  const ul = el('ul');
  for (const it of items) {
    const li = el('li');
    if (it.pageIndex !== undefined) {
      // A bookmark with a page takes the viewer there.
      const b = el('button', it.title || '(untitled)', 'link-button');
      b.type = 'button';
      b.dataset.page = String(it.pageIndex);
      li.append(b, el('span', `p. ${it.pageIndex + 1}`, 'target'));
    } else {
      li.append(it.title || '(untitled)');
      if (it.url) li.append(el('span', it.url, 'target'));
    }
    if (it.children.length) li.append(outlineList(it.children));
    ul.append(li);
  }
  return ul;
}

const fieldValue = (f: FormField): string => {
  const v = f.value;
  if (f.type === 'signature') return f.signed ? 'signed' : 'not signed';
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join(', ') : v;
};

const FIELD_TYPES: Record<FormField['type'], string> = { text: 'Text', checkbox: 'Check box', radio: 'Radio buttons', choice: 'Choice', button: 'Push button', signature: 'Signature' };

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, ['unlocked', 'unlockedText', 'unlockedLink', 'docCard', 'tags', 'facts', 'xmp', 'xmpSummary', 'xmpText', 'sections'] as const);
  let file: File | null = null;
  let unlockedUrl: string | null = null;
  const runner = new Runner(panel, ctx, () => {});
  r.sections.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button[data-page]');
    if (b) ctx.goToPage(Number(b.dataset.page));
  });

  /** The section's value, or a note in `body` saying why it is missing. */
  function unwrap<T>(s: Section<T>, body: HTMLElement): T | undefined {
    if ('value' in s) return s.value;
    body.append(el('p', s.error.name === 'PdfEncryptedError' ? 'The document is encrypted, so this could not be read.' : `Could not be read: ${s.error.message}`, 'muted'));
    return undefined;
  }

  /** Run an extraction job and download its result. */
  const save = async (button: HTMLButtonElement, name: string, job: () => Promise<ExtractedFile>): Promise<void> => {
    button.disabled = true;
    try {
      const out = await job();
      const a = el('a');
      a.href = URL.createObjectURL(out.blob);
      a.download = out.ext && !name.toLowerCase().endsWith(`.${out.ext}`) ? `${name}.${out.ext}` : name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    } catch (err) {
      runner.error(describeError(err));
    } finally {
      button.disabled = false;
    }
  };

  const saveButton = (label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = el('button', undefined, 'button');
    b.type = 'button';
    b.insertAdjacentHTML('afterbegin', download);
    b.append('Save');
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  const showDocument = (out: InspectOutput, f: File): void => {
    const d = out.info;
    r.tags.textContent = '';
    const tags: string[] = [`PDF ${d.version}`];
    if (d.encrypted) tags.push('Encrypted');
    if (d.signed) tags.push('Signed');
    if (d.tagged) tags.push('Tagged');
    if (d.hasForms) tags.push('Form');
    if (d.hasJavaScript) tags.push('JavaScript');
    if (d.attachments) tags.push(`${d.attachments} ${d.attachments === 1 ? 'attachment' : 'attachments'}`);
    if (d.repaired) tags.push('Repaired');
    tags.forEach((t, i) => r.tags.append(el('span', t, `tag${i ? ' on' : ''}`)));
    const rows: [string, string][] = [
      ['Title', d.title ?? ''], ['Author', d.author ?? ''], ['Subject', d.subject ?? ''], ['Keywords', d.keywords ?? ''],
      ['Created with', d.creator ?? ''], ['Producer', d.producer ?? ''],
      ['Created', d.creationDate ? fmtDate(d.creationDate) : ''], ['Modified', d.modDate ? fmtDate(d.modDate) : ''],
      ['Language', d.language ?? ''], ['Pages', fmtInt(d.pageCount)], ['File size', `${fmtBytes(f.size)} (${fmtInt(f.size)} bytes)`],
      ...Object.entries(d.custom).map(([k, v]) => [k, v] as [string, string]),
    ];
    r.facts.textContent = '';
    for (const [label, value] of rows) {
      if (!value) continue;
      const tr = el('tr');
      const th = el('th', label);
      th.scope = 'row';
      tr.append(th, el('td', value));
      r.facts.append(tr);
    }
    if (d.warnings.length) {
      const tr = el('tr');
      const th = el('th', 'Notes');
      th.scope = 'row';
      const ul = el('ul', undefined, 'warn');
      for (const w of d.warnings) ul.append(el('li', w));
      const td = el('td');
      td.append(ul);
      tr.append(th, td);
      r.facts.append(tr);
    }
    r.xmp.hidden = !d.metadata;
    if (d.metadata) {
      r.xmpSummary.textContent = `XMP metadata (${fmtBytes(new TextEncoder().encode(d.metadata).length)})`;
      r.xmpText.textContent = d.metadata;
    }
    r.docCard.hidden = false;
  };

  const showSections = (out: InspectOutput, f: File): void => {
    const root = r.sections;
    root.textContent = '';
    const base = f.name.replace(/\.pdf$/i, '') || 'document';

    // Pages
    const sizes = 'value' in out.sizes ? out.sizes.value : undefined;
    const pagesBody = card(root, 'pages', 'Pages', out.info.pageCount);
    if (sizes) {
      if (sizes.length === 1) pagesBody.append(el('p', `All pages: ${pageSize(sizes[0])}.`));
      else pagesBody.append(table(['Size', 'Pages', 'First'], sizes.map((s) => [pageSize(s), fmtInt(s.count), `p. ${s.first}`]), [1, 2]));
    } else unwrap(out.sizes, pagesBody);

    // Bookmarks
    const outline = 'value' in out.outline ? out.outline.value : undefined;
    const outlineBody = card(root, 'outline', 'Bookmarks', outline?.total, !!outline?.total);
    if (outline) {
      if (!outline.total) outlineBody.append(el('p', 'None.', 'muted'));
      else {
        const box = el('div', undefined, 'scroll');
        const list = outlineList(outline.items);
        list.className = 'outline';
        box.append(list);
        outlineBody.append(box);
        if (outline.total > countItems(outline.items)) outlineBody.append(el('p', `The first ${fmtInt(countItems(outline.items))} are shown.`, 'hint'));
      }
    } else unwrap(out.outline, outlineBody);

    // Attachments
    const atts = 'value' in out.attachments ? out.attachments.value : undefined;
    const attBody = card(root, 'attachments', 'Attachments', atts?.length);
    if (atts) {
      if (!atts.length) attBody.append(el('p', 'None.', 'muted'));
      else
        attBody.append(
          table(
            ['File', 'Size', 'Type', ''],
            atts.map((a) => {
              const name = basename(a.filename);
              return [
                a.description ? `${name}: ${a.description}` : name,
                a.size !== undefined ? fmtBytes(a.size) : '',
                a.mimeType ?? '',
                saveButton(`Save ${name}`, (b) => void save(b, name, () => ctx.worker.run('attachment', { file: f, stream: a.handle.stream, ...(a.mimeType ? { type: a.mimeType } : {}) }))),
              ];
            }),
            [1],
          ),
        );
    } else unwrap(out.attachments, attBody);

    // Images
    const images = 'value' in out.images ? out.images.value : undefined;
    const imgBody = card(root, 'images', 'Images', images?.total);
    if (images) {
      if (!images.total) imgBody.append(el('p', 'None.', 'muted'));
      else {
        imgBody.append(el('p', `${fmtBytes(images.encodedBytes)} of image data.`, 'muted small'));
        imgBody.append(
          table(
            ['Object', 'Pixels', 'Color', 'Encoding', 'Size', 'Pages', ''],
            images.items.map((im) => [
              `#${im.num}`,
              `${fmtInt(im.width)} × ${fmtInt(im.height)}`,
              im.imageMask ? 'Stencil mask' : `${im.colorSpace ?? '?'}${im.bitsPerComponent && im.bitsPerComponent !== 8 ? `, ${im.bitsPerComponent}-bit` : ''}${im.hasSoftMask ? ', alpha' : ''}`,
              im.filters.join(' + ').replace(/Decode/g, '') || 'none',
              fmtBytes(im.encodedBytes),
              im.pages.length > 3 ? `${im.pages.slice(0, 3).map((p) => p + 1).join(', ')}, …` : im.pages.map((p) => p + 1).join(', '),
              saveButton(`Save image ${im.num}`, (b) => void save(b, `${base}-image-${im.num}`, () => ctx.worker.run('image', { file: f, num: im.num }))),
            ]),
            [1, 4],
          ),
        );
        if (images.total > images.items.length) imgBody.append(el('p', `The first ${fmtInt(images.items.length)} are shown.`, 'hint'));
        imgBody.append(el('p', 'JPEG and JPEG 2000 images are saved as stored; others are converted to PNG.', 'hint'));
      }
    } else unwrap(out.images, imgBody);

    // Form fields
    const fields = 'value' in out.fields ? out.fields.value : undefined;
    const fieldBody = card(root, 'fields', 'Form fields', fields?.total);
    if (fields) {
      if (!fields.total) fieldBody.append(el('p', 'None.', 'muted'));
      else {
        fieldBody.append(table(['Name', 'Type', 'Value'], fields.items.map((x) => [`${x.name}${x.required ? ' *' : ''}`, `${FIELD_TYPES[x.type]}${x.readOnly ? ', read-only' : ''}`, fieldValue(x)])));
        if (fields.total > fields.items.length) fieldBody.append(el('p', `The first ${fmtInt(fields.items.length)} are shown.`, 'hint'));
      }
    } else unwrap(out.fields, fieldBody);

    // Links
    const links = 'value' in out.links ? out.links.value : undefined;
    const linkBody = card(root, 'links', 'Links', links?.count);
    if (links) {
      if (!links.count) linkBody.append(el('p', 'None.', 'muted'));
      else {
        linkBody.append(el('p', `${fmtInt(links.internal)} to pages in this document, ${fmtInt(links.count - links.internal)} elsewhere.`, 'muted'));
        if (links.urls.length) {
          const ul = el('ul', undefined, 'url-list scroll');
          for (const u of links.urls) ul.append(el('li', u));
          linkBody.append(el('p', 'Web addresses:', 'small'), ul);
        }
      }
    } else unwrap(out.links, linkBody);
  };

  const inspect = async (f: File, shownAs: File): Promise<void> => {
    file = f;
    r.docCard.hidden = true;
    r.sections.textContent = '';
    const out = await runner.run('Reading the document…', (signal) => ctx.worker.run('inspect', { file: f }, { signal }), { quiet: true });
    if (!out || file !== f) return;
    showDocument(out, shownAs);
    showSections(out, f);
  };

  let shown = -1;
  ctx.doc.subscribe(() => {
    const doc = ctx.doc.doc;
    if (doc?.id === shown) return;
    shown = doc?.id ?? -1;
    if (unlockedUrl) URL.revokeObjectURL(unlockedUrl);
    unlockedUrl = null;
    r.unlocked.hidden = !doc?.unlocked;
    if (doc?.unlocked) {
      const how = doc.unlocked.method ? ` with ${doc.unlocked.method}` : '';
      const pw = doc.unlocked.password === 'owner' ? 'the owner password' : doc.unlocked.password === 'user' && doc.probe.needsPassword ? 'its password' : '';
      r.unlockedText.textContent = `This PDF is encrypted${how}. It was decrypted${pw ? ` with ${pw}` : ''} to show it, and the tools work on the decrypted copy.`;
      unlockedUrl = URL.createObjectURL(doc.file);
      const a = r.unlockedLink as HTMLAnchorElement;
      a.href = unlockedUrl;
      a.download = outputName(doc.original, 'decrypted');
    }
    if (doc) void inspect(doc.file, doc.original);
    else {
      file = null;
      r.docCard.hidden = true;
      r.sections.textContent = '';
    }
  });
}

const countItems = (items: OutlineItem[]): number => items.reduce((n, it) => n + 1 + countItems(it.children), 0);

export const inspectTool: Tool = {
  id: 'inspect',
  label: 'Document',
  icon: info,
  summary: 'Metadata, bookmarks, attachments, images, fields.',
  mount,
};
