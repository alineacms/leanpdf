import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { openPdf } from '../../src/core/open.ts';
import { getLinks, getOutline, type OutlineItem } from '../../src/features/outline.ts';
import { damage, DocBuilder, drawText } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import { BytesSource } from '../unit/util.ts';

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

/** Deterministic damaged copies: byte flips, truncations, deleted and duplicated ranges. */
function* mutants(src: Uint8Array, count: number, seed: number): Generator<Uint8Array> {
  const r = new Rng(seed);
  for (let i = 0; i < count; i++) {
    const at = r.int(0, src.length - 1);
    const len = r.int(1, 400);
    switch (i % 4) {
      case 0: {
        const m = src.slice();
        for (let k = 0; k < 12; k++) m[r.int(0, m.length - 1)] = r.int(0, 255);
        yield m;
        break;
      }
      case 1:
        yield src.slice(0, at);
        break;
      case 2:
        yield Buffer.concat([src.subarray(0, at), src.subarray(Math.min(src.length, at + len))]);
        break;
      default:
        yield Buffer.concat([src.subarray(0, at), src.subarray(at, at + len), src.subarray(at)]);
    }
  }
}

/** Run `fn` on damaged copies of `src`: each must settle with a value or an Error. */
async function survives(src: Uint8Array, seed: number, fn: (doc: Awaited<ReturnType<typeof open>>) => Promise<unknown>): Promise<number> {
  let ok = 0;
  for (const m of mutants(src, 80, seed)) {
    try {
      await fn(await open(m));
      ok++;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  }
  return ok;
}

function mu(b: Uint8Array): mupdf.PDFDocument {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  return mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
}

interface Simple {
  title: string;
  page?: number;
  uri?: string;
  down?: Simple[];
}

/** mupdf's outline, reduced to what we compare. */
function muOutline(m: mupdf.PDFDocument): Simple[] {
  const conv = (items: ReturnType<mupdf.Document['loadOutline']>): Simple[] =>
    (items ?? []).map((i) => {
      const s: Simple = { title: i.title ?? '' };
      if (i.page !== undefined && i.page >= 0) s.page = i.page;
      if (i.uri && !i.uri.startsWith('#')) s.uri = i.uri;
      // mupdf leaves named destinations unresolved in the outline; resolve them like links.
      if (s.page === undefined && i.uri?.startsWith('#')) {
        const p = m.resolveLink(i.uri);
        if (p >= 0) s.page = p;
      }
      if (i.down?.length) s.down = conv(i.down);
      return s;
    });
  return conv(m.loadOutline());
}

function ours(items: OutlineItem[]): Simple[] {
  return items.map((i) => {
    const s: Simple = { title: i.title };
    if (i.pageIndex !== undefined) s.page = i.pageIndex;
    if (i.url !== undefined) s.uri = i.url;
    if (i.children.length) s.down = ours(i.children);
    return s;
  });
}

/**
 * Four pages; named destinations in a name tree with Kids and /Limits (one leaf with wrong
 * limits, one key with non-ASCII bytes), optionally a legacy /Dests dictionary, and an outline
 * that uses every kind of destination.
 */
function namedDestDoc(legacy = true): { bytes: Uint8Array; pages: number[] } {
  const b = new DocBuilder();
  for (let i = 0; i < 4; i++) b.page({ content: drawText(`page ${i + 1}`, 20, 20) });
  const [p0, p1, p2, p3] = b.pages;
  const leafA = b.obj(`<< /Limits [(a1) (a3)] /Names [(a1) [${p0} 0 R /XYZ 0 792 0] (a2) ${b.obj(`[${p1} 0 R /Fit]`)} 0 R (a3) [${p2} 0 R /FitH 5]] >>`);
  const leafB = b.obj(`<< /Limits [(b1) (b2)] /Names [(b1) [${p2} 0 R /Fit] (b2) << /D [${p3} 0 R /Fit] >>] >>`);
  // Wrong limits: the key is only found by the fallback scan.
  const leafC = b.obj(`<< /Limits [(y) (z)] /Names [(c1) [${p3} 0 R /Fit] <C3A9> [${p1} 0 R /Fit]] >>`);
  const mid = b.obj(`<< /Limits [(a1) (b2)] /Kids [${leafA} 0 R ${leafB} 0 R] >>`);
  const tree = b.obj(`<< /Kids [${mid} 0 R ${leafC} 0 R] >>`);

  const root = b.alloc();
  const [c1, c11, c12, c13, c2, c21, c22, c23, c3, c4] = Array.from({ length: 10 }, () => b.alloc());
  b.setObj(c1, `<< /Title (Chapter 1) /Parent ${root} 0 R /Next ${c2} 0 R /First ${c11} 0 R /Last ${c13} 0 R /Count 3 /Dest [${p0} 0 R /XYZ null null null] >>`);
  b.setObj(c11, `<< /Title (Named string) /Parent ${c1} 0 R /Next ${c12} 0 R /Dest (a2) >>`);
  b.setObj(c12, `<< /Title (GoTo named) /Parent ${c1} 0 R /Prev ${c11} 0 R /Next ${c13} 0 R /A << /S /GoTo /D (b1) >> >>`);
  b.setObj(c13, `<< /Title (Legacy name) /Parent ${c1} 0 R /Prev ${c12} 0 R /Dest /legacy >>`);
  // UTF-16 title, URI with UTF-8 bytes, closed.
  b.setObj(c2, `<< /Title <FEFF0043006800E2007000EE0074007200650020D83DDE00> /Parent ${root} 0 R /Prev ${c1} 0 R /Next ${c3} 0 R /First ${c21} 0 R /Last ${c23} 0 R /Count -3 /A << /S /URI /URI (https://example.com/\\303\\274ber?q=1) >> >>`);
  b.setObj(c21, `<< /Title (Wrong limits) /Parent ${c2} 0 R /Next ${c22} 0 R /Dest (c1) >>`);
  b.setObj(c22, `<< /Title (Non-ASCII name) /Parent ${c2} 0 R /Next ${c23} 0 R /Dest (\\303\\251) >>`);
  b.setObj(c23, `<< /Title (Dest dictionary) /Parent ${c2} 0 R /Dest (b2) >>`);
  b.setObj(c3, `<< /Title (Missing) /Parent ${root} 0 R /Prev ${c2} 0 R /Next ${c4} 0 R /Dest (nope) >>`);
  b.setObj(c4, `<< /Title (PDFDoc \\200 \\(x\\)) /Parent ${root} 0 R /Prev ${c3} 0 R /A << /S /GoTo /D [${p3} 0 R /Fit] >> >>`);
  b.setObj(root, `<< /Type /Outlines /First ${c1} 0 R /Last ${c4} 0 R /Count 4 >>`);
  b.catalogExtra = ` /Outlines ${root} 0 R /Names << /Dests ${tree} 0 R >>${legacy ? ` /Dests << /legacy [${p1} 0 R /Fit] >>` : ''}`;
  return { bytes: b.finish().build().bytes, pages: b.pages };
}

const EXPECTED: OutlineItem[] = [
  {
    title: 'Chapter 1',
    pageIndex: 0,
    open: true,
    children: [
      { title: 'Named string', pageIndex: 1, children: [] },
      { title: 'GoTo named', pageIndex: 2, children: [] },
      { title: 'Legacy name', pageIndex: 1, children: [] },
    ],
  },
  {
    title: 'Châpître \u{1f600}',
    url: 'https://example.com/über?q=1',
    open: false,
    children: [
      { title: 'Wrong limits', pageIndex: 3, children: [] },
      { title: 'Non-ASCII name', pageIndex: 1, children: [] },
      { title: 'Dest dictionary', pageIndex: 3, children: [] },
    ],
  },
  { title: 'Missing', children: [] },
  { title: 'PDFDoc • (x)', pageIndex: 3, children: [] },
];

describe('getOutline', () => {
  test('resolves explicit, named (tree and legacy) and action destinations, like mupdf', async () => {
    const got = await getOutline(await open(namedDestDoc().bytes));
    expect(got).toEqual(EXPECTED);
    // mupdf ignores the /Dests name tree when the catalog also has a legacy /Dests dictionary,
    // so compare with it on the variant without one.
    const bytes = namedDestDoc(false).bytes;
    const plain = await getOutline(await open(bytes));
    expect(plain[0].children[2]).toEqual({ title: 'Legacy name', children: [] });
    const m = mu(bytes);
    expect(ours(plain)).toEqual(muOutline(m));
    m.destroy();
  });

  test('object streams, xref streams and a damaged xref give the same outline', async () => {
    const { bytes } = namedDestDoc();
    const variants = [damage.startxref(bytes, 3)];
    if (hasQpdf) variants.push(qpdfTransform(bytes, ['--object-streams=generate']));
    for (const v of variants) expect(await getOutline(await open(v))).toEqual(EXPECTED);
  });

  test('an outline written by mupdf', async () => {
    const doc = new mupdf.PDFDocument();
    for (let i = 0; i < 5; i++) doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, doc.newDictionary(), ''));
    const it = doc.outlineIterator();
    it.insert({ title: 'One', uri: '#page=1', open: true });
    it.insert({ title: 'Two ✓', uri: '#page=4', open: true });
    it.insert({ title: 'Web', uri: 'https://example.org/a b', open: false });
    it.prev();
    it.prev();
    it.prev();
    it.down();
    it.insert({ title: 'One.a', uri: '#page=2', open: false });
    it.insert({ title: 'One.b', uri: '#page=5', open: false });
    it.destroy();
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const got = await getOutline(await open(bytes));
    const m = mu(bytes);
    expect(ours(got)).toEqual(muOutline(m));
    m.destroy();
    expect(got.map((i) => i.title)).toEqual(['One', 'Two ✓', 'Web']);
    expect(got[0].children.map((i) => i.pageIndex)).toEqual([1, 4]);
  });

  test('cycles, broken items, deep nesting and long sibling lists', async () => {
    const b = new DocBuilder();
    b.page({ content: '' });
    const root = b.alloc();
    // A deep chain: every item is the only child of the previous one.
    const deep = Array.from({ length: 200 }, () => b.alloc());
    deep.forEach((n, i) => b.setObj(n, `<< /Title (d${i}) /Dest [${b.pages[0]} 0 R /Fit] ${i + 1 < deep.length ? `/First ${deep[i + 1]} 0 R /Count 1` : `/First ${deep[0]} 0 R`} >>`));
    // Many siblings, the last pointing back to the first.
    const wide = Array.from({ length: 3000 }, () => b.alloc());
    wide.forEach((n, i) => b.setObj(n, `<< /Title (w${i}) /Next ${wide[(i + 1) % wide.length]} 0 R >>`));
    const broken = b.obj(`<< /Title 42 /Next 999 0 R /Dest [(x)] >>`);
    const top = b.obj(`<< /Title (top) /First ${deep[0]} 0 R /Next ${wide[0]} 0 R >>`);
    b.setObj(wide[wide.length - 1], `<< /Title (last) /Next ${broken} 0 R >>`);
    b.setObj(root, `<< /First ${top} 0 R >>`);
    b.catalogExtra = ` /Outlines ${root} 0 R`;
    const got = await getOutline(await open(b.finish().build().bytes));
    expect(got.length).toBe(1 + 3000 + 1);
    expect(got[3001]).toEqual({ title: '', children: [] });
    let depth = 0;
    for (let i: OutlineItem | undefined = got[0]; i; i = i.children[0]) depth++;
    expect(depth).toBe(65); // top + 64 levels below it; deeper items are cut
  });

  test('thousands of named destinations: each tree node is read about once', async () => {
    const N = 3000;
    const b = new DocBuilder();
    for (let i = 0; i < N; i++) b.page({ content: '' });
    const key = (i: number) => `d${String(i).padStart(5, '0')}`;
    const leaves: number[] = [];
    for (let i = 0; i < N; i += 50) {
      const names = Array.from({ length: 50 }, (_, j) => `(${key(i + j)}) [${b.pages[i + j]} 0 R /Fit]`).join(' ');
      leaves.push(b.obj(`<< /Limits [(${key(i)}) (${key(i + 49)})] /Names [${names}] >>`));
    }
    const tree = b.obj(`<< /Kids [${leaves.map((l) => `${l} 0 R`).join(' ')}] >>`);
    const root = b.alloc();
    const items = Array.from({ length: N + 100 }, () => b.alloc());
    // Items point at pages in a scattered order; the last 100 at names that do not exist.
    items.forEach((n, i) => b.setObj(n, `<< /Title (${i}) /Parent ${root} 0 R${i + 1 < items.length ? ` /Next ${items[i + 1]} 0 R` : ''} /Dest (${key(i < N ? (i * 7) % N : N + i)}) >>`));
    b.setObj(root, `<< /First ${items[0]} 0 R >>`);
    b.catalogExtra = ` /Outlines ${root} 0 R /Names << /Dests ${tree} 0 R >>`;
    const src = new BytesSource(b.finish().build().bytes);
    const doc = await openPdf(src);
    const reads = src.reads;
    const got = await getOutline(doc);
    expect(got.map((i) => i.pageIndex)).toEqual(items.map((_, i) => (i < N ? (i * 7) % N : undefined)));
    // Outline items, pages (for the page map) and one read per tree node, with room to spare.
    expect(src.reads - reads).toBeLessThan(2 * (items.length + N + leaves.length));
  });

  test('damaged copies settle with a result or an Error', async () => {
    const n = await survives(namedDestDoc().bytes, 2, async (doc) => {
      await getOutline(doc);
      await getLinks(doc);
    });
    expect(n).toBeGreaterThan(20);
  });

  test('no outline', async () => {
    const b = new DocBuilder();
    b.page({ content: '' });
    b.catalogExtra = ' /Outlines 999 0 R';
    expect(await getOutline(await open(b.finish().build().bytes))).toEqual([]);
  });

  test('encrypted documents are rejected', async () => {
    if (!hasQpdf) return;
    const enc = await open(qpdfTransform(namedDestDoc().bytes, ['--encrypt', '', 'o', '256', '--']));
    expect(getOutline(enc)).rejects.toBeInstanceOf(PdfEncryptedError);
    expect(getLinks(enc)).rejects.toBeInstanceOf(PdfEncryptedError);
  });
});

describe('getLinks', () => {
  test('link annotations with their targets, like mupdf', async () => {
    const b = new DocBuilder();
    for (let i = 0; i < 3; i++) b.page({ content: drawText(`p${i}`, 20, 20), width: 300, height: 400 });
    const [p0, p1, p2] = b.pages;
    const annots = [
      `<< /Type /Annot /Subtype /Link /Rect [10 20 110 60] /A << /S /URI /URI (https://example.com/) >> >>`,
      `<< /Type /Annot /Subtype /Link /Rect [200 300 120 250] /Dest [${p2} 0 R /Fit] >>`,
      `<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest (there) >>`,
      `<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) >>`,
      `<< /Type /Annot /Subtype /Link /Rect [5 5 6] /Dest [${p1} 0 R /Fit] >>`,
      `<< /Type /Annot /Subtype /Link /Rect [50 50 60 60] /A << /S /GoTo /D [${p1} 0 R /XYZ 0 0 0] >> >>`,
    ].map((a) => `${b.obj(a)} 0 R`);
    b.setObj(p0, b.pageDict({ content: '', width: 300, height: 400, extra: ` /Annots [${annots.join(' ')}]` }, b.stream('', new Uint8Array(0))));
    b.setObj(p2, b.pageDict({ content: '', width: 300, height: 400, extra: ` /Annots ${b.obj(`[<< /Subtype /Link /Rect [1 2 3 4] /Dest /home >>]`)} 0 R` }, b.stream('', new Uint8Array(0))));
    // Legacy destinations dictionary, looked up by name and by string.
    b.catalogExtra = ` /Dests << /there [${p1} 0 R /Fit] /home [${p0} 0 R /Fit] >>`;
    const bytes = b.finish().build().bytes;
    const got = await getLinks(await open(bytes));
    expect(got).toEqual([
      { pageIndex: 0, rect: [10, 20, 110, 60], url: 'https://example.com/' },
      { pageIndex: 0, rect: [120, 250, 200, 300], targetPageIndex: 2 },
      { pageIndex: 0, rect: [0, 0, 10, 10], targetPageIndex: 1 },
      { pageIndex: 0, rect: [50, 50, 60, 60], targetPageIndex: 1 },
      { pageIndex: 2, rect: [1, 2, 3, 4], targetPageIndex: 0 },
    ]);
    const m = mu(bytes);
    const theirs: { pageIndex: number; rect: number[]; url?: string; targetPageIndex?: number }[] = [];
    for (let i = 0; i < m.countPages(); i++) {
      const page = m.loadPage(i);
      for (const l of page.getLinks()) {
        const [x0, y0, x1, y1] = l.getBounds();
        const e: (typeof theirs)[number] = { pageIndex: i, rect: [x0, 400 - y1, x1, 400 - y0] };
        if (l.isExternal()) e.url = l.getURI();
        else e.targetPageIndex = m.resolveLink(l);
        theirs.push(e);
      }
      page.destroy();
    }
    m.destroy();
    // mupdf makes something of the three-number /Rect; we skip that link.
    expect(got).toEqual(theirs.filter((l) => l.rect.join() !== '5,0,6,5'));
  });

  test('links written by mupdf, with object streams', async () => {
    const doc = new mupdf.PDFDocument();
    for (let i = 0; i < 3; i++) doc.insertPage(-1, doc.addPage([0, 0, 300, 400], 0, doc.newDictionary(), ''));
    const page = doc.loadPage(1);
    page.createLink([10, 10, 100, 50], 'https://example.com/x?y=1');
    page.createLink([10, 60, 100, 90], '#page=3');
    page.createLink([10, 100, 100, 190], '#page=1');
    page.destroy();
    let bytes: Uint8Array = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    if (hasQpdf) bytes = qpdfTransform(bytes, ['--object-streams=generate']);
    expect(await getLinks(await open(bytes))).toEqual([
      { pageIndex: 1, rect: [10, 350, 100, 390], url: 'https://example.com/x?y=1' },
      { pageIndex: 1, rect: [10, 310, 100, 340], targetPageIndex: 2 },
      { pageIndex: 1, rect: [10, 210, 100, 300], targetPageIndex: 0 },
    ]);
  });
});
