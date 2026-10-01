/**
 * Build-time pieces of the website (site/): the Markdown converter used for the docs page, the
 * _headers rules and matcher, and the benchmark rendering.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { firstRepeat, parseRanges } from '../../site/src/app/ranges.ts';
import { barChart, benchTable, corpusDescriptions, FEATURES, featureSection, loadBench, loadFeatures, type BenchRow, type FeatureRow } from '../../site/src/bench.ts';
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
    // Excluded sections go with their subsections.
    const expected: string[] = [];
    let skip = 0;
    for (const m of readme.matchAll(/^(##+) (.+)$/gm)) {
      const level = m[1].length;
      const text = m[2].replace(/`/g, '');
      if (skip && level <= skip) skip = 0;
      if (!skip && (text === 'Releasing' || text === 'Benchmarks')) skip = level;
      if (!skip) expected.push(text);
    }
    expect(headings[0].text).toBe('Overview');
    expect(headings.slice(1).map((h) => h.text)).toEqual(expected);
    expect(html).not.toContain('BENCHMARK-SUMMARY');
    expect(html).toContain('<table>');
  });

  test('section exclusion and link resolution', () => {
    const md = docsMarkdown('# T\n\nIntro\n\n## Keep\n\nk\n\n### Releasing\n\nsecret\n\n## Next\n\nn');
    expect(md).toBe('## Overview\n\nIntro\n\n## Keep\n\nk\n\n## Next\n\nn');
    expect(resolveReadmeLink('LICENSE')).toBe('https://github.com/alineacms/leanpdf/blob/main/LICENSE');
    expect(resolveReadmeLink('#install')).toBe('#install');
    expect(resolveReadmeLink('#benchmarks')).toBe('/benchmarks/');
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
    // Every feature in the committed results has a description.
    for (const r of loadFeatures() ?? []) expect(FEATURES.some((f) => f.id === r.feature)).toBe(true);
  });

  test('feature section: charts on the largest job, a cell per tool and job', () => {
    const f = (tool: string, job: string, extra: Partial<FeatureRow> = {}): FeatureRow => ({
      feature: 'text', job, tool, status: 'ok', seconds: 0.5, cpuSeconds: 0.4, peakMb: 80, inBytes: job === 'big.pdf' ? 600 << 20 : 2 << 20, outBytes: 1000, valid: '–', ...extra,
    });
    const rows = [f('**leanpdf** (Node)', 'a.pdf'), f('**leanpdf** (Node)', 'big.pdf'), f('other', 'a.pdf'), f('other', 'big.pdf', { status: 'out of memory' })];
    const html = featureSection(rows, FEATURES.find((x) => x.id === 'text')!);
    expect(html).toContain('<h2 id="feature-text">Text extraction</h2>');
    expect(html).toContain('Wall time, big.pdf');
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain('<tr class="hl"><th scope="row"><strong>leanpdf</strong> (Node)</th><td class="num">0.50 s<br><span class="muted">80 MB</span></td>');
    expect(html).toContain('<td class="num status-bad">out of memory</td>');
    expect(featureSection(rows, FEATURES.find((x) => x.id === 'merge')!)).toBe('');
  });
});

describe('app page ranges', () => {
  test('1-based ranges in the order written, open ends, backwards ranges', () => {
    expect(parseRanges('', 5)).toBeNull();
    expect(parseRanges(' , ', 5)).toBeNull();
    expect(parseRanges('1-3, 5', 5)).toEqual([0, 1, 2, 4]);
    expect(parseRanges('4-, -2', 5)).toEqual([3, 4, 0, 1]);
    expect(parseRanges('3-1', 5)).toEqual([2, 1, 0]);
    expect(parseRanges('2 to 3', 5)).toEqual([1, 2]);
  });

  test('bad input gets a message', () => {
    expect(parseRanges('6', 5)).toBe('There is no page 6: pages are 1 to 5.');
    expect(parseRanges('0', 1)).toBe('This PDF has one page; there is no page 0.');
    expect(parseRanges('a', 5)).toBe('“a” is not a page number or a range like 2-5.');
    expect(parseRanges('-', 5)).toBe('“-” is not a page number or a range like 2-5.');
    expect(firstRepeat([0, 2, 0])).toBe(1);
    expect(firstRepeat([0, 1])).toBeUndefined();
  });
});
