/**
 * A minimal Markdown to HTML converter for the subset README.md uses: ATX headings, paragraphs,
 * (nested) bullet and ordered lists, GFM tables with alignment, fenced code blocks, block quotes,
 * rules, HTML comments (dropped), and inline code, links, autolinks, bold and italics.
 *
 * Headings get GitHub-compatible ids, so links to README anchors keep working on the site, and
 * are collected into a table of contents.
 */
import { codeBlock, escapeHtml } from './highlight.ts';

export interface Heading {
  level: number;
  id: string;
  /** Inline HTML of the heading text. */
  html: string;
  /** Plain text. */
  text: string;
}

export interface MarkdownOptions {
  /** Rewrite link targets (e.g. relative README links to GitHub URLs). */
  resolveLink?: (href: string) => string;
  /** Offset added to heading levels. */
  headingOffset?: number;
  /** Shared across calls, so ids stay unique on a page. */
  slugs?: Map<string, number>;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

// ---------------------------------------------------------------------------------------------
// Inline

const PH = '\u0000';

/** Plain text of inline Markdown (for slugs and titles). */
export function inlineText(md: string): string {
  return md
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1');
}

/** GitHub's heading anchor algorithm. */
export function slugify(text: string, slugs?: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  if (!slugs) return base;
  const n = slugs.get(base);
  slugs.set(base, (n ?? -1) + 1);
  return n === undefined ? base : `${base}-${n + 1}`;
}

function safeHref(href: string): string {
  return /^\s*(javascript|vbscript|data):/i.test(href) ? '#' : href;
}

export function renderInline(md: string, opts: MarkdownOptions = {}): string {
  const stash: string[] = [];
  const keep = (html: string): string => `${PH}${stash.push(html) - 1}${PH}`;
  const resolve = opts.resolveLink ?? ((h: string) => h);
  const link = (text: string, href: string): string => {
    const url = safeHref(resolve(href));
    const external = /^https?:\/\//.test(url);
    return `<a href="${escapeHtml(url)}"${external ? ' rel="noopener"' : ''}>${text}</a>`;
  };

  let s = md
    // Code spans first: their content is literal.
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => keep(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`))
    // Backslash escapes.
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, c: string) => keep(escapeHtml(c)))
    // Autolinks.
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) => keep(link(escapeHtml(url), url)));
  s = escapeHtml(s);
  // Images become links to the image (the site has no use for README images inline).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt: string, href: string) => keep(link(alt || href, unescape(href))));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text: string, href: string) => keep(link(text, unescape(href))));
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  // Restore stashed fragments (they may nest, e.g. code inside a link).
  const restore = (x: string): string => x.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_, i: string) => restore(stash[Number(i)]));
  return restore(s);
}

function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Blocks

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)[^\n]*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
const isBlank = (line: string): boolean => /^\s*$/.test(line);

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    /^\s*<!--/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_DELIM.test(next))
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

class Parser {
  readonly headings: Heading[] = [];
  readonly slugs: Map<string, number>;
  private readonly opts: MarkdownOptions;
  constructor(opts: MarkdownOptions) {
    this.opts = opts;
    this.slugs = opts.slugs ?? new Map();
  }

  inline(md: string): string {
    return renderInline(md, this.opts);
  }

  blocks(lines: string[], tight = false): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      // HTML comments are dropped.
      if (/^\s*<!--/.test(line)) {
        while (i < lines.length && !lines[i].includes('-->')) i++;
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const [, indent, marker, lang] = fence;
        const body: string[] = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) {
          body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
          i++;
        }
        i++;
        out.push(codeBlock(body.join('\n'), lang.toLowerCase()));
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(6, heading[1].length + (this.opts.headingOffset ?? 0));
        const text = inlineText(heading[2]);
        const id = slugify(text, this.slugs);
        const html = this.inline(heading[2]);
        this.headings.push({ level, id, html, text });
        out.push(`<h${level} id="${escapeHtml(id)}">${html}<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section"></a></h${level}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        out.push(this.table(head, align, rows));
        continue;
      }
      if (QUOTE.test(line)) {
        const body: string[] = [];
        while (i < lines.length && !isBlank(lines[i])) {
          const q = QUOTE.exec(lines[i]);
          body.push(q ? q[1] : lines[i]);
          i++;
        }
        out.push(`<blockquote>${this.blocks(body)}</blockquote>`);
        continue;
      }
      if (LIST_ITEM.test(line)) {
        i = this.list(lines, i, out);
        continue;
      }
      // Paragraph.
      const para: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) {
        para.push(lines[i].trim());
        i++;
      }
      const html = this.inline(para.join('\n'));
      out.push(tight ? html : `<p>${html}</p>`);
    }
    return out.join('\n');
  }

  private table(head: string[], align: string[], rows: string[][]): string {
    const attr = (j: number): string => (align[j] ? ` class="align-${align[j]}"` : '');
    const hasHead = head.some((c) => c !== '');
    let html = '<div class="table-wrap" tabindex="0"><table>';
    if (hasHead) html += `<thead><tr>${head.map((c, j) => `<th scope="col"${attr(j)}>${this.inline(c)}</th>`).join('')}</tr></thead>`;
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (let j = 0; j < head.length; j++) {
        const cell = this.inline(row[j] ?? '');
        // Without a header row, the first column labels the row.
        html += !hasHead && j === 0 ? `<th scope="row"${attr(j)}>${cell}</th>` : `<td${attr(j)}>${cell}</td>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table></div>`;
  }

  /** Parse a list starting at lines[start]; returns the index after it. */
  private list(lines: string[], start: number, out: string[]): number {
    const first = LIST_ITEM.exec(lines[start])!;
    const baseIndent = indentOf(lines[start]);
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? Number.parseInt(first[2], 10) : 1;
    const items: string[] = [];
    let loose = false;
    let i = start;
    while (i < lines.length) {
      const m = LIST_ITEM.exec(lines[i]);
      if (!m || indentOf(lines[i]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      const contentIndent = baseIndent + m[2].length + m[3].length;
      const body = [m[4]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          // A blank line continues the item only if indented content follows.
          const next = lines.slice(i + 1).find((x) => !isBlank(x));
          if (next !== undefined && indentOf(next) >= contentIndent) {
            body.push('');
            loose = true;
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) >= contentIndent) body.push(l.slice(Math.min(contentIndent, indentOf(l))));
        else if (LIST_ITEM.test(l) || startsBlock(l, lines[i + 1])) break;
        else body.push(l.trim()); // lazy continuation
        i++;
      }
      items.push(body.join('\n'));
      // Blank lines between items make the list loose.
      if (i < lines.length && isBlank(lines[i])) {
        const nextIdx = lines.findIndex((x, k) => k > i && !isBlank(x));
        const next = nextIdx >= 0 ? LIST_ITEM.exec(lines[nextIdx]) : null;
        if (next && indentOf(lines[nextIdx]) === baseIndent && /\d/.test(next[2]) === ordered) {
          loose = true;
          i = nextIdx;
        }
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    out.push(`<${tag}${startAttr}>${items.map((it) => `<li>${this.blocks(it.split('\n'), !loose)}</li>`).join('')}</${tag}>`);
    return i;
  }
}

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): Rendered {
  const p = new Parser(opts);
  const html = p.blocks(md.replace(/\r\n?/g, '\n').split('\n'));
  return { html, headings: p.headings };
}
