import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { openPdf } from '../../src/core/open.ts';
import { getInfo, getPages, parsePdfDate, xmpProperty } from '../../src/features/info.ts';
import { damage, DocBuilder, drawText, flate, type BuildOptions } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import { BytesSource, latin1Bytes } from '../unit/util.ts';

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

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="XMP Producer &amp; Co" pdf:Keywords='a, b'>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Tïtle &lt;from&gt; XMP</rdf:li><rdf:li xml:lang="fr">Titre</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>Ann</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default"/></rdf:Alt></dc:description>
<xmp:CreateDate>2021-02-03T04:05:06+01:00</xmp:CreateDate>
<xmp:ModifyDate>garbage</xmp:ModifyDate>
<xmp:CreatorTool>Tool &#233;&#x263A;</xmp:CreatorTool>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** Info dictionary with PDFDocEncoding, escapes, UTF-16 and UTF-8 strings, and odd dates. */
function infoDoc(opts: BuildOptions = {}): Uint8Array {
  const b = new DocBuilder();
  b.page({ content: drawText('info', 20, 20) });
  b.page({ content: drawText('page two', 20, 20), width: 300, height: 200 });
  const info = b.obj(
    '<< /Title (Caf\\351 \\200 \\223x \\(1\\)) /Author <FEFF00C4D55C> /Subject (Line\\nTwo) /Keywords <EFBBBF48C3A9> ' +
      "/Creator (Writer) /Producer (Maker 1.0) /CreationDate (D:20230405060708+02'00') /ModDate (D:2023) " +
      '/Company (ACME \\(NV\\)) /Trapped /False /Custom 42 /Broken 3 0 R >>',
  );
  b.trailer('Info', `${info} 0 R`);
  b.catalogExtra = ' /Lang (nl-BE)';
  return b.finish().build(opts).bytes;
}

/** Everything flagged: tagged, forms, JavaScript, signature, attachments in a name tree with Kids. */
function flagsDoc(): Uint8Array {
  const b = new DocBuilder();
  b.page({ content: drawText('flags', 20, 20) });
  const sigValue = b.obj('<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00> >>');
  const sig = b.obj(`<< /FT /Sig /T (Signature1) /V ${sigValue} 0 R /Subtype /Widget /Rect [0 0 0 0] >>`);
  const js = b.obj('<< /S /JavaScript /JS (app.alert\\(1\\)) >>');
  const file = b.stream('/Type /EmbeddedFile', new Uint8Array([1, 2, 3]));
  const fs = (n: string) => b.obj(`<< /Type /Filespec /F (${n}) /EF << /F ${file} 0 R >> >>`);
  const leaf1 = b.obj(`<< /Limits [(a) (b)] /Names [(a) ${fs('a')} 0 R (b) ${fs('b')} 0 R] >>`);
  const leaf2 = b.obj(`<< /Limits [(c) (c)] /Names [(c) ${fs('c')} 0 R] >>`);
  const ef = b.obj(`<< /Kids [${leaf1} 0 R ${leaf2} 0 R] >>`);
  b.catalogExtra =
    ` /MarkInfo << /Marked true >> /Version /2.0 /AcroForm << /Fields [${sig} 0 R] >>` +
    ` /Names << /JavaScript << /Names [(init) ${js} 0 R] >> /EmbeddedFiles ${ef} 0 R >>`;
  return b.finish().build().bytes;
}

describe('getInfo', () => {
  test('Info dictionary: PDFDocEncoding, escapes, UTF-16, UTF-8, custom keys and dates', async () => {
    const bytes = infoDoc();
    const info = await getInfo(await open(bytes));
    expect(info.title).toBe('Café • ﬁx (1)');
    expect(info.author).toBe('Ä한');
    expect(info.subject).toBe('Line\nTwo');
    expect(info.keywords).toBe('Hé');
    expect(info.creator).toBe('Writer');
    expect(info.producer).toBe('Maker 1.0');
    expect(info.creationDate?.toISOString()).toBe('2023-04-05T04:07:08.000Z');
    expect(info.modDate?.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    expect(info.custom).toEqual({ Company: 'ACME (NV)', Trapped: 'False' });
    expect(info.language).toBe('nl-BE');
    expect(info.pageCount).toBe(2);
    expect(info.version).toBe('1.7');
    expect(info).toMatchObject({ encrypted: false, tagged: false, hasForms: false, hasJavaScript: false, signed: false, attachments: 0, repaired: false });
    expect(info.warnings).toEqual([]);
    expect(info.metadata).toBeUndefined();

    // mupdf agrees on the decoded text and the page count.
    const m = mu(bytes);
    for (const [k, v] of [['Title', info.title], ['Author', info.author], ['Subject', info.subject], ['Keywords', info.keywords], ['Creator', info.creator], ['Producer', info.producer]]) {
      expect(m.getMetaData(`info:${k}`)).toBe(v);
    }
    expect(m.countPages()).toBe(info.pageCount);
    expect(m.getLanguage()).toBe('nl'); // mupdf keeps only the primary language subtag
    m.destroy();
  });

  test('flags: tagged, forms, JavaScript, signed, attachments, catalog version', async () => {
    const info = await getInfo(await open(flagsDoc()));
    expect(info).toMatchObject({ version: '2.0', tagged: true, hasForms: true, hasJavaScript: true, signed: true, attachments: 3 });
  });

  test('JavaScript in a chained open action, signatures via /SigFlags', async () => {
    const b = new DocBuilder();
    const p = b.page({ content: '' });
    b.catalogExtra =
      ` /OpenAction << /S /GoTo /D [${p} 0 R /Fit] /Next [<< /S /URI /URI (x) >> << /S /JavaScript /JS (1) >>] >>` +
      ' /AcroForm << /Fields [] /SigFlags 3 >> /MarkInfo << /Marked false >>';
    const info = await getInfo(await open(b.finish().build().bytes));
    expect(info).toMatchObject({ hasJavaScript: true, signed: true, hasForms: false, tagged: false });
  });

  test('a plain document has no flags', async () => {
    const b = new DocBuilder();
    b.page({ content: '' });
    b.catalogExtra = ` /OpenAction << /S /URI /URI (https://example.com) >> /AA << /WC << /S /Named /N /Print >> >>`;
    const info = await getInfo(await open(b.finish().build().bytes));
    expect(info).toMatchObject({ hasJavaScript: false, signed: false, hasForms: false, tagged: false, attachments: 0 });
    expect(info.title).toBeUndefined();
  });

  test('XMP metadata fills in what the Info dictionary lacks', async () => {
    for (const compressed of [false, true]) {
      const b = new DocBuilder();
      b.page({ content: '' });
      const xmp = new TextEncoder().encode(XMP);
      const md = compressed ? b.stream('/Type /Metadata /Subtype /XML /Filter /FlateDecode', flate(xmp)) : b.stream('/Type /Metadata /Subtype /XML', xmp);
      const info = b.obj("<< /Author (Info Author) /ModDate (D:20200101000000Z) >>");
      b.trailer('Info', `${info} 0 R`);
      b.catalogExtra = ` /Metadata ${md} 0 R`;
      const r = await getInfo(await open(b.finish().build().bytes));
      expect(r.metadata).toBe(XMP);
      expect(r.title).toBe('Tïtle <from> XMP');
      expect(r.author).toBe('Info Author');
      expect(r.subject).toBeUndefined();
      expect(r.keywords).toBe('a, b');
      expect(r.producer).toBe('XMP Producer & Co');
      expect(r.creator).toBe('Tool é☺');
      expect(r.creationDate?.toISOString()).toBe('2021-02-03T03:05:06.000Z');
      expect(r.modDate?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    }
  });

  test('xmpProperty', () => {
    expect(xmpProperty(XMP, 'dc:creator')).toBe('Ann, Bob');
    expect(xmpProperty(XMP, 'dc:title')).toBe('Tïtle <from> XMP');
    expect(xmpProperty(XMP, 'dc:description')).toBeUndefined();
    expect(xmpProperty(XMP, 'dc:rights')).toBeUndefined();
    expect(xmpProperty('<a:b x="1"/><c:d>  v </c:d>', 'c:d')).toBe('v');
    expect(xmpProperty('<rdf:Bag><rdf:li>x</rdf:li></rdf:Bag>', 'pdf:Keywords')).toBeUndefined();
    expect(xmpProperty('<pdfx:Keywords><rdf:Bag><rdf:li>k1</rdf:li><rdf:li>k2</rdf:li></rdf:Bag></pdfx:Keywords>', 'pdfx:Keywords')).toBe('k1, k2');
  });

  test('a document written by mupdf, also with object streams', async () => {
    const doc = new mupdf.PDFDocument();
    for (const [w, h, rot] of [[300, 400, 0], [500, 200, 90]] as const) doc.insertPage(-1, doc.addPage([0, 0, w, h], rot, doc.newDictionary(), '0 0 1 rg 10 10 50 50 re f'));
    doc.setMetaData('info:Title', 'Straße – 日本語 ✓');
    doc.setMetaData('info:Author', 'Jöhn');
    doc.setMetaData('info:Subject', 'Subj');
    doc.setMetaData('info:Keywords', 'k1, k2');
    doc.setMetaData('info:Creator', 'Creator');
    doc.setMetaData('info:CreationDate', "D:20240102030405-08'00'");
    doc.setMetaData('info:ModDate', 'D:20240102');
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const variants: Uint8Array[] = [bytes];
    if (hasQpdf) variants.push(qpdfTransform(bytes, ['--object-streams=generate']));
    for (const v of variants) {
      const info = await getInfo(await open(v));
      const m = mu(v);
      expect(info.title).toBe('Straße – 日本語 ✓');
      for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator']) {
        expect(info[k.toLowerCase() as 'title']).toBe(m.getMetaData(`info:${k}`)!);
      }
      expect(info.creationDate?.toISOString()).toBe('2024-01-02T11:04:05.000Z');
      expect(info.modDate?.toISOString()).toBe('2024-01-02T00:00:00.000Z');
      expect(info.pageCount).toBe(m.countPages());
      expect(`PDF ${info.version}`).toBe(m.getMetaData('format')!);
      m.destroy();
    }
  });

  test('encrypted documents are reported, not rejected', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(infoDoc(), ['--encrypt', '', 'owner', '256', '--']);
    const info = await getInfo(await open(enc));
    expect(info.encrypted).toBe(true);
    expect(info.pageCount).toBe(2);
    expect(info.title).toBeUndefined();
    expect(info.language).toBeUndefined();
    const pages = await getPages(await open(enc));
    expect(pages.map((p) => [p.width, p.height])).toEqual([[595, 842], [300, 200]]);
  });

  test('damaged documents: repaired flag and warnings', async () => {
    const bytes = damage.startxref(infoDoc({ xref: 'stream', objStm: true }), 7);
    const info = await getInfo(await open(bytes));
    expect(info.repaired).toBe(true);
    expect(info.warnings.length).toBeGreaterThan(0);
    expect(info.title).toBe('Café • ﬁx (1)');
    expect(info.pageCount).toBe(2);
    const truncated = damage.truncate(infoDoc(), infoDoc().length - 200);
    const t = await getInfo(await open(truncated));
    expect(t.repaired).toBe(true);
    expect(t.pageCount).toBe(2);
  });

  test('damaged copies settle with a result or an Error', async () => {
    const n = await survives(flagsDoc(), 1, async (doc) => {
      await getInfo(doc);
      await getPages(doc);
    });
    expect(n).toBeGreaterThan(20);
  });
});

describe('getPages', () => {
  test('sizes from the crop box, inherited attributes, rotation and labels, like mupdf', async () => {
    const b = new DocBuilder();
    const content = b.stream('', new Uint8Array(0));
    const pages = [
      `/MediaBox [0 0 612 792]`,
      `/MediaBox [0 0 612 792] /CropBox [10 20 310 420] /Rotate 90`,
      `/CropBox [-50 -50 100 100]`, // inherits MediaBox [0 0 400 500], clipped
      `/Rotate -90`,
      `/MediaBox [200 300 0 0] /Rotate 450`,
      `/CropBox [1000 1000 2000 2000]`, // outside the media box: ignored
    ];
    for (const extra of pages) b.pages.push(b.obj(`<< /Type /Page /Parent ${b.pagesNum} 0 R ${extra} /Contents ${content} 0 R >>`));
    b.pagesDict = () => `<< /Type /Pages /Kids [${b.pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${b.pages.length} /MediaBox [0 0 400 500] /Rotate 180 >>`;
    b.catalogExtra = ' /PageLabels << /Nums [0 << /S /r >> 2 << /S /D /P (A-) /St 5 >> 4 << /S /A /St 27 >> 5 << /P (Cover) >>] >>';
    const bytes = b.finish().build().bytes;
    const got = await getPages(await open(bytes));
    expect(got).toEqual([
      { width: 612, height: 792, rotate: 180, label: 'i' },
      { width: 300, height: 400, rotate: 90, label: 'ii' },
      { width: 100, height: 100, rotate: 180, label: 'A-5' },
      { width: 400, height: 500, rotate: 270, label: 'A-6' },
      { width: 200, height: 300, rotate: 90, label: 'AA' },
      { width: 400, height: 500, rotate: 180, label: 'Cover' },
    ]);
    const m = mu(bytes);
    expect(m.countPages()).toBe(got.length);
    got.forEach((p, i) => {
      const page = m.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const [w, h] = p.rotate % 180 ? [p.height, p.width] : [p.width, p.height];
      if (i !== 5) expect([x1 - x0, y1 - y0]).toEqual([w, h]); // mupdf keeps a crop box outside the media box
      expect(page.getLabel()).toBe(p.label!);
      page.destroy();
    });
    m.destroy();
  });

  test('no labels without /PageLabels', async () => {
    const b = new DocBuilder();
    b.page({ content: '', width: 100, height: 50 });
    expect(await getPages(await open(b.finish().build().bytes))).toEqual([{ width: 100, height: 50, rotate: 0 }]);
  });
});

describe('parsePdfDate', () => {
  const cases: [string | undefined, string | undefined][] = [
    ["D:20230405060708+02'00'", '2023-04-05T04:07:08.000Z'],
    ["D:20230405060708+02'00", '2023-04-05T04:07:08.000Z'],
    ['D:20230405060708Z', '2023-04-05T06:07:08.000Z'],
    ["D:20230405060708Z00'00'", '2023-04-05T06:07:08.000Z'],
    ["D:20230405060708-05'30'", '2023-04-05T11:37:08.000Z'],
    ['D:20230405060708+0530', '2023-04-05T00:37:08.000Z'],
    ['D:20230405060708+05', '2023-04-05T01:07:08.000Z'],
    ['D:202304050607', '2023-04-05T06:07:00.000Z'],
    ['20230405', '2023-04-05T00:00:00.000Z'],
    ['D:2023', '2023-01-01T00:00:00.000Z'],
    ['D:202304', '2023-04-01T00:00:00.000Z'],
    [' D:19991231235959 ', '1999-12-31T23:59:59.000Z'],
    ['2023-04-05T06:07:08+02:00', '2023-04-05T04:07:08.000Z'],
    ['2023-04-05T06:07:08.25Z', '2023-04-05T06:07:08.250Z'],
    ['2023-04-05', '2023-04-05T00:00:00.000Z'],
    ['D:20231301', undefined],
    ['D:20230230', undefined],
    ['D:20230405246000', undefined],
    ['D:20230405066000', undefined],
    ['yesterday', undefined],
    ['D:', undefined],
    ['', undefined],
    [undefined, undefined],
    ['2023-13-45', undefined],
  ];
  for (const [s, iso] of cases) {
    test(JSON.stringify(s), () => expect(parsePdfDate(s)?.toISOString()).toBe(iso as string));
  }
});

describe('core issues found while testing', () => {
  // src/core/lexer.ts decodeName() looks for '#' with `b.indexOf(0x23, s)`, which scans to the
  // end of the buffer, not of the name: every name token costs O(rest of buffer). Objects in a
  // large object stream parse orders of magnitude slower (walking 5000 pages kept in one object
  // stream takes ~1.6 s instead of ~0.15 s). Fix: search only [s, e), e.g.
  // `b.subarray(s, e).indexOf(0x23)`. Flip to `test` once fixed.
  test('a name token costs time proportional to the name, not to the buffer', async () => {
    const { Lexer } = await import('../../src/core/lexer.ts');
    const buf = new Uint8Array(8 << 20).fill(0x20);
    buf.set(latin1Bytes('/Name '), 0);
    const t = performance.now();
    for (let i = 0; i < 1000; i++) new Lexer(buf, 0, true).next();
    expect(performance.now() - t).toBeLessThan(50);
  });
});
