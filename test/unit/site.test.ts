/**
 * Build-time pieces of the website (site/): the Markdown converter used for the docs page, the
 * _headers rules and matcher, and the benchmark rendering.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { barChart, benchTable, corpusDescriptions, loadBench, type BenchRow } from '../../site/src/bench.ts';
import { headersFor, HEADERS_FILE, parseHeaders } from '../../site/src/headers.ts';
import { highlight } from '../../site/src/highlight.ts';
import { renderInline, renderMarkdown, slugify } from '../../site/src/markdown.ts';
import { docsMarkdown, renderDocs, resolveReadmeLink } from '../../site/src/pages/docs.ts';

describe('markdown', () => {
  test('inline code, links, bold, italics and escaping', () => {
    expect(renderInline('**Bold** and *em* and `a<b>` and [x](https://e.com/?a=1&b=2)')).toBe(
      '<strong>Bold</strong> and <em>em</em> and <code>a&lt;b&gt;</code> and <a href="https://e.com/?a=1&amp;b=2" rel="noopener">x</a>',
    );
    expect(renderInline('snake_case_name stays, _this_ is em')).toBe('snake_case_name stays, <em>this</em> is em');
    expect(renderInline('`**not bold**` <script>')).toBe('<code>**not bold**</code> &lt;script&gt;');
    expect(renderInline('[`code` link](#anchor)')).toBe('<a href="#anchor"><code>code</code> link</a>');
    expect(renderInline('[bad](javascript:alert(1))')).not.toContain('javascript:');
  });

  test('GitHub-style heading slugs', () => {
    expect(slugify('compressPdf(source, sink, options): Promise<CompressReport>')).toBe('compresspdfsource-sink-options-promisecompressreport');
    expect(slugify('I/O')).toBe('io');
    expect(slugify('Node and Bun')).toBe('node-and-bun');
    const seen = new Map<string, number>();
    expect([slugify('Usage', seen), slugify('Usage', seen), slugify('Usage', seen)]).toEqual(['usage', 'usage-1', 'usage-2']);
  });

  test('blocks: headings, lists with continuation lines, tables, code, comments', () => {
    const md = [
      '## Title `code`',
      '',
      '<!-- hidden -->',
      '',
      '- **One.** first line',
      '  continued',
      '- Two',
      '  - nested',
      '',
      '1. First',
      '   more',
      '2. Second',
      '',
      '| A | B | C |',
      '|---|--:|:-:|',
      '| `x\\|y` | 2 | **3** |',
      '',
      '```ts',
      "const a = '<b>'; // note",
      '```',
      '',
      'Para one',
      'continues.',
    ].join('\n');
    const { html, headings } = renderMarkdown(md);
    expect(headings).toEqual([{ level: 2, id: 'title-code', html: 'Title <code>code</code>', text: 'Title code' }]);
    expect(html).not.toContain('hidden');
    expect(html).toContain('<ul><li><strong>One.</strong> first line\ncontinued</li><li>Two\n<ul><li>nested</li></ul></li></ul>');
    expect(html).toContain('<ol><li>First\nmore</li><li>Second</li></ol>');
    expect(html).toContain('<th scope="col" class="align-right">B</th>');
    expect(html).toContain('<td><code>x|y</code></td><td class="align-right">2</td><td class="align-center"><strong>3</strong></td>');
    expect(html).toContain('<span class="tok-k">const</span> a = <span class="tok-s">&#39;&lt;b&gt;&#39;</span>; <span class="tok-c">// note</span>');
    expect(html).toContain('<p>Para one\ncontinues.</p>');
  });

  test('a table with an empty header row uses row headers', () => {
    const { html } = renderMarkdown('| | |\n|---|---|\n| Filters | none |');
    expect(html).not.toContain('<thead>');
    expect(html).toContain('<th scope="row">Filters</th><td>none</td>');
  });

  test('shell highlighting', () => {
    expect(highlight('npm install leanpdf   # or: bun add leanpdf', 'sh')).toBe(
      '<span class="tok-f">npm</span> install leanpdf   <span class="tok-c"># or: bun add leanpdf</span>',
    );
  });
});

describe('docs from README.md', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  test('every README section becomes a docs heading, with the intro as Overview', () => {
    const { headings, html } = renderDocs(readme);
    const expected = [...readme.matchAll(/^(##+) (.+)$/gm)].map((m) => m[2].replace(/`/g, '')).filter((t) => t !== 'Releasing');
    expect(headings[0].text).toBe('Overview');
    expect(headings.slice(1).map((h) => h.text)).toEqual(expected);
    expect(html).not.toContain('BENCHMARK-SUMMARY');
    expect(html).toContain('<table>');
  });

  test('section exclusion and link resolution', () => {
    const md = docsMarkdown('# T\n\nIntro\n\n## Keep\n\nk\n\n### Releasing\n\nsecret\n\n## Next\n\nn');
    expect(md).toBe('## Overview\n\nIntro\n\n## Keep\n\nk\n\n## Next\n\nn');
    expect(resolveReadmeLink('LICENSE')).toBe('https://github.com/benmerckx/leanpdf/blob/main/LICENSE');
    expect(resolveReadmeLink('#install')).toBe('#install');
    expect(resolveReadmeLink('https://sharp.pixelplumbing.com/')).toBe('https://sharp.pixelplumbing.com/');
  });
});

describe('_headers', () => {
  const rules = parseHeaders(HEADERS_FILE);

  test('every path is cross-origin isolated; hashed assets are immutable', () => {
    for (const path of ['/', '/app/', '/docs/', '/assets/app-0123456789.js', '/404.html']) {
      const h = headersFor(rules, path);
      expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(h.get('cross-origin-embedder-policy')).toBe('require-corp');
      expect(h.get('content-security-policy')).toContain("default-src 'self'");
    }
    expect(headersFor(rules, '/assets/app-0123456789.js').get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(headersFor(rules, '/app/').get('cache-control')).toBeNull();
  });

  test('Cloudflare Pages matching: splats, placeholders, merging and detaching', () => {
    const r = parseHeaders('/*\n  X-A: 1\n  X-B: b\n/blog/:slug\n  X-A: 2\n  ! X-B\n# comment\nhttps://example.com/x/*\n  X-C: c\n');
    expect(Object.fromEntries(headersFor(r, '/blog/post'))).toEqual({ 'x-a': '1, 2' });
    expect(Object.fromEntries(headersFor(r, '/blog/post/deeper'))).toEqual({ 'x-a': '1', 'x-b': 'b' });
    expect(Object.fromEntries(headersFor(r, '/x/y/z'))).toEqual({ 'x-a': '1', 'x-b': 'b', 'x-c': 'c' });
    expect(() => parseHeaders('  X-A: 1')).toThrow();
  });
});

describe('benchmarks', () => {
  const row = (tool: string, extra: Partial<BenchRow> = {}): BenchRow => ({
    file: 'a.pdf',
    tool,
    status: 'ok',
    seconds: 1.25,
    cpuSeconds: 2,
    peakMb: 100,
    inBytes: 10 << 20,
    outBytes: 2 << 20,
    valid: 'yes',
    psnr: 40,
    ...extra,
  });

  test('table: failures, infinite and missing PSNR', () => {
    const html = benchTable(
      [row('**leanpdf** (Bun)'), row('other', { psnr: 'Infinity', outBytes: 10 << 20 }), row('big', { psnr: null }), row('oom', { status: 'out of memory' })],
      'caption',
    );
    expect(html).toContain('<tr class="hl"><th scope="row"><strong>leanpdf</strong> (Bun)</th><td class="num">2.0 MB</td><td class="num">80%</td>');
    expect(html).toContain('<td class="num">∞</td>');
    expect(html).toContain('<td class="num">–</td>');
    expect(html).toContain('<td class="num status-bad" colspan="2">out of memory</td>');
  });

  test('chart: one labelled bar per tool, accessible description', () => {
    const svg = barChart([row('**leanpdf** (Bun)'), row('other', { peakMb: 400 }), row('oom', { status: 'timeout' })], { title: 'Peak', unit: 'MB', value: (r) => r.peakMb, format: (r) => `${r.peakMb} MB` }, 'x');
    expect(svg.match(/<path class="bar/g)).toHaveLength(2);
    expect(svg).toContain('class="bar hl"');
    expect(svg).toContain('<desc id="x-desc">leanpdf (Bun): 100 MB; other: 400 MB; oom: timeout</desc>');
    expect(svg).toContain('<text class="status"');
  });

  test('committed results and corpus descriptions load', () => {
    const data = loadBench();
    if (!data) return; // no bench/results.json yet: the page shows a notice instead
    expect(data.files.length).toBeGreaterThan(0);
    expect(corpusDescriptions().size).toBeGreaterThan(0);
  });
});
