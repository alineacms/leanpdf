import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { inflateSync } from 'node:zlib';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { nameOf, PdfDict, PdfRef, type PdfObj } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { pageNumbers } from '../../src/core/pages.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { removeAttachments, removeJavaScript, stripMetadata } from '../../src/features/strip.ts';
import { removeUnused } from '../../src/features/unused.ts';
import { bytes, DocBuilder, drawImage, drawText, flate, text } from '../support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfTransform } from '../support/qpdf.ts';
import { renderPdf, sameRaster } from '../support/render.ts';
import { BytesSink, BytesSource } from '../unit/util.ts';

if (!hasQpdf) console.warn(QPDF_MISSING);

async function run(input: Uint8Array, plugins: Plugin[]) {
  const sink = new BytesSink();
  const report = await rewritePdf(new BytesSource(input), sink, plugins);
  return { out: sink.bytes(), report };
}

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

function expectValid(out: Uint8Array): void {
  if (!hasQpdf) return;
  const r = qpdfCheck(out);
  if (r.code !== 0) console.error(r.output);
  expect(r.code).toBe(0);
}

/** Every page renders exactly as before. */
function expectSameRendering(a: Uint8Array, b: Uint8Array): void {
  const x = renderPdf(a, 8);
  const y = renderPdf(b, 8);
  expect(y.pageCount).toBe(x.pageCount);
  x.pages.forEach((p, i) => expect(sameRaster(p!, y.pages[i]!)).toBe(true));
}

/** The file's bytes plus the inflated data of every stream: what anyone could dig out of it. */
function everything(b: Uint8Array): string {
  const s = text(b);
  let out = s;
  const re = /stream\r?\n/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out += text(new Uint8Array(inflateSync(b.subarray(start, end))));
    } catch {}
  }
  return out;
}

const xmp = (s: string) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${s}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const SECRETS = {
  meta: ['SECRET-TITLE', 'SECRET-AUTHOR', 'SECRET-XMP-DOC', 'SECRET-XMP-PAGE', 'SECRET-XMP-IMAGE', 'SECRET-PIECE', 'SECRET-THUMB'],
  js: ['SECRET-JS-STREAM', 'SECRET-JS-OPEN', 'SECRET-JS-CLOSE', 'SECRET-JS-LINK', 'SECRET-JS-URI', 'SECRET-JS-NEXT', 'SECRET-JS-KEY', 'SECRET-JS-CALC', 'SECRET-JS-PAGE', 'SECRET-JS-DIRECT', 'SECRET-JS-OUTLINE', 'SECRET-JS-RENDITION', 'SECRET-JS-RENDITION-ONLY'],
  files: ['SECRET-FILE-1', 'SECRET-FILE-2', 'SECRET-FILE-3', 'SECRET-FILE-4', 'SECRET-FILE-DESC'],
};

interface Rich {
  bytes: Uint8Array;
  n: Record<string, number>;
}

/**
 * Three pages carrying metadata at every level, JavaScript in every place it can hide, and
 * embedded files of each kind; everything hidden so rendering is unaffected by removing it.
 */
function richDoc(opts: { objStm?: boolean } = {}): Rich {
  const b = new DocBuilder();
  const n: Record<string, number> = {};
  const embedded = (name: string, data: string, desc = '') => {
    const ef = b.stream('/Type /EmbeddedFile /Subtype /text#2Fplain', bytes(data));
    return b.obj(`<< /Type /Filespec /F (${name}) /UF (${name}) /EF << /F ${ef} 0 R >>${desc ? ` /Desc (${desc})` : ''} >>`);
  };
  const p = [b.alloc(), b.alloc(), b.alloc()];
  // Metadata.
  n.xmp = b.stream('/Type /Metadata /Subtype /XML', bytes(xmp('SECRET-XMP-DOC')));
  n.info = b.obj('<< /Title (SECRET-TITLE) /Author (SECRET-AUTHOR) /Producer (pdfgen) >>');
  n.pageXmp = b.stream('/Type /Metadata /Subtype /XML', bytes(xmp('SECRET-XMP-PAGE')));
  n.thumb = b.stream('/Width 4 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 8', bytes('SECRET-THUMB'));
  n.imgXmp = b.stream('/Type /Metadata /Subtype /XML', bytes(xmp('SECRET-XMP-IMAGE')));
  n.fs4 = embedded('image-source.csv', 'SECRET-FILE-4');
  n.img = b.stream(
    `/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Metadata ${n.imgXmp} 0 R /AF [${n.fs4} 0 R]`,
    Uint8Array.of(0, 255, 255, 0),
  );
  // JavaScript.
  n.jsStream = b.stream('', bytes('app.alert("SECRET-JS-STREAM");'));
  n.jsDoc = b.obj(`<< /S /JavaScript /JS ${n.jsStream} 0 R >>`);
  n.jsTree = b.obj(`<< /Names [(init) ${n.jsDoc} 0 R] >>`);
  n.jsKey = b.obj('<< /S /JavaScript /JS (AFNumber_Keystroke\\(SECRET-JS-KEY\\);) >>');
  // Attachments.
  n.fs1 = embedded('one.txt', 'SECRET-FILE-1', 'SECRET-FILE-DESC');
  n.fs2 = embedded('two.txt', 'SECRET-FILE-2');
  n.fs3 = embedded('three.xml', 'SECRET-FILE-3');
  n.efTree = b.obj(`<< /Names [(one.txt) ${n.fs1} 0 R] >>`);
  // Annotations on page 0.
  n.linkJs = b.obj(`<< /Type /Annot /Subtype /Link /Rect [40 700 200 720] /Border [0 0 0] /A << /S /JavaScript /JS (app.alert\\('SECRET-JS-LINK'\\)) >> >>`);
  n.linkUri = b.obj(`<< /Type /Annot /Subtype /Link /Rect [40 670 200 690] /Border [0 0 0] /A << /S /URI /URI (javascript:alert\\('SECRET-JS-URI'\\)) >> >>`);
  n.goToNext = b.obj(`<< /S /GoTo /D [${p[1]} 0 R /Fit] /Next [<< /S /JavaScript /JS (SECRET-JS-NEXT) >> << /S /Rendition /JS (SECRET-JS-RENDITION-ONLY) >> << /S /Rendition /OP 0 /R << /Type /Rendition /S /MR >> /JS (SECRET-JS-RENDITION) >>] >>`);
  n.linkChain = b.obj(`<< /Type /Annot /Subtype /Link /Rect [40 640 200 660] /Border [0 0 0] /A ${n.goToNext} 0 R >>`);
  n.linkOk = b.obj(`<< /Type /Annot /Subtype /Link /Rect [40 610 200 630] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>`);
  n.fa = b.alloc();
  n.popup = b.obj(`<< /Type /Annot /Subtype /Popup /Rect [300 600 400 700] /F 2 /Parent ${n.fa} 0 R >>`);
  b.setObj(n.fa, `<< /Type /Annot /Subtype /FileAttachment /Rect [300 700 320 720] /F 2 /FS ${n.fs2} 0 R /Contents (attached) /Popup ${n.popup} 0 R >>`);
  n.widget = b.obj(
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (amount) /Rect [40 500 200 520] /F 2 /P ${p[0]} 0 R ` +
      `/AA << /K ${n.jsKey} 0 R /C << /S /JavaScript /JS (SECRET-JS-CALC) >> >> >>`,
  );
  // Outline: one scripted item, one plain.
  n.outlines = b.alloc();
  n.item1 = b.alloc();
  n.item2 = b.alloc();
  b.setObj(n.item1, `<< /Title (Scripted) /Parent ${n.outlines} 0 R /Next ${n.item2} 0 R /A << /S /JavaScript /JS (SECRET-JS-OUTLINE) >> >>`);
  b.setObj(n.item2, `<< /Title (Plain) /Parent ${n.outlines} 0 R /Prev ${n.item1} 0 R /Dest [${p[2]} 0 R /Fit] >>`);
  b.setObj(n.outlines, `<< /Type /Outlines /First ${n.item1} 0 R /Last ${n.item2} 0 R /Count 2 >>`);
  n.struct = b.obj(`<< /Type /StructTreeRoot /K << /S /Document /K [<< /Type /OBJR /Obj ${n.fa} 0 R /Pg ${p[0]} 0 R >>] >> >>`);

  const pages = [
    { content: drawText('Page one', 40, 780, 18) + drawImage('Im0', 300, 300, 100, 100), xobjects: { Im0: n.img } },
    { content: drawText('Page two', 40, 780, 18) },
    { content: drawText('Page three', 40, 780, 18) },
  ];
  const extra = [
    ` /Metadata ${n.pageXmp} 0 R /PieceInfo << /Editor << /Private (SECRET-PIECE) /LastModified (D:20200101) >> >> /LastModified (D:20200101) /Thumb ${n.thumb} 0 R` +
      ` /Annots [${n.linkJs} 0 R ${n.linkUri} 0 R ${n.linkChain} 0 R ${n.linkOk} 0 R ${n.fa} 0 R ${n.popup} 0 R ${n.widget} 0 R] /AF [${n.fs3} 0 R]`,
    ` /AA << /O << /S /JavaScript /JS (SECRET-JS-PAGE) >> /C << /S /GoTo /D [${p[0]} 0 R /Fit] >> >>`,
    ` /Annots [<< /Type /Annot /Subtype /Link /Rect [40 700 200 720] /A << /S /JavaScript /JS (SECRET-JS-DIRECT) >> >>]`,
  ];
  pages.forEach((spec, i) => {
    const c = b.stream('/Filter /FlateDecode', flate(bytes(spec.content)));
    b.setObj(p[i], b.pageDict({ ...spec, extra: extra[i] }, c));
    b.pages.push(p[i]);
  });
  n.p0 = p[0];
  n.p1 = p[1];
  n.p2 = p[2];
  b.catalogExtra =
    ` /Metadata ${n.xmp} 0 R /Names << /JavaScript ${n.jsTree} 0 R /EmbeddedFiles ${n.efTree} 0 R >>` +
    ` /OpenAction << /S /JavaScript /JS (SECRET-JS-OPEN) /Next << /S /GoTo /D [${p[1]} 0 R /Fit] >> >>` +
    ` /AA << /WC << /S /JavaScript /JS (SECRET-JS-CLOSE) >> >> /AcroForm << /Fields [${n.widget} 0 R] /CO [${n.widget} 0 R] >>` +
    ` /AF [${n.fs3} 0 R] /Collection << /Type /Collection >> /Outlines ${n.outlines} 0 R /StructTreeRoot ${n.struct} 0 R /MarkInfo << /Marked true >>`;
  b.finish('rich');
  b.trailer('Info', `${n.info} 0 R`);
  const built = b.build(opts.objStm ? { xref: 'stream', objStm: true, version: '1.5' } : {});
  return { bytes: built.bytes, n };
}

async function dictAt(b: Uint8Array, num: number): Promise<PdfDict> {
  const v = await (await open(b)).getObject(num);
  expect(v).toBeInstanceOf(PdfDict);
  return v as PdfDict;
}

const catalogOf = async (b: Uint8Array): Promise<PdfDict> => {
  const doc = await open(b);
  return (await doc.resolve(doc.trailer.get('Root'))) as PdfDict;
};

const refNums = (o: PdfObj | undefined): number[] => (Array.isArray(o) ? o.filter((x) => x instanceof PdfRef).map((x) => (x as PdfRef).num) : []);

function mu(b: Uint8Array): mupdf.PDFDocument {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  return mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
}

for (const objStm of [false, true]) {
  const label = objStm ? ' (object streams)' : '';
  const rich = richDoc({ objStm });

  test(`the fixture carries every secret and is valid${label}`, () => {
    const all = everything(rich.bytes);
    for (const s of [...SECRETS.meta, ...SECRETS.js, ...SECRETS.files]) expect(all).toContain(s);
    expectValid(rich.bytes);
  });

  describe(`stripMetadata${label}`, () => {
    test('removes document, page and image metadata, and nothing else', async () => {
      const { out } = await run(rich.bytes, [stripMetadata()]);
      expectValid(out);
      expectSameRendering(rich.bytes, out);
      const all = everything(out);
      for (const s of SECRETS.meta) expect(all).not.toContain(s);
      for (const s of [...SECRETS.js, ...SECRETS.files]) expect(all).toContain(s);
      const doc = await open(out);
      expect(doc.trailer.get('Info')).toBeUndefined();
      const cat = await catalogOf(out);
      expect(cat.get('Metadata')).toBeUndefined();
      expect(cat.get('Names')).toBeDefined();
      const page = await dictAt(out, rich.n.p0);
      for (const k of ['Metadata', 'PieceInfo', 'LastModified', 'Thumb']) expect(page.get(k)).toBeUndefined();
      expect(page.get('Annots')).toBeDefined();
      expect((await dictAt(out, rich.n.img)).get('Metadata')).toBeUndefined();
      // The detached objects are gone, not just unreferenced.
      for (const k of ['info', 'xmp', 'pageXmp', 'thumb', 'imgXmp']) expect(await doc.getObject(rich.n[k])).toBeUndefined();
      const m = mu(out);
      expect(m.getMetaData('info:Title') ?? '').toBe('');
      expect(m.getMetaData('info:Author') ?? '').toBe('');
      expect(m.countPages()).toBe(3);
    });

    test('deep: false keeps metadata below the page level', async () => {
      const { out } = await run(rich.bytes, [stripMetadata({ deep: false })]);
      expectValid(out);
      const all = everything(out);
      expect(all).toContain('SECRET-XMP-IMAGE');
      for (const s of SECRETS.meta.filter((x) => x !== 'SECRET-XMP-IMAGE')) expect(all).not.toContain(s);
    });
  });

  describe(`removeJavaScript${label}`, () => {
    test('removes every script, keeps the other actions, renders the same', async () => {
      const { out } = await run(rich.bytes, [removeJavaScript()]);
      expectValid(out);
      expectSameRendering(rich.bytes, out);
      const all = everything(out);
      for (const s of SECRETS.js) expect(all).not.toContain(s);
      for (const s of [...SECRETS.meta, ...SECRETS.files]) expect(all).toContain(s);
      const doc = await open(out);
      const cat = await catalogOf(out);
      const names = (await doc.resolve(cat.get('Names'))) as PdfDict;
      expect(names.get('JavaScript')).toBeUndefined();
      expect(names.get('EmbeddedFiles')).toBeDefined();
      expect(cat.get('AA')).toBeUndefined();
      // The open action was a script followed by a GoTo: the GoTo remains.
      const open0 = (await doc.resolve(cat.get('OpenAction'))) as PdfDict;
      expect(nameOf(open0.get('S'))).toBe('GoTo');
      expect(open0.get('Next')).toBeUndefined();
      const form = (await doc.resolve(cat.get('AcroForm'))) as PdfDict;
      expect(form.get('CO')).toBeUndefined();
      expect(refNums(await doc.resolve(form.get('Fields')))).toEqual([rich.n.widget]);
      expect((await dictAt(out, rich.n.widget)).get('AA')).toBeUndefined();
      // Script links stay, inert; the GoTo link loses its scripted /Next; the URI link is intact.
      expect((await dictAt(out, rich.n.linkJs)).get('A')).toBeUndefined();
      expect((await dictAt(out, rich.n.linkUri)).get('A')).toBeUndefined();
      const chain = (await dictAt(out, rich.n.goToNext));
      expect(nameOf(chain.get('S'))).toBe('GoTo');
      const next = (await doc.resolve(chain.get('Next'))) as PdfObj[];
      expect(next.length).toBe(1);
      expect(nameOf((next[0] as PdfDict).get('S'))).toBe('Rendition');
      expect((next[0] as PdfDict).get('JS')).toBeUndefined();
      expect((next[0] as PdfDict).get('R')).toBeInstanceOf(PdfDict);
      expect((await dictAt(out, rich.n.linkOk)).get('A')).toBeInstanceOf(PdfDict);
      // Page 1 keeps its close action, not its open script.
      const aa = (await dictAt(out, rich.n.p1)).get('AA') as PdfDict;
      expect([...aa.map.keys()]).toEqual(['C']);
      // Outline items stay; the scripted one loses its action.
      expect((await dictAt(out, rich.n.item1)).get('A')).toBeUndefined();
      expect((await dictAt(out, rich.n.item2)).get('Dest')).toBeDefined();
      // The script objects themselves are gone.
      for (const k of ['jsDoc', 'jsStream', 'jsTree', 'jsKey']) expect(await doc.getObject(rich.n[k])).toBeUndefined();
      const m = mu(out);
      const links = m.loadPage(0).getLinks().map((l) => l.getURI());
      expect(links).toContain('https://example.com/');
      expect(links.some((u) => u.startsWith('javascript'))).toBe(false);
      expect(m.loadOutline()?.map((o) => o.title)).toEqual(['Scripted', 'Plain']);
    });
  });

  describe(`removeAttachments${label}`, () => {
    test('removes embedded files, file attachment annotations and associated files', async () => {
      const { out } = await run(rich.bytes, [removeAttachments()]);
      expectValid(out);
      expectSameRendering(rich.bytes, out);
      const all = everything(out);
      for (const s of SECRETS.files) expect(all).not.toContain(s);
      for (const s of [...SECRETS.meta, ...SECRETS.js]) expect(all).toContain(s);
      const doc = await open(out);
      const cat = await catalogOf(out);
      const names = (await doc.resolve(cat.get('Names'))) as PdfDict;
      expect(names.get('EmbeddedFiles')).toBeUndefined();
      expect(names.get('JavaScript')).toBeDefined();
      expect(cat.get('AF')).toBeUndefined();
      expect(cat.get('Collection')).toBeUndefined();
      const page = await dictAt(out, rich.n.p0);
      expect(page.get('AF')).toBeUndefined();
      const annots = refNums(await doc.resolve(page.get('Annots')));
      expect(annots).toEqual([rich.n.linkJs, rich.n.linkUri, rich.n.linkChain, rich.n.linkOk, rich.n.widget]);
      expect((await dictAt(out, rich.n.img)).get('AF')).toBeUndefined();
      // Still referenced from the structure tree, the annotation reads as null there.
      expect(await doc.getObject(rich.n.fa)).toBeNull();
      for (const k of ['fs1', 'fs2', 'fs3', 'fs4', 'efTree', 'popup']) expect(await doc.getObject(rich.n[k])).toBeUndefined();
      const m = mu(out);
      expect(Object.keys(m.getEmbeddedFiles())).toEqual([]);
      expect(m.loadPage(0).getAnnotations().map((a) => a.getType())).not.toContain('FileAttachment');
    });
  });

  test(`all three, with removeUnused, in one pass${label}`, async () => {
    const { out } = await run(rich.bytes, [removeUnused(), removeAttachments(), removeJavaScript(), stripMetadata()]);
    expectValid(out);
    expectSameRendering(rich.bytes, out);
    const all = everything(out);
    for (const s of [...SECRETS.meta, ...SECRETS.js, ...SECRETS.files]) expect(all).not.toContain(s);
    expect(await pageNumbers(await open(out))).toEqual([rich.n.p0, rich.n.p1, rich.n.p2]);
    expect(out.length).toBeLessThan(rich.bytes.length);
  });
}

describe('documents written by mupdf', () => {
  function made(): Uint8Array {
    const doc = new mupdf.PDFDocument();
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    const res = doc.addObject({ Font: { F1: font } });
    for (const t of ['First', 'Second']) doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, res, `BT /F1 24 Tf 20 150 Td (${t}) Tj ET`));
    doc.setMetaData('info:Title', 'MU-SECRET-TITLE');
    doc.setMetaData('info:Author', 'MU-SECRET-AUTHOR');
    const enc = (s: string) => new TextEncoder().encode(s);
    doc.insertEmbeddedFile('a.txt', doc.addEmbeddedFile('a.txt', 'text/plain', enc('MU-SECRET-FILE-A'), new Date(0), new Date(0)));
    const page = doc.loadPage(1);
    const annot = page.createAnnotation('FileAttachment');
    annot.setRect([10, 10, 30, 30]);
    annot.setFileSpec(doc.addEmbeddedFile('b.txt', 'text/plain', enc('MU-SECRET-FILE-B'), new Date(0), new Date(0)));
    annot.update();
    const js = doc.addObject({ S: 'JavaScript', JS: doc.newString('app.alert("MU-SECRET-JS")') });
    doc.getTrailer().get('Root').put('OpenAction', js);
    return doc.saveToBuffer('compress,objstms').asUint8Array().slice();
  }

  test('all secrets go, the pages stay', async () => {
    const input = made();
    const all0 = everything(input);
    for (const s of ['MU-SECRET-TITLE', 'MU-SECRET-FILE-A', 'MU-SECRET-FILE-B', 'MU-SECRET-JS']) expect(all0).toContain(s);
    const { out } = await run(input, [stripMetadata(), removeJavaScript(), removeAttachments()]);
    expectValid(out);
    const all = everything(out);
    for (const s of ['MU-SECRET-TITLE', 'MU-SECRET-AUTHOR', 'MU-SECRET-FILE-A', 'MU-SECRET-FILE-B', 'MU-SECRET-JS']) expect(all).not.toContain(s);
    const m = mu(out);
    expect(m.countPages()).toBe(2);
    expect(m.loadPage(1).toStructuredText('preserve-whitespace').asText()).toContain('Second');
    expect(m.loadPage(1).getAnnotations().length).toBe(0);
    // The first page has no annotation: it renders as before.
    expect(sameRaster(renderPdf(out, 1).pages[0]!, renderPdf(input, 1).pages[0]!)).toBe(true);
  });
});

describe('edge cases', () => {
  const plain = (): Uint8Array => {
    const b = new DocBuilder();
    b.page({ content: drawText('Plain', 40, 780) });
    return b.finish('plain').build().bytes;
  };

  test('documents without any of it come out valid and unchanged in content', async () => {
    const input = plain();
    for (const p of [stripMetadata(), removeJavaScript(), removeAttachments()]) {
      const { out } = await run(input, [p]);
      expectValid(out);
      expectSameRendering(input, out);
    }
  });

  test('a plugin instance can be reused for several rewrites', async () => {
    const js = removeJavaScript();
    const a = await run(richDoc().bytes, [js]);
    const b = await run(richDoc().bytes, [js]);
    expect(b.out).toEqual(a.out);
  });

  test('action cycles and shared script actions do not hang', async () => {
    const b = new DocBuilder();
    const a1 = b.alloc();
    const target = b.page({ content: drawText('Target', 40, 780) });
    const a2 = b.obj(`<< /S /GoTo /D [${target} 0 R /Fit] /Next ${a1} 0 R >>`);
    b.setObj(a1, `<< /S /JavaScript /JS (x) /Next ${a2} 0 R >>`);
    const shared = b.obj('<< /S /JavaScript /JS (SHARED-SCRIPT) >>');
    b.page({ content: drawText('Cycle', 40, 780), extra: ` /AA << /O ${a1} 0 R /C ${shared} 0 R >>` });
    b.page({ content: drawText('Shared', 40, 780), extra: ` /AA << /O ${shared} 0 R >>` });
    b.catalogExtra = ` /OpenAction ${a2} 0 R`;
    const input = b.finish('cycle').build().bytes;
    const { out } = await run(input, [removeJavaScript()]);
    expectValid(out);
    expect(everything(out)).not.toContain('SHARED-SCRIPT');
    const doc = await open(out);
    const cat = await catalogOf(out);
    const opened = (await doc.resolve(cat.get('OpenAction'))) as PdfDict;
    expect(nameOf(opened.get('S'))).toBe('GoTo');
  });

  test('encrypted documents are rejected, also next to a decrypting plugin', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(richDoc().bytes, ['--encrypt', 'u', 'o', '256', '--']);
    for (const p of [stripMetadata(), removeJavaScript(), removeAttachments(), removeUnused()]) {
      await expect(run(enc, [p])).rejects.toBeInstanceOf(PdfEncryptedError);
      await expect(run(enc, [{ decrypts: true }, p])).rejects.toBeInstanceOf(PdfEncryptedError);
    }
  });
});
