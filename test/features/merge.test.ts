import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { PdfDict, PdfName } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { mergePdfs, type MergeOptions, type MergeProgress } from '../../src/features/merge.ts';
import { inspect } from '../support/inspect.ts';
import { DocBuilder, PdfBuilder, bytes, damage, drawText, flate, imageDict, text, vectorArt, type BuildOptions } from '../support/pdfgen.ts';
import { hasQpdf, qpdfCheck, qpdfTransform, severity } from '../support/qpdf.ts';
import { renderPdf, sameRaster } from '../support/render.ts';
import { BytesSink, BytesSource } from '../unit/util.ts';

const root = new URL('../../', import.meta.url).pathname;

class AbortableSink extends BytesSink {
  aborted = false;
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

async function merge(inputs: Uint8Array[], opts?: MergeOptions) {
  const sink = new AbortableSink();
  const report = await mergePdfs(inputs.map((b) => new BytesSource(b)), sink, opts);
  expect(sink.closed).toBe(true);
  return { report, out: sink.bytes() };
}

function expectValid(out: Uint8Array): void {
  if (!hasQpdf) return;
  const r = qpdfCheck(out);
  if (r.code !== 0) console.log(r.output);
  expect(r.code).toBe(0);
}

/** Text of every page, via mupdf. */
function pageTexts(data: Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    const out: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      out.push(page.toStructuredText('').asText().replace(/\s+/g, ' ').trim());
      page.destroy();
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** Every output page renders exactly like the input page it came from. */
function expectSamePages(inputs: Uint8Array[], out: Uint8Array, sel?: (number[] | undefined)[], dpi = 50): void {
  const got = renderPdf(out, 10_000, dpi);
  let k = 0;
  inputs.forEach((input, i) => {
    const want = renderPdf(input, 10_000, dpi);
    const idx = sel?.[i] ?? want.pages.map((_, j) => j);
    for (const j of idx) {
      const a = got.pages[k];
      const b = want.pages[j];
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      if (!sameRaster(a!, b!)) throw new Error(`output page ${k} differs from input ${i} page ${j}`);
      k++;
    }
  });
  expect(got.pageCount).toBe(k);
}

/** A DocBuilder document whose pages say `${label} p${n}`. */
function labelled(label: string, n: number, opts: BuildOptions & { sizes?: [number, number][]; rotate?: number[] } = {}): Uint8Array {
  const b = new DocBuilder();
  for (let i = 0; i < n; i++) {
    const [width, height] = opts.sizes?.[i % opts.sizes.length] ?? [595, 842];
    const rot = opts.rotate?.[i % opts.rotate.length];
    b.page({
      width,
      height,
      content: drawText(`${label} p${i + 1}`, 30, height - 60, 20) + vectorArt(30, 30, width - 80, height / 2, i + label.length),
      extra: rot ? ` /Rotate ${rot}` : '',
    });
  }
  b.finish(label);
  return b.build(opts).bytes;
}

const raw = (len: number, seed: number): Uint8Array => Uint8Array.from({ length: len }, (_, i) => (i * seed + (i >> 7) * 13) & 255);

/**
 * Nested page tree: MediaBox, CropBox, Rotate and Resources (both an indirect dictionary and a
 * direct one) inherited from intermediate /Pages nodes; one image shared by two pages.
 */
function nestedDoc(): Uint8Array {
  const b = new PdfBuilder();
  const cat = b.alloc();
  const top = b.alloc();
  const n1 = b.alloc();
  const n2 = b.alloc();
  const font = b.obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const img = b.stream(imageDict({ width: 16, height: 16, colorSpace: '/DeviceRGB' }), raw(16 * 16 * 3, 7));
  const res = b.obj(`<< /Font << /F1 ${font} 0 R >> /XObject << /Im ${img} 0 R >> >>`);
  const content = (s: string): number => b.stream('/Filter /FlateDecode', flate(bytes(s)));
  const page = (parent: number, s: string, extra = ''): number =>
    b.obj(`<< /Type /Page /Parent ${parent} 0 R /Contents ${content(s)} 0 R${extra} >>`);
  const draw = (t: string) => drawText(t, 20, 150, 14) + vectorArt(20, 20, 150, 100, t.length) + 'q 60 0 0 60 180 40 cm /Im Do Q\n';
  const p1 = page(n1, draw('nested one'));
  const p2 = page(n1, draw('nested two'), ' /Rotate 180');
  const p3 = page(n2, draw('nested three'));
  const p4 = page(n2, draw('nested four'), ` /MediaBox [0 0 250 250] /Resources ${res} 0 R`);
  b.setObj(top, `<< /Type /Pages /Kids [${n1} 0 R ${n2} 0 R] /Count 4 /MediaBox [0 0 300 400] /Resources ${res} 0 R /Rotate 90 >>`);
  b.setObj(n1, `<< /Type /Pages /Parent ${top} 0 R /Kids [${p1} 0 R ${p2} 0 R] /Count 2 /CropBox [10 10 290 380] >>`);
  b.setObj(
    n2,
    `<< /Type /Pages /Parent ${top} 0 R /Kids [${p3} 0 R ${p4} 0 R] /Count 2 /MediaBox [0 0 400 300] /Rotate 0 ` +
      `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im ${img} 0 R >> >> >>`,
  );
  b.setObj(cat, `<< /Type /Catalog /Pages ${top} 0 R >>`);
  b.trailer('Root', `${cat} 0 R`);
  return b.build().bytes;
}

/** mupdf-made document: simple and CID fonts, an image, a square annotation, a link, an outline. */
function mupdfDoc(label: string, pages = 3, save = 'compress,objstms'): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const times = new mupdf.Font('Times-Roman');
  const cid = doc.addFont(times);
  const helv = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 48], false);
  const px = pix.getPixels();
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + label.length * 11) & 255;
  const img = doc.addImage(new mupdf.Image(pix));
  const hex = (s: string) => [...s].map((c) => times.encodeCharacter(c).toString(16).padStart(4, '0')).join('');
  for (let p = 0; p < pages; p++) {
    const res = doc.addObject({ Font: { F1: helv, F2: cid }, XObject: { Im0: img } });
    const content =
      `BT /F1 20 Tf 50 700 Td (${label} page ${p + 1}) Tj ET BT /F2 18 Tf 50 650 Td <${hex(`Times ${label}`)}> Tj ET ` +
      `q 200 0 0 150 50 400 cm /Im0 Do Q`;
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], ((p % 4) * 90) as 0 | 90 | 180 | 270, res, content));
  }
  const pg = doc.loadPage(0);
  const a = pg.createAnnotation('Square');
  a.setRect([300, 300, 400, 400]);
  a.setColor([1, 0, 0]);
  a.update();
  const dest = (page: number) => doc.formatLinkURI({ type: 'Fit', chapter: 0, page, x: 0, y: 0, width: 0, height: 0, zoom: 1 });
  pg.createLink([50, 690, 200, 720], dest(pages - 1));
  const it = doc.outlineIterator();
  it.insert({ title: `${label} start`, uri: dest(0), open: true });
  it.insert({ title: `${label} end`, uri: dest(pages - 1), open: true });
  const out = doc.saveToBuffer(save).asUint8Array().slice();
  doc.destroy();
  return out;
}

/** Four pages; a link on page 1 to page 3 by a name-tree name, one by an action, one by an old-style name. */
function namedDestDoc(): Uint8Array {
  const b = new DocBuilder();
  const links = [b.alloc(), b.alloc(), b.alloc()];
  const pages = [0, 1, 2, 3].map((i) =>
    b.page({ content: drawText(`Named p${i + 1}`, 30, 780, 20), extra: i === 0 ? ` /Annots [${links.map((l) => `${l} 0 R`).join(' ')}]` : '' }),
  );
  const dict = b.obj(`<< /D [${pages[1]} 0 R /XYZ 0 800 0] >>`);
  const leaf1 = b.obj(`<< /Limits [(a.first) (b.second)] /Names [(a.first) [${pages[0]} 0 R /Fit] (b.second) ${dict} 0 R] >>`);
  const leaf2 = b.obj(`<< /Limits [(c.third) (d.fourth)] /Names [(c.third) [${pages[2]} 0 R /Fit] (d.fourth) [${pages[3]} 0 R /FitH 500]] >>`);
  const tree = b.obj(`<< /Kids [${leaf1} 0 R ${leaf2} 0 R] >>`);
  const link = (i: number, what: string) =>
    b.setObj(links[i], `<< /Type /Annot /Subtype /Link /Rect [${i * 100} 0 ${i * 100 + 90} 90] /Border [0 0 0] ${what} >>`);
  link(0, '/Dest (d.fourth)');
  link(1, '/A << /S /GoTo /D (c.third) >>');
  link(2, '/Dest /Old');
  const ol = b.alloc();
  const i1 = b.obj(`<< /Title (to second) /Parent ${ol} 0 R /Next ${ol + 2} 0 R /Dest (b.second) >>`);
  const i2 = b.obj(`<< /Title (to fourth) /Parent ${ol} 0 R /Prev ${i1} 0 R /A << /S /GoTo /D (d.fourth) >> >>`);
  expect(i2).toBe(ol + 2);
  b.setObj(ol, `<< /Type /Outlines /First ${i1} 0 R /Last ${i2} 0 R /Count 2 >>`);
  b.catalogExtra = ` /Names << /Dests ${tree} 0 R >> /Dests << /Old [${pages[1]} 0 R /Fit] >> /Outlines ${ol} 0 R /PageMode /UseOutlines`;
  b.finish('named');
  return b.build().bytes;
}

/** A text field "Name" with a widget on each page, plus a field named `label` on page 1. */
function formDoc(label: string): Uint8Array {
  const b = new DocBuilder();
  const field = b.alloc();
  const widgets = [b.alloc(), b.alloc()];
  const other = b.alloc();
  const ap = (s: string) =>
    b.stream(
      `/Type /XObject /Subtype /Form /BBox [0 0 150 20] /Resources << /Font << /Helv ${b.font} 0 R >> >>`,
      bytes(`0.85 0.9 1 rg 0 0 150 20 re f BT 0 g /Helv 12 Tf 2 5 Td (${s}) Tj ET`),
    );
  const pages = [0, 1].map((i) =>
    b.page({
      content: drawText(`${label} form p${i + 1}`, 30, 780, 16),
      extra: ` /Annots [${widgets[i]} 0 R${i === 0 ? ` ${other} 0 R` : ''}]`,
    }),
  );
  widgets.forEach((w, i) =>
    b.setObj(w, `<< /Type /Annot /Subtype /Widget /Rect [50 600 200 620] /F 4 /P ${pages[i]} 0 R /Parent ${field} 0 R /AP << /N ${ap(`${label} ${i}`)} 0 R >> >>`),
  );
  b.setObj(field, `<< /FT /Tx /T (Name) /V (${label}) /DA (/Helv 12 Tf 0 g) /Kids [${widgets[0]} 0 R ${widgets[1]} 0 R] >>`);
  b.setObj(other, `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${label}) /V (x) /Rect [50 500 200 520] /F 4 /P ${pages[0]} 0 R /AP << /N ${ap('other')} 0 R >> >>`);
  b.catalogExtra = ` /AcroForm << /Fields [${field} 0 R ${other} 0 R] /DR << /Font << /Helv ${b.font} 0 R >> >> /DA (/Helv 0 Tf 0 g) >>`;
  b.finish(label);
  return b.build().bytes;
}

/** Content in two optional content groups, one of them off by default, and an unused group. */
function layerDoc(): Uint8Array {
  const b = new DocBuilder();
  const on = b.obj('<< /Type /OCG /Name (Shown) >>');
  const off = b.obj('<< /Type /OCG /Name (Hidden) >>');
  const unused = b.obj('<< /Type /OCG /Name (Unused) >>');
  b.page({
    content: drawText('layers', 30, 780) + '/OC /L1 BDC 0 0 1 rg 50 50 200 200 re f EMC /OC /L2 BDC 1 0 0 rg 100 100 200 200 re f EMC\n',
    resources: ` /Properties << /L1 ${on} 0 R /L2 ${off} 0 R >>`,
  });
  b.catalogExtra =
    ` /OCProperties << /OCGs [${on} 0 R ${off} 0 R ${unused} 0 R] ` +
    `/D << /Order [${on} 0 R [(Group) ${off} 0 R] [(Empty) ${unused} 0 R]] /OFF [${off} 0 R ${unused} 0 R] >> >>`;
  b.finish('layers');
  return b.build().bytes;
}

/** Page i draws its own 40 kB image; page 2 links to page 1. An unreferenced stream is junk. */
function imagePagesDoc(): Uint8Array {
  const b = new DocBuilder();
  const link = b.alloc();
  const pages: number[] = [];
  for (let i = 0; i < 4; i++) {
    const img = b.stream(imageDict({ width: 200, height: 200, colorSpace: '/DeviceGray' }) + ` /Name /Page${i}Image`, raw(40_000, 3 + i * 2));
    pages.push(
      b.page({
        content: drawText(`image p${i + 1}`, 30, 800) + 'q 300 0 0 300 50 300 cm /Im Do Q\n',
        xobjects: { Im: img },
        extra: i === 1 ? ` /Annots [${link} 0 R]` : '',
      }),
    );
  }
  b.setObj(link, `<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /P ${pages[1]} 0 R /Dest [${pages[0]} 0 R /Fit] >>`);
  b.stream('/Junk true', raw(50_000, 5));
  b.finish('images');
  return b.build({ xref: 'stream', objStm: true }).bytes;
}

/** Object streams in the first section; an incremental update replaces page 1's content and adds junk. */
function updatedDoc(): Uint8Array {
  const b = new DocBuilder();
  const c1 = b.stream('/Filter /FlateDecode', flate(bytes(drawText('old content', 30, 780))));
  b.pages.push(b.obj(b.pageDict({ content: '' }, c1)));
  b.page({ content: drawText('second page', 30, 780) + vectorArt(40, 40, 300, 300, 3) });
  b.finish('updated');
  b.update();
  b.setStream(c1, '/Filter /FlateDecode', flate(bytes(drawText('new content', 30, 780) + vectorArt(40, 40, 300, 300, 9))));
  b.stream('', raw(30_000, 9));
  return b.build({ xref: ['stream', 'table'], objStm: [true, false] }).bytes;
}

/** A signature field on page 1. */
function signedDoc(): Uint8Array {
  const b = new DocBuilder();
  const sig = b.alloc();
  const p = b.page({ content: drawText('signed', 30, 780), extra: ` /Annots [${sig} 0 R]` });
  b.setObj(
    sig,
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Sig1) /Rect [0 0 0 0] /F 132 /P ${p} 0 R ` +
      `/V << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <0000> >> >>`,
  );
  b.catalogExtra = ` /AcroForm << /Fields [${sig} 0 R] /SigFlags 3 >>`;
  b.finish('signed');
  return b.build().bytes;
}

/** Links of every page as resolved page indices (mupdf). */
function linkTargets(data: Uint8Array): number[][] {
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  const out: number[][] = [];
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).getLinks().map((l) => doc.resolveLink(l)));
  return out;
}

type Outline = { title?: string; page?: number; down?: Outline[] };
const outlineOf = (data: Uint8Array): Outline[] => {
  const strip = (items: Outline[] | null | undefined): Outline[] =>
    (items ?? []).map((it) => ({ title: it.title, page: it.page, ...(it.down ? { down: strip(it.down) } : {}) }));
  return strip(mupdf.Document.openDocument(data, 'application/pdf').loadOutline());
};

/** Widget field names per page (mupdf). */
function widgetNames(data: Uint8Array): string[][] {
  const doc = mupdf.Document.openDocument(data, 'application/pdf') as mupdf.PDFDocument;
  const out: string[][] = [];
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).getWidgets().map((w) => w.getName()));
  return out;
}

describe('mergePdfs', () => {
  test('concatenates documents in order, with a valid xref and identical pages', async () => {
    const a = labelled('Alpha', 3);
    const b = labelled('Beta', 2, { xref: 'stream', objStm: true });
    const { report, out } = await merge([a, b]);
    expect(report.pageCount).toBe(5);
    expect(report.inputBytes).toBe(a.length + b.length);
    expect(report.outputBytes).toBe(out.length);
    expect(report.warnings).toEqual([]);
    expect(text(out, 0, 9)).toBe('%PDF-1.7\n');
    expectValid(out);
    expect(pageTexts(out)).toEqual(['Alpha p1', 'Alpha p2', 'Alpha p3', 'Beta p1', 'Beta p2']);
    expectSamePages([a, b], out);
    // A classic xref table, no object streams.
    const s = await inspect(out);
    expect(s.compressed.size).toBe(0);
    expect(text(out)).toMatch(/\nxref\n0 \d+\n/);
  });

  test('different page sizes and rotations, and attributes inherited through a nested page tree', async () => {
    const a = labelled('Sizes', 4, { sizes: [[300, 200], [612, 792], [200, 500]], rotate: [0, 90, 180, 270] });
    const n = nestedDoc();
    const { report, out } = await merge([a, n]);
    expect(report.pageCount).toBe(8);
    expectValid(out);
    expectSamePages([a, n], out);
    const s = await inspect(out);
    const pages = [...s.uncompressed.values()].filter((o) => (o.dict?.get('Type') as PdfName | undefined)?.name === 'Page');
    expect(pages.length).toBe(8);
    for (const p of pages) {
      expect(p.dict!.get('MediaBox')).toBeDefined();
      expect(text(p.bytes)).toContain('/Parent 2 0 R');
    }
    // The page tree is flat: the only /Pages node is the new root.
    expect([...s.uncompressed.values()].filter((o) => (o.dict?.get('Type') as PdfName | undefined)?.name === 'Pages').length).toBe(1);
  });

  test('shared resources stay shared', async () => {
    const n = nestedDoc();
    const { out } = await merge([n]);
    const s = await inspect(out);
    const images = [...s.uncompressed.values()].filter((o) => (o.dict?.get('Subtype') as PdfName | undefined)?.name === 'Image');
    expect(images.length).toBe(1);
    expectSamePages([n], out);
  });

  test('object streams and incremental updates: the latest objects win, junk is dropped', async () => {
    const u = updatedDoc();
    const { report, out } = await merge([labelled('Head', 1), u]);
    expect(report.pageCount).toBe(3);
    expectValid(out);
    expect(pageTexts(out)).toEqual(['Head p1', 'new content', 'second page']);
    expectSamePages([labelled('Head', 1), u], out);
    expect(out.length).toBeLessThan(u.length - 25_000);
  });

  test('damaged inputs are repaired, with warnings, and still produce a valid file', async () => {
    const good = labelled('Good', 2);
    const broken = [
      damage.startxref(labelled('Startxref', 2), 999_999),
      labelled('Offsets', 2, { badOffsets: { 4: 7, 5: -3 } }),
      damage.truncate(labelled('Truncated', 2), labelled('Truncated', 2).length - 120),
      damage.prefix(labelled('Prefixed', 1), 'junk before the header\n'),
    ];
    const { report, out } = await merge([good, ...broken]);
    expect(report.pageCount).toBe(9);
    expectValid(out);
    expect(report.warnings.some((w) => w.startsWith('Input 2:'))).toBe(true);
    expect(report.warnings.some((w) => w.startsWith('Input 4:'))).toBe(true);
    expectSamePages([good, ...broken], out);
  });

  test('a stream with a wrong /Length gets the right one', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('wrong length', 30, 780) + vectorArt(40, 40, 300, 300) }, { length: 7 });
    b.finish();
    const a = b.build().bytes;
    const { out } = await merge([a]);
    expectValid(out);
    expectSamePages([a], out);
  });

  test('nothing from unselected pages is written', async () => {
    const d = imagePagesDoc();
    const { report, out } = await merge([d], { pages: [[1, 3]] });
    expect(report.pageCount).toBe(2);
    expectValid(out);
    expect(pageTexts(out)).toEqual(['image p2', 'image p4']);
    expectSamePages([d], out, [[1, 3]]);
    expect(out.length).toBeGreaterThan(80_000);
    expect(out.length).toBeLessThan(85_000);
    const s = await inspect(out);
    const names = [...s.uncompressed.values()].map((o) => (o.dict?.get('Name') as PdfName | undefined)?.name).filter(Boolean);
    expect(names.sort()).toEqual(['Page1Image', 'Page3Image']);
    expect([...s.uncompressed.values()].some((o) => o.dict?.get('Junk') !== undefined)).toBe(false);
    // The link to the dropped first page stays, without its destination.
    const link = [...s.uncompressed.values()].find((o) => (o.dict?.get('Subtype') as PdfName | undefined)?.name === 'Link');
    expect(link!.dict!.get('Dest')).toBeUndefined();
  });

  test('page selection: reordering, repeats and empty selections', async () => {
    const a = labelled('Sel', 4);
    const b = labelled('Other', 2);
    const sel = [[3, 0, 3, 1], []];
    const { report, out } = await merge([a, b, a], { pages: sel });
    expect(report.pageCount).toBe(8);
    expectValid(out);
    expect(pageTexts(out)).toEqual(['Sel p4', 'Sel p1', 'Sel p4', 'Sel p2', 'Sel p1', 'Sel p2', 'Sel p3', 'Sel p4']);
    expectSamePages([a, b, a], out, sel);
  });

  test('merging a file with itself', async () => {
    const a = mupdfDoc('Self');
    const { report, out } = await merge([a, a]);
    expect(report.pageCount).toBe(6);
    expectValid(out);
    expectSamePages([a, a], out);
    expect(linkTargets(out)).toEqual([[2], [], [], [5], [], []]);
  });

  test('twenty inputs', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) =>
      labelled(`D${i}`, 1 + (i % 3), i % 2 ? { xref: 'stream', objStm: true } : { xref: 'table', version: `1.${i % 8}` }),
    );
    const { report, out } = await merge(inputs);
    expect(report.pageCount).toBe(inputs.reduce((n, _, i) => n + 1 + (i % 3), 0));
    expectValid(out);
    const texts = pageTexts(out);
    const want: string[] = [];
    inputs.forEach((_, i) => {
      for (let p = 0; p < 1 + (i % 3); p++) want.push(`D${i} p${p + 1}`);
    });
    expect(texts).toEqual(want);
    expectSamePages(inputs, out, undefined, 20);
  });

  test('mupdf documents: fonts, images, annotations, links and outlines', async () => {
    const a = mupdfDoc('M1');
    const b = mupdfDoc('M2', 4, 'compress');
    const { report, out } = await merge([a, b]);
    expect(report.pageCount).toBe(7);
    expectValid(out);
    expectSamePages([a, b], out);
    expect(linkTargets(out)).toEqual([[2], [], [], [6], [], [], []]);
    expect(outlineOf(out)).toEqual([
      { title: 'Document 1', page: 0, down: [{ title: 'M1 start', page: 0 }, { title: 'M1 end', page: 2 }] },
      { title: 'Document 2', page: 3, down: [{ title: 'M2 start', page: 3 }, { title: 'M2 end', page: 6 }] },
    ]);
  });

  test('a single contributing input keeps its outline as it was', async () => {
    const a = mupdfDoc('Solo');
    const { out } = await merge([labelled('Skipped', 2), a], { pages: [[], [2, 0]] });
    expectValid(out);
    expect(outlineOf(out)).toEqual([
      { title: 'Solo start', page: 1 },
      { title: 'Solo end', page: 0 },
    ]);
    expect(linkTargets(out)).toEqual([[], [0]]);
  });

  test('named destinations become explicit ones', async () => {
    const n = namedDestDoc();
    const x = labelled('X', 1);
    const { out } = await merge([x, n]);
    expectValid(out);
    expectSamePages([x, n], out);
    expect(linkTargets(out)[1]).toEqual([4, 3, 2]);
    expect(outlineOf(out)).toEqual([
      { title: 'Document 1', page: 0 },
      { title: 'Document 2', page: 1, down: [{ title: 'to second', page: 2 }, { title: 'to fourth', page: 4 }] },
    ]);
    expect(text(out)).not.toContain('d.fourth');
    // A destination on a page that is left out resolves to nothing.
    const { out: part } = await merge([n], { pages: [[0, 2]] });
    expectValid(part);
    expect(linkTargets(part)).toEqual([[1], []]);
    // A single contributing input keeps its outline as it was.
    expect(outlineOf(part)).toEqual([{ title: 'to second' }, { title: 'to fourth' }]);
  });

  test('form fields are merged; clashing top-level names are renamed', async () => {
    const one = formDoc('One');
    const two = formDoc('Two');
    const { out } = await merge([one, two, one]);
    expectValid(out);
    expectSamePages([one, two, one], out);
    expect(widgetNames(out)).toEqual([['Name', 'One'], ['Name'], ['Name_2', 'Two'], ['Name_2'], ['Name_3', 'One_2'], ['Name_3']]);
    const doc = await openPdf(new BytesSource(out));
    const cat = (await doc.resolve(doc.trailer.get('Root'))) as PdfDict;
    const form = cat.get('AcroForm') as PdfDict;
    expect((form.get('Fields') as unknown[]).length).toBe(6);
    expect(form.get('DR')).toBeInstanceOf(PdfDict);
  });

  test('only the fields and widgets of selected pages are kept', async () => {
    const one = formDoc('One');
    const { out } = await merge([one], { pages: [[1]] });
    expectValid(out);
    expect(widgetNames(out)).toEqual([['Name']]);
    const s = await inspect(out);
    const widgets = [...s.uncompressed.values()].filter((o) => (o.dict?.get('Subtype') as PdfName | undefined)?.name === 'Widget');
    expect(widgets.length).toBe(1);
    const field = [...s.uncompressed.values()].find((o) => o.dict?.get('FT') !== undefined && o.dict.get('Kids') !== undefined);
    expect((field!.dict!.get('Kids') as unknown[]).length).toBe(1);
  });

  test('optional content: groups, default visibility and order carry over', async () => {
    const l = layerDoc();
    const { out } = await merge([labelled('Plain', 1), l]);
    expectValid(out);
    expectSamePages([labelled('Plain', 1), l], out);
    const doc = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument;
    const layers = Array.from({ length: doc.countLayers() }, (_, i) => [doc.getLayerName(i), doc.isLayerVisible(i)]);
    // mupdf lists them last to first; the unused group is gone.
    expect(layers).toEqual([['Hidden', false], ['Shown', true]]);
    expect(text(out)).toContain('(Group)');
    expect(text(out)).not.toContain('(Empty)');
  });

  test('catalog entries of the first input and its /Info are kept', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('first', 30, 780) });
    const info = b.obj('<< /Title (First title) /Author (Someone) >>');
    const xmp = b.stream('/Type /Metadata /Subtype /XML', bytes('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'));
    const icc = b.stream('/N 3', raw(600, 1));
    b.catalogExtra =
      ' /Lang (en-GB) /PageLayout /TwoColumnLeft /ViewerPreferences << /DisplayDocTitle true >> /OpenAction [3 0 R /Fit]' +
      ` /Metadata ${xmp} 0 R /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile ${icc} 0 R >>] /MarkInfo << /Marked true >>`;
    b.trailer('Info', `${info} 0 R`);
    b.finish();
    const a = b.build().bytes;
    const { out } = await merge([a, labelled('Second', 1)]);
    expectValid(out);
    const doc = mupdf.Document.openDocument(out, 'application/pdf');
    expect(doc.getMetaData('info:Title')).toBe('First title');
    expect(doc.getMetaData('info:Author')).toBe('Someone');
    const ours = await openPdf(new BytesSource(out));
    const cat = (await ours.resolve(ours.trailer.get('Root'))) as PdfDict;
    expect([...cat.map.keys()].sort()).toEqual(['Lang', 'OutputIntents', 'PageLayout', 'Pages', 'Type', 'ViewerPreferences']);
    expect(text(out)).not.toContain('xmpmeta');
  });

  test('version: the highest input version, at least 1.4; a catalog /Version is honoured', async () => {
    const v = async (...versions: string[]) => text((await merge(versions.map((x) => labelled('V', 1, { version: x })))).out, 0, 8);
    expect(await v('1.2')).toBe('%PDF-1.4');
    expect(await v('1.3', '1.6', '1.5')).toBe('%PDF-1.6');
    expect(await v('2.0', '1.4')).toBe('%PDF-2.0');
    const b = new DocBuilder();
    b.page({ content: drawText('v', 30, 780) });
    b.catalogExtra = ' /Version /1.7';
    b.finish();
    const { out } = await merge([labelled('V', 1, { version: '1.4' }), b.build({ version: '1.4' }).bytes]);
    expect(text(out, 0, 8)).toBe('%PDF-1.4');
    expect(text(out)).toContain('/Version /1.7');
    expectValid(out);
  });

  test('encrypted inputs are refused and the sink is aborted', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(labelled('Secret', 1), ['--encrypt', 'user', 'owner', '256', '--']);
    const sink = new AbortableSink();
    const p = mergePdfs([new BytesSource(labelled('Open', 1)), new BytesSource(enc)], sink);
    await expect(p).rejects.toBeInstanceOf(PdfEncryptedError);
    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
  });

  test('signed inputs produce a warning', async () => {
    const { report, out } = await merge([labelled('A', 1), signedDoc()]);
    expectValid(out);
    expect(report.warnings.some((w) => w.startsWith('Input 2:') && /signed/.test(w))).toBe(true);
  });

  test('accepts opened documents and reports progress', async () => {
    const a = labelled('Opened', 2);
    const doc = await openPdf(new BytesSource(a));
    const sink = new BytesSink();
    const events: MergeProgress[] = [];
    const r = await mergePdfs([doc, new BytesSource(labelled('Source', 1))], sink, { pages: [[1]], onProgress: (e) => events.push(e) });
    expect(r.pageCount).toBe(2);
    expect(pageTexts(sink.bytes())).toEqual(['Opened p2', 'Source p1']);
    expect(events.map((e) => e.input)).toEqual([0, 1]);
    for (const e of events) {
      expect(e.inputCount).toBe(2);
      expect(e.processedObjects).toBe(e.totalObjects);
      expect(e.totalObjects).toBeGreaterThan(2);
    }
  });

  test('mutated inputs: a PdfError or an output no worse than the input', async () => {
    const seeds = [namedDestDoc(), imagePagesDoc(), mupdfDoc('Fuzz', 2)];
    let s = 4242;
    const rnd = (n: number): number => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s % n;
    };
    for (let i = 0; i < 45; i++) {
      // Flipped bytes, truncation, or a block copied over another place.
      const d = seeds[i % seeds.length].slice();
      if (i % 3 === 0) for (let k = 0; k < 6; k++) d[rnd(d.length)] = rnd(256);
      else if (i % 3 === 2) d.copyWithin(rnd(d.length), rnd(d.length), rnd(d.length));
      const input = i % 3 === 1 ? d.subarray(0, rnd(d.length)) : d;
      const sink = new AbortableSink();
      try {
        await mergePdfs([new BytesSource(input), new BytesSource(seeds[0])], sink);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).name).toMatch(/^Pdf/);
        expect(sink.aborted).toBe(true);
        continue;
      }
      if (!hasQpdf) continue;
      const got = severity(qpdfCheck(sink.bytes()).code);
      if (got > 0) expect(got).toBeLessThanOrEqual(severity(qpdfCheck(input).code));
    }
  });

  test('bad arguments and aborts reject and abort the sink', async () => {
    const a = labelled('A', 3);
    for (const [inputs, opts, err] of [
      [[a], { pages: [[3]] }, RangeError],
      [[a], { pages: [[-1]] }, RangeError],
      [[], {}, RangeError],
    ] as [Uint8Array[], MergeOptions, typeof Error][]) {
      const sink = new AbortableSink();
      await expect(mergePdfs(inputs.map((x) => new BytesSource(x)), sink, opts)).rejects.toBeInstanceOf(err);
      expect(sink.aborted).toBe(true);
    }
    const ctrl = new AbortController();
    const sink = new AbortableSink();
    const events: MergeProgress[] = [];
    const p = mergePdfs([new BytesSource(a), new BytesSource(a)], sink, {
      signal: ctrl.signal,
      onProgress: (e) => {
        events.push(e);
        ctrl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.aborted).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].input).toBe(0);
    expect(events[0].processedObjects).toBe(events[0].totalObjects);
  });

  test('not a PDF', async () => {
    const sink = new AbortableSink();
    await expect(mergePdfs([new BytesSource(bytes('hello world'))], sink)).rejects.toMatchObject({ name: 'PdfFormatError' });
    expect(sink.aborted).toBe(true);
  });

  test('memory does not grow with the size of the inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leanpdf-merge-'));
    try {
      const run = (mb: number) => {
        const files = [0, 1].map((k) => join(dir, `in-${mb}-${k}.pdf`));
        for (const f of files) writeBigPdf(f, 10, Math.floor((mb << 20) / 10240) * 1024);
        const out = join(dir, `out-${mb}.pdf`);
        const script = `
          import { mergePdfs } from '${root}src/features/merge.ts';
          import { NodeFileSink, NodeFileSource } from '${root}src/io/node.ts';
          import { readFileSync } from 'node:fs';
          const files = ${JSON.stringify(files)};
          const inputs = [];
          for (const f of files) inputs.push(await NodeFileSource.open(f));
          const r = await mergePdfs(inputs, await NodeFileSink.create(${JSON.stringify(out)}));
          // VmHWM is this process's own peak; ru_maxrss can inherit the parent's from before exec.
          let rss = process.resourceUsage().maxRSS * 1024;
          try {
            rss = Number(/VmHWM:\\s+(\\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;
          } catch {}
          console.log(JSON.stringify({ pages: r.pageCount, bytes: r.outputBytes, rss }));
        `;
        const r = spawnSync('bun', ['-e', script], { encoding: 'utf8', cwd: root, maxBuffer: 1 << 20 });
        if (r.status !== 0) throw new Error(r.stderr);
        const res = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
        expect(res.pages).toBe(20);
        expect(statSync(out).size).toBe(res.bytes);
        if (hasQpdf) expect(spawnSync('qpdf', ['--check', out]).status).toBe(0);
        return res.rss as number;
      };
      const small = run(1);
      const large = run(100);
      console.log(`merge peak RSS: 2 x 1 MB -> ${(small / 1048576).toFixed(0)} MB, 2 x 100 MB -> ${(large / 1048576).toFixed(0)} MB`);
      expect(large - small).toBeLessThan(32 << 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** A classic-xref PDF with `pages` pages, each drawing its own raw gray image of `imageBytes` (a multiple of 1024). */
function writeBigPdf(path: string, pages: number, imageBytes: number): void {
  const fd = openSync(path, 'w');
  let pos = 0;
  const offsets: number[] = [];
  const put = (s: string | Uint8Array): void => {
    const b = typeof s === 'string' ? bytes(s) : s;
    writeSync(fd, b);
    pos += b.length;
  };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const chunk = raw(1 << 20, 11);
  const kids: number[] = [];
  let num = 3;
  const draw = 'q 500 0 0 700 50 50 cm /Im Do Q';
  for (let p = 0; p < pages; p++) {
    const [page, content, img] = [num++, num++, num++];
    kids.push(page);
    offsets[page] = pos;
    put(`${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im ${img} 0 R >> >> /Contents ${content} 0 R >>\nendobj\n`);
    offsets[content] = pos;
    put(`${content} 0 obj\n<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`);
    offsets[img] = pos;
    put(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1024 /Height ${imageBytes / 1024} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imageBytes} >>\nstream\n`);
    for (let left = imageBytes; left > 0; left -= chunk.length) put(left >= chunk.length ? chunk : chunk.subarray(0, left));
    put('\nendstream\nendobj\n');
  }
  offsets[1] = pos;
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = pos;
  put(`2 0 obj\n<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>\nendobj\n`);
  const xref = pos;
  let t = `xref\n0 ${num}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < num; n++) t += `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  put(`${t}trailer\n<< /Size ${num} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  closeSync(fd);
}
