import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { SharpImageCodec } from '../../src/codecs/sharp.ts';
import { compressImages } from '../../src/core/compress.ts';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { nameOf, PdfDict, PdfRef, type PdfObj } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { pageNumbers, walkPages } from '../../src/core/pages.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { selectPages } from '../../src/features/pages-select.ts';
import { stripMetadata } from '../../src/features/strip.ts';
import { removeUnused } from '../../src/features/unused.ts';
import { jpeg, photo } from '../corpus/images.ts';
import { bytes, DocBuilder, drawImage, drawText, flate, imageDict, PdfBuilder, text } from '../support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfTransform } from '../support/qpdf.ts';
import { renderPdf, sameRaster, ssim } from '../support/render.ts';
import { BytesSink, BytesSource } from '../unit/util.ts';

if (!hasQpdf) console.warn(QPDF_MISSING);

async function run(input: Uint8Array, plugins: Plugin[]) {
  const sink = new BytesSink();
  const report = await rewritePdf(new BytesSource(input), sink, plugins);
  return { out: sink.bytes(), report, sink };
}

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

function expectValid(out: Uint8Array): void {
  if (!hasQpdf) return;
  const r = qpdfCheck(out);
  if (r.code !== 0) console.error(r.output);
  expect(r.code).toBe(0);
}

/** Output page i renders exactly like input page sel[i]. */
function expectPages(input: Uint8Array, out: Uint8Array, sel: number[]): void {
  const a = renderPdf(input, 10);
  const b = renderPdf(out, 10);
  expect(b.pageCount).toBe(sel.length);
  sel.forEach((s, i) => expect(sameRaster(a.pages[s]!, b.pages[i]!)).toBe(true));
}

function mu(b: Uint8Array): mupdf.PDFDocument {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  return mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
}

interface Outline {
  title: string;
  page?: number;
  down?: Outline[];
}

function outline(m: mupdf.PDFDocument): Outline[] {
  const conv = (items: ReturnType<mupdf.Document['loadOutline']>): Outline[] =>
    (items ?? []).map((i) => {
      const o: Outline = { title: i.title ?? '' };
      const page = i.page !== undefined && i.page >= 0 ? i.page : i.uri ? m.resolveLink(i.uri) : -1;
      if (page >= 0) o.page = page;
      if (i.down?.length) o.down = conv(i.down);
      return o;
    });
  return conv(m.loadOutline());
}

const refNums = (o: PdfObj | undefined): number[] => (Array.isArray(o) ? o.filter((x) => x instanceof PdfRef).map((x) => (x as PdfRef).num) : []);

type Book = { bytes: Uint8Array; n: Record<string, number>; p: number[] };

/**
 * Six pages in a three-level tree with inherited attributes (root: MediaBox, Resources; A:
 * Rotate 90; B: CropBox; C: Resources), plus everything that points at pages: outline items
 * (explicit, named and GoTo destinations, open and closed), named destinations (a name tree),
 * links, an /OpenAction, form fields with widgets on several pages, page labels and a structure
 * tree. Page 4 alone uses an image.
 */
function book(opts: { objStm?: boolean } = {}): Book {
  const b = new PdfBuilder();
  const n: Record<string, number> = {};
  for (const k of ['cat', 'root', 'A', 'B', 'C', 'outlines', 'iA', 'iA1', 'iA2', 'iB', 'iB1', 'iB2', 'iC', 'rg']) n[k] = b.alloc();
  const p = [0, 1, 2, 3, 4, 5].map(() => b.alloc());
  n.font = b.obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  n.img = b.stream(imageDict({ width: 8, height: 8, colorSpace: '/DeviceGray' }), Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 255));
  // Annotations and fields.
  n.link0 = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /Border [0 0 0] /Dest (p5) >>`);
  n.link1 = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /Border [0 0 0] /Dest [${p[2]} 0 R /Fit] >>`);
  n.link3 = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /Border [0 0 0] /A << /S /GoTo /D [${p[4]} 0 R /XYZ 0 0 0] >> >>`);
  n.link3b = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 50 120 70] /Border [0 0 0] /Dest [${p[0]} 0 R /Fit] >>`);
  n.tf = b.obj(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [150 20 250 40] /F 2 /P ${p[3]} 0 R >>`);
  n.tf2 = b.obj(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (gone) /Rect [150 20 250 40] /F 2 /P ${p[2]} 0 R >>`);
  // In no /Annots array: only its /P tells where it is.
  n.tfP = b.obj(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (onlyP) /Rect [150 20 250 40] /F 2 /P ${p[4]} 0 R >>`);
  n.r1 = b.obj(`<< /Type /Annot /Subtype /Widget /Parent ${n.rg} 0 R /Rect [150 50 170 70] /F 2 /AS /Off /P ${p[1]} 0 R >>`);
  n.r5 = b.obj(`<< /Type /Annot /Subtype /Widget /Parent ${n.rg} 0 R /Rect [150 50 170 70] /F 2 /AS /Off /P ${p[5]} 0 R >>`);
  b.setObj(n.rg, `<< /FT /Btn /Ff 49152 /T (choice) /Kids [${n.r1} 0 R ${n.r5} 0 R] >>`);
  // Pages.
  const annots: Record<number, number[]> = { 0: [n.link0], 1: [n.link1, n.r1], 2: [n.tf2], 3: [n.link3, n.link3b, n.tf], 5: [n.r5] };
  const parent = [n.A, n.A, n.A, n.B, n.C, n.C];
  n.c4res = b.obj(`<< /Font << /F1 ${n.font} 0 R >> /XObject << /Im0 ${n.img} 0 R >> >>`);
  p.forEach((num, i) => {
    let content = `${(i * 0.15).toFixed(2)} 0.3 ${(1 - i * 0.15).toFixed(2)} rg ${20 + i * 30} 200 40 ${60 + i * 20} re f\n` + drawText(`Page ${i}`, 30, 330, 24);
    if (i === 4) content += drawImage('Im0', 100, 100, 80, 80);
    const c = b.stream('/Filter /FlateDecode', flate(bytes(content)));
    n[`c${i}`] = c;
    const a = annots[i] ? ` /Annots [${annots[i].map((x) => `${x} 0 R`).join(' ')}]` : '';
    const own = i === 2 ? ' /Rotate 180' : i === 4 ? ` /Resources ${n.c4res} 0 R` : '';
    b.setObj(num, `<< /Type /Page /Parent ${parent[i]} 0 R /Contents ${c} 0 R${a}${own} /StructParents ${i} >>`);
  });
  b.setObj(n.root, `<< /Type /Pages /Kids [${n.A} 0 R ${n.B} 0 R] /Count 6 /MediaBox [0 0 300 400] /Resources << /Font << /F1 ${n.font} 0 R >> >> >>`);
  b.setObj(n.A, `<< /Type /Pages /Parent ${n.root} 0 R /Kids [${p[0]} 0 R ${p[1]} 0 R ${p[2]} 0 R] /Count 3 /Rotate 90 >>`);
  b.setObj(n.B, `<< /Type /Pages /Parent ${n.root} 0 R /Kids [${p[3]} 0 R ${n.C} 0 R] /Count 3 /CropBox [10 10 290 390] >>`);
  b.setObj(n.C, `<< /Type /Pages /Parent ${n.B} 0 R /Kids [${p[4]} 0 R ${p[5]} 0 R] /Count 2 /Resources << /Font << /F1 ${n.font} 0 R >> /ProcSet [/PDF /Text] >> >>`);
  // Outline: Part A (open) -> One, Two; Part B (closed) -> Four (named), Five (GoTo, named); Gone.
  const item = (k: string, title: string, par: string, target: string, extra = '') =>
    b.setObj(n[k], `<< /Title (${title}) /Parent ${n[par]} 0 R ${target}${extra} >>`);
  item('iA', 'Part A', 'outlines', `/Dest [${p[0]} 0 R /Fit]`, ` /First ${n.iA1} 0 R /Last ${n.iA2} 0 R /Count 2 /Next ${n.iB} 0 R`);
  item('iA1', 'One', 'iA', `/Dest [${p[1]} 0 R /Fit]`, ` /Next ${n.iA2} 0 R`);
  item('iA2', 'Two', 'iA', `/Dest [${p[2]} 0 R /Fit]`, ` /Prev ${n.iA1} 0 R`);
  item('iB', 'Part B', 'outlines', `/Dest [${p[3]} 0 R /Fit]`, ` /First ${n.iB1} 0 R /Last ${n.iB2} 0 R /Count -2 /Prev ${n.iA} 0 R /Next ${n.iC} 0 R`);
  item('iB1', 'Four', 'iB', '/Dest (p4)', ` /Next ${n.iB2} 0 R`);
  item('iB2', 'Five', 'iB', '/A << /S /GoTo /D (p5) >>', ` /Prev ${n.iB1} 0 R`);
  item('iC', 'Gone', 'outlines', `/Dest [${p[2]} 0 R /Fit]`, ` /Prev ${n.iB} 0 R`);
  b.setObj(n.outlines, `<< /Type /Outlines /First ${n.iA} 0 R /Last ${n.iC} 0 R /Count 5 >>`);
  // Named destinations: a name tree with two leaves, and the old-style /Dests dictionary.
  n.dest5 = b.obj(`<< /D [${p[5]} 0 R /XYZ 0 400 0] >>`);
  n.leaf1 = b.obj(`<< /Limits [(p4) (p4)] /Names [(p4) [${p[4]} 0 R /Fit]] >>`);
  n.leaf2 = b.obj(`<< /Limits [(p5) (p5)] /Names [(p5) ${n.dest5} 0 R] >>`);
  n.struct = b.obj(`<< /Type /StructTreeRoot /K << /S /P /Pg ${p[5]} 0 R /K 0 >> >>`);
  b.setObj(
    n.cat,
    `<< /Type /Catalog /Pages ${n.root} 0 R /Outlines ${n.outlines} 0 R` +
      ` /Names << /Dests << /Kids [${n.leaf1} 0 R ${n.leaf2} 0 R] >> >> /OpenAction [${p[4]} 0 R /Fit]` +
      ` /AcroForm << /Fields [${n.tf} 0 R ${n.rg} 0 R ${n.tf2} 0 R ${n.tfP} 0 R] /CO [${n.tf2} 0 R ${n.tf} 0 R] >>` +
      ` /PageLabels << /Nums [0 << /S /r >> 3 << /S /D /P (B-) >>] >> /StructTreeRoot ${n.struct} 0 R /MarkInfo << /Marked true >> >>`,
  );
  b.trailer('Root', `${n.cat} 0 R`);
  const built = b.build(opts.objStm ? { xref: 'stream', objStm: true, version: '1.5' } : {});
  return { bytes: built.bytes, n, p };
}

async function get(b: Uint8Array, num: number): Promise<PdfObj | undefined> {
  return (await open(b)).getObject(num);
}

const catalogOf = async (b: Uint8Array): Promise<PdfDict> => {
  const doc = await open(b);
  return (await doc.resolve(doc.trailer.get('Root'))) as PdfDict;
};

for (const objStm of [false, true]) {
  const label = objStm ? ' (object streams)' : '';
  const bk = book({ objStm });

  describe(`selectPages${label}`, () => {
    test('the fixture', async () => {
      expectValid(bk.bytes);
      const m = mu(bk.bytes);
      expect(m.countPages()).toBe(6);
      expect([0, 1, 2, 3, 4, 5].map((i) => m.loadPage(i).getLabel())).toEqual(['i', 'ii', 'iii', 'B-1', 'B-2', 'B-3']);
    });

    test('keeps, reorders and removes pages; drops what only removed pages used', async () => {
      const sel = [5, 0, 3];
      const { out } = await run(bk.bytes, [selectPages(sel)]);
      expectValid(out);
      expectPages(bk.bytes, out, sel);
      const doc = await open(out);
      expect(await pageNumbers(doc)).toEqual(sel.map((i) => bk.p[i]));
      const pages: { rotate: number; cropBox: number[]; mediaBox: number[] }[] = [];
      for await (const pg of walkPages(doc)) pages.push({ rotate: pg.rotate, cropBox: pg.cropBox, mediaBox: pg.mediaBox });
      expect(pages).toEqual([
        { rotate: 0, cropBox: [10, 10, 290, 390], mediaBox: [0, 0, 300, 400] },
        { rotate: 90, cropBox: [0, 0, 300, 400], mediaBox: [0, 0, 300, 400] },
        { rotate: 0, cropBox: [10, 10, 290, 390], mediaBox: [0, 0, 300, 400] },
      ]);
      // A flat tree; pages carry what they used to inherit.
      const cat = await catalogOf(out);
      const node = (await doc.resolve(cat.get('Pages'))) as PdfDict;
      expect(refNums(node.get('Kids'))).toEqual(sel.map((i) => bk.p[i]));
      expect(node.get('Count')).toBe(3);
      for (const i of sel) {
        const pd = (await get(out, bk.p[i])) as PdfDict;
        expect((pd.get('Parent') as PdfRef).num).toBe((cat.get('Pages') as PdfRef).num);
        for (const k of ['Resources', 'MediaBox']) expect(pd.get(k)).toBeDefined();
      }
      // Removed pages, their content, the old tree nodes and the image only page 4 used are gone.
      for (const k of ['A', 'B', 'C', 'root', 'img', 'c4res', 'c1', 'c2', 'c4', 'tf2', 'tfP', 'r1', 'link1']) {
        expect(await get(out, bk.n[k])).toBeUndefined();
      }
      for (const i of [1, 2, 4]) expect(await get(out, bk.p[i])).toBeUndefined();
      if (!objStm) expect(out.length).toBeLessThan(bk.bytes.length);
    });

    test('prunes outline, named destinations, links, fields; recomputes labels', async () => {
      const { out } = await run(bk.bytes, [selectPages([5, 0, 3])]);
      const m = mu(out);
      expect(outline(m)).toEqual([
        { title: 'Part A', page: 1 },
        { title: 'Part B', page: 2, down: [{ title: 'Five', page: 0 }] },
      ]);
      const doc = await open(out);
      const cat = await catalogOf(out);
      const root = (await doc.resolve(cat.get('Outlines'))) as PdfDict;
      expect(root.get('Count')).toBe(2);
      const iA = (await get(out, bk.n.iA)) as PdfDict;
      for (const k of ['First', 'Last', 'Count']) expect(iA.get(k)).toBeUndefined();
      expect((iA.get('Next') as PdfRef).num).toBe(bk.n.iB);
      const iB = (await get(out, bk.n.iB)) as PdfDict;
      expect(iB.get('Count')).toBe(-1);
      expect(iB.get('Next')).toBeUndefined();
      expect((iB.get('First') as PdfRef).num).toBe(bk.n.iB2);
      expect((iB.get('Last') as PdfRef).num).toBe(bk.n.iB2);
      expect(((await get(out, bk.n.iB2)) as PdfDict).get('Prev')).toBeUndefined();
      for (const k of ['iA1', 'iA2', 'iB1', 'iC']) expect(await get(out, bk.n[k])).toBeUndefined();
      // Named destinations.
      expect(((await get(out, bk.n.leaf1)) as PdfDict).get('Names')).toEqual([]);
      expect(m.resolveLink('#p5')).toBe(0);
      expect(cat.get('OpenAction')).toBeUndefined();
      // Links: page 3 loses the one to page 4 and keeps the one to page 0; page 5's link stays.
      expect(refNums(((await get(out, bk.p[3])) as PdfDict).get('Annots'))).toEqual([bk.n.link3b, bk.n.tf]);
      expect(m.loadPage(2).getLinks().map((l) => m.resolveLink(l))).toEqual([1]);
      expect(m.loadPage(1).getLinks().map((l) => m.resolveLink(l))).toEqual([0]);
      // Form fields.
      const form = (await doc.resolve(cat.get('AcroForm'))) as PdfDict;
      expect(refNums(form.get('Fields'))).toEqual([bk.n.tf, bk.n.rg]);
      expect(refNums(form.get('CO'))).toEqual([bk.n.tf]);
      expect(refNums(((await get(out, bk.n.rg)) as PdfDict).get('Kids'))).toEqual([bk.n.r5]);
      // Structure tree dropped; labels follow their pages.
      expect(cat.get('StructTreeRoot')).toBeUndefined();
      expect(cat.get('MarkInfo')).toBeUndefined();
      expect(await get(out, bk.n.struct)).toBeUndefined();
      expect([0, 1, 2].map((i) => m.loadPage(i).getLabel())).toEqual(['B-3', 'i', 'B-1']);
    });

    test('reordering only keeps everything', async () => {
      const sel = [5, 4, 3, 2, 1, 0];
      const { out } = await run(bk.bytes, [selectPages(sel)]);
      expectValid(out);
      expectPages(bk.bytes, out, sel);
      const m = mu(out);
      expect(sel.map((_, i) => m.loadPage(i).getLabel())).toEqual(['B-3', 'B-2', 'B-1', 'iii', 'ii', 'i']);
      expect(outline(m)).toEqual([
        { title: 'Part A', page: 5, down: [{ title: 'One', page: 4 }, { title: 'Two', page: 3 }] },
        { title: 'Part B', page: 2, down: [{ title: 'Four', page: 1 }, { title: 'Five', page: 0 }] },
        { title: 'Gone', page: 3 },
      ]);
      const cat = await catalogOf(out);
      for (const k of ['StructTreeRoot', 'OpenAction', 'Names']) expect(cat.get(k)).toBeDefined();
      expect(await get(out, bk.n.img)).toBeDefined();
      const form = (await (await open(out)).resolve(cat.get('AcroForm'))) as PdfDict;
      expect(refNums(form.get('Fields'))).toEqual([bk.n.tf, bk.n.rg, bk.n.tf2, bk.n.tfP]);
    });

    test('selecting every page in order changes nothing that shows', async () => {
      const sel = [0, 1, 2, 3, 4, 5];
      const { out } = await run(bk.bytes, [selectPages(sel)]);
      expectValid(out);
      expectPages(bk.bytes, out, sel);
      const cat = await catalogOf(out);
      expect(nameOf((cat.get('PageLabels') as PdfDict | undefined)?.get('Type'))).toBeUndefined();
      expect(text(out)).toContain('/PageLabels << /Nums [0 << /S /r >> 3 << /S /D /P (B-) >>] >>');
    });
  });
}

describe('selectPages validation', () => {
  test('bad selections are rejected', async () => {
    for (const bad of [[], [0, 0], [-1], [1.5], [NaN]]) expect(() => selectPages(bad)).toThrow(RangeError);
    class AbortSink extends BytesSink {
      aborted = false;
      async abort(): Promise<void> {
        this.aborted = true;
      }
    }
    const sink = new AbortSink();
    await expect(rewritePdf(new BytesSource(book().bytes), sink, [selectPages([0, 6])])).rejects.toBeInstanceOf(RangeError);
    expect(sink.aborted).toBe(true);
  });

  test('one selection per rewrite', async () => {
    await expect(run(book().bytes, [selectPages([0]), selectPages([1])])).rejects.toThrow('only once');
  });

  test('encrypted documents are rejected', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(book().bytes, ['--encrypt', 'u', 'o', '256', '--']);
    await expect(run(enc, [selectPages([0])])).rejects.toBeInstanceOf(PdfEncryptedError);
    await expect(run(enc, [{ decrypts: true }, selectPages([0])])).rejects.toBeInstanceOf(PdfEncryptedError);
  });

  test('old-style named destinations (catalog /Dests)', async () => {
    const b = new DocBuilder();
    const p0 = b.alloc();
    const p1 = b.alloc();
    const outlines = b.alloc();
    const item = b.obj(`<< /Title (To one) /Parent ${outlines} 0 R /Dest /d1 >>`);
    b.setObj(outlines, `<< /Type /Outlines /First ${item} 0 R /Last ${item} 0 R /Count 1 >>`);
    const link = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /Border [0 0 0] /Dest /d1 >>`);
    const keep = b.obj(`<< /Type /Annot /Subtype /Link /Rect [20 50 120 70] /Border [0 0 0] /Dest /d0 >>`);
    [p0, p1].forEach((p, i) => {
      const c = b.stream('', bytes(drawText(`Page ${i}`, 40, 780)));
      b.setObj(p, b.pageDict({ content: '', extra: i ? '' : ` /Annots [${link} 0 R ${keep} 0 R]` }, c));
      b.pages.push(p);
    });
    b.catalogExtra = ` /Dests << /d0 [${p0} 0 R /Fit] /d1 [${p1} 0 R /Fit] >> /Outlines ${outlines} 0 R /PageMode /UseOutlines`;
    const input = b.finish('dests').build().bytes;
    expect(mu(input).resolveLink('#d1')).toBe(1);
    const { out } = await run(input, [selectPages([0])]);
    expectValid(out);
    const cat = await catalogOf(out);
    expect([...(cat.get('Dests') as PdfDict).map.keys()]).toEqual(['d0']);
    expect(cat.get('Outlines')).toBeUndefined();
    expect(refNums(((await get(out, p0)) as PdfDict).get('Annots'))).toEqual([keep]);
    const m = mu(out);
    expect(m.loadPage(0).getLinks().map((l) => m.resolveLink(l))).toEqual([0]);
    expect(await get(out, item)).toBeUndefined();
  });

  test('pages stored directly in /Kids become objects', async () => {
    const b = new PdfBuilder();
    const cat = b.alloc();
    const root = b.alloc();
    const c = [0, 1].map((i) => b.stream('', bytes(`0 0 ${i} rg 10 10 ${50 + 50 * i} 50 re f`)));
    b.setObj(root, `<< /Type /Pages /Kids [<< /Type /Page /Parent ${root} 0 R /Contents ${c[0]} 0 R >> << /Type /Page /Parent ${root} 0 R /Contents ${c[1]} 0 R >>] /Count 2 /MediaBox [0 0 200 200] >>`);
    b.setObj(cat, `<< /Type /Catalog /Pages ${root} 0 R >>`);
    b.trailer('Root', `${cat} 0 R`);
    const input = b.build().bytes;
    const { out } = await run(input, [selectPages([1])]);
    expectValid(out);
    expectPages(input, out, [1]);
    expect(await get(out, c[0])).toBeUndefined();
  });
});

describe('documents written by mupdf', () => {
  /** Five pages with an outline entry, a link to the next page, labels, saved with object streams. */
  function made(): Uint8Array {
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    const res = doc.addObject({ Font: { F1: font } });
    for (let i = 0; i < 5; i++) {
      const content = `${i / 5} 0.5 0.5 rg 20 20 ${40 + i * 30} 60 re f BT /F1 24 Tf 20 150 Td (Page ${i}) Tj ET`;
      doc.insertPage(-1, doc.addPage([0, 0, 300, 300], i === 3 ? 90 : 0, res, content));
    }
    for (let i = 0; i < 4; i++) {
      doc.loadPage(i).createLink([20, 20, 100, 80], doc.formatLinkURI({ type: 'Fit', chapter: 0, page: i + 1, x: 0, y: 0, width: 0, height: 0, zoom: 0 }));
    }
    const it = doc.outlineIterator();
    for (let i = 0; i < 5; i++) {
      it.insert({ title: `Chapter ${i}`, uri: `#page=${i + 1}`, open: true });
    }
    doc.setPageLabels(0, 'r');
    doc.setPageLabels(2, 'D', 'P-', 1);
    return doc.saveToBuffer('compress,objstms').asUint8Array().slice();
  }

  test('selecting pages keeps what points at kept pages', async () => {
    const input = made();
    expectValid(input);
    const before = mu(input);
    expect([0, 1, 2, 3, 4].map((i) => before.loadPage(i).getLabel())).toEqual(['i', 'ii', 'P-1', 'P-2', 'P-3']);
    const sel = [4, 3, 1];
    const { out } = await run(input, [selectPages(sel)]);
    expectValid(out);
    expectPages(input, out, sel);
    const m = mu(out);
    expect(outline(m)).toEqual([
      { title: 'Chapter 1', page: 2 },
      { title: 'Chapter 3', page: 1 },
      { title: 'Chapter 4', page: 0 },
    ]);
    expect([0, 1, 2].map((i) => m.loadPage(i).getLabel())).toEqual(['P-3', 'P-2', 'ii']);
    // Page 3 links to page 4 (kept), page 1 to page 2 (gone).
    expect(m.loadPage(1).getLinks().map((l) => m.resolveLink(l))).toEqual([0]);
    expect(m.loadPage(2).getLinks()).toEqual([]);
  });
});

describe('one pass: compressImages + stripMetadata + removeUnused + selectPages', () => {
  test('the combination keeps the selected pages and shrinks the file', async () => {
    const b = new DocBuilder();
    const photos: number[] = [];
    for (let i = 0; i < 3; i++) {
      const data = await jpeg(photo(900, 600, 40 + i), { quality: 95 });
      photos.push(b.stream(imageDict({ width: 900, height: 600, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), data));
    }
    const xmp = b.stream('/Type /Metadata /Subtype /XML', bytes('<x:xmpmeta xmlns:x="adobe:ns:meta/">COMBO-SECRET</x:xmpmeta>'));
    const info = b.obj('<< /Title (COMBO-SECRET) >>');
    photos.forEach((ph, i) => b.page({ content: drawText(`Photo ${i}`, 40, 800, 20) + drawImage('P', 40, 300, 450, 300), xobjects: { P: ph } }));
    b.catalogExtra = ` /Metadata ${xmp} 0 R`;
    b.finish('combo');
    b.trailer('Info', `${info} 0 R`);
    const input = b.build({ xref: 'stream', objStm: true, version: '1.5' }).bytes;
    const images = compressImages({ codec: new SharpImageCodec(), maxWidth: 600, maxHeight: 600 });
    const sel = [2, 0];
    const { out, report } = await run(input, [removeUnused(), images, stripMetadata(), selectPages(sel)]);
    expectValid(out);
    // The dropped page's photo is not even looked at.
    expect(await get(out, photos[1])).toBeUndefined();
    expect(images.report.imagesSeen).toBe(2);
    expect(images.report.imagesRecompressed).toBe(2);
    expect(text(out)).not.toContain('COMBO-SECRET');
    expect((await open(out)).trailer.get('Info')).toBeUndefined();
    expect(out.length).toBeLessThan(input.length / 2);
    expect(report.outputBytes).toBe(out.length);
    const a = renderPdf(input, 3);
    const r = renderPdf(out, 3);
    expect(r.pageCount).toBe(2);
    sel.forEach((s, i) => expect(ssim(a.pages[s]!, r.pages[i]!)).toBeGreaterThan(0.9));
  });
});
