import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { PdfDocument } from '../../src/core/document.ts';
import { PdfDict, PdfName } from '../../src/core/objects.ts';
import { SourceReader } from '../../src/core/reader.ts';
import { E_COMPRESSED, E_FREE, E_OFFSET, findStartXref, loadXref } from '../../src/core/xref.ts';
import { BASE_OBJECTS, BytesSource, latin1Bytes, miniPdf } from './util.ts';

const reader = (s: string | Uint8Array) => new SourceReader(new BytesSource(s));
const open = (s: string | Uint8Array) => PdfDocument.open(reader(s));
const bin = (u: Uint8Array) => Buffer.from(u).toString('latin1');

/** Encode xref stream rows [type, a, b] with widths w, optionally PNG-Up predicted. */
function xrefRows(rows: [number, number, number][], w: number[], predict: boolean): Uint8Array {
  const rowLen = w[0] + w[1] + w[2];
  const raw: number[] = [];
  let prev = new Array(rowLen).fill(0);
  for (const r of rows) {
    const cur: number[] = [];
    r.forEach((v, i) => {
      for (let k = w[i] - 1; k >= 0; k--) cur.push(Math.floor(v / 256 ** k) % 256);
    });
    if (predict) raw.push(2, ...cur.map((v, i) => (v - prev[i]) & 255));
    else raw.push(...cur);
    prev = cur;
  }
  return new Uint8Array(deflateSync(Uint8Array.from(raw)));
}

/** A document whose pages tree lives in an object stream, indexed by an xref stream. */
function objStmPdf(opts: { predict?: boolean; hybrid?: boolean } = {}): string {
  let text = '%PDF-1.5\n%\xe2\xe3\xcf\xd3\n';
  const off: Record<number, number> = {};
  const add = (num: number, body: string) => {
    off[num] = text.length;
    text += `${num} 0 obj\n${body}\nendobj\n`;
  };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const members = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>'];
  const head = `2 0 3 ${members[0].length + 1} `;
  const body = head + members.join(' ');
  add(5, `<< /Type /ObjStm /N 2 /First ${head.length} /Length ${body.length} >>\nstream\n${body}\nendstream`);
  add(4, BASE_OBJECTS[3].body);
  const rows: [number, number, number][] = [
    [0, 0, 65535],
    [1, off[1], 0],
    [2, 5, 0],
    [2, 5, 1],
    [1, off[4], 0],
    [1, off[5], 0],
    [1, text.length, 0],
  ];
  const w = [1, 3, 2];
  const data = xrefRows(rows, w, opts.predict ?? true);
  const parms = opts.predict === false ? '' : ' /DecodeParms << /Predictor 12 /Columns 6 >>';
  const xrefStm = text.length;
  text += `6 0 obj\n<< /Type /XRef /Size 7 /W [1 3 2] /Root 1 0 R /Filter /FlateDecode${parms} /Length ${data.length} >>\nstream\n${bin(data)}\nendstream\nendobj\n`;
  if (!opts.hybrid) return text + `startxref\n${xrefStm}\n%%EOF\n`;
  // Hybrid: a classic table that lists the compressed objects as free, plus /XRefStm.
  const table = text.length;
  const e = (o: number, g: number, t: string) => `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} ${t}\r\n`;
  text += 'xref\n0 7\n' + e(0, 65535, 'f') + e(off[1], 0, 'n') + e(0, 0, 'f') + e(0, 0, 'f') + e(off[4], 0, 'n') + e(off[5], 0, 'n') + e(0, 0, 'f');
  return text + `trailer\n<< /Size 7 /Root 1 0 R /XRefStm ${xrefStm} >>\nstartxref\n${table}\n%%EOF\n`;
}

describe('classic xref tables', () => {
  test('entries, free entries and trailer', async () => {
    const { text, offsets } = miniPdf(BASE_OBJECTS, '/Root 1 0 R /Info 3 0 R');
    const r = reader(text);
    const load = await loadXref(r, await findStartXref(r));
    expect(load.index.size).toBe(5);
    expect(load.index.get(0)).toBe(E_FREE);
    for (const [n, o] of offsets) expect([load.index.get(n), load.index.a[n]]).toEqual([E_OFFSET, o]);
    expect([...load.trailer.map.keys()]).toEqual(['Root', 'Info']);
    expect(load.declaredSize).toBe(5);
  });

  test('"1 N" off-by-one first subsection is corrected', async () => {
    const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const doc = await open(text.replace('xref\n0 5\n', 'xref\n1 5\n'));
    expect(doc.repaired).toBe(false);
    expect(doc.index.get(4)).toBe(E_OFFSET);
  });

  test('tables are streamed in bounded chunks', async () => {
    // 60k objects: the table alone is 1.2 MB.
    const objs = [...BASE_OBJECTS];
    for (let n = 5; n < 60000; n++) objs.push({ num: n, body: `${n}` });
    const { text } = miniPdf(objs, '/Root 1 0 R');
    const src = new BytesSource(text);
    const doc = await PdfDocument.open(new SourceReader(src));
    expect(doc.index.size).toBe(60000);
    expect(doc.repaired).toBe(false);
    expect(await doc.getObject(59999)).toBe(59999);
  });
});

describe('xref streams', () => {
  for (const predict of [true, false]) {
    test(`object streams and ${predict ? 'PNG-predicted' : 'plain'} xref stream`, async () => {
      const doc = await open(objStmPdf({ predict }));
      expect(doc.repaired).toBe(false);
      expect([doc.index.get(2), doc.index.a[2], doc.index.b[2]]).toEqual([E_COMPRESSED, 5, 0]);
      expect(doc.index.get(3)).toBe(E_COMPRESSED);
      const page = (await doc.getObject(3)) as PdfDict;
      expect(page.get('Type')).toEqual(new PdfName('Page'));
      const pages = (await doc.resolve(((await doc.resolve(doc.trailer.get('Root'))) as PdfDict).get('Pages'))) as PdfDict;
      expect(pages.get('Count')).toBe(1);
    });
  }

  test('hybrid file: /XRefStm fills in entries the table marks free', async () => {
    const doc = await open(objStmPdf({ hybrid: true }));
    expect(doc.repaired).toBe(false);
    expect(doc.index.get(2)).toBe(E_COMPRESSED);
    expect(doc.index.get(3)).toBe(E_COMPRESSED);
    expect(doc.index.get(4)).toBe(E_OFFSET);
  });
});

describe('incremental updates', () => {
  function updated(): { text: string; newObj4: number } {
    const objs = [...BASE_OBJECTS, { num: 5, body: '(to be deleted)' }];
    let { text } = miniPdf(objs, '/Root 1 0 R /Info 5 0 R');
    const prev = Number(/startxref\n(\d+)/.exec(text)![1]);
    const newObj4 = text.length;
    const content = '1 0 0 rg 0 0 99 99 re f';
    text += `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
    const xref = text.length;
    text += `xref\n0 1\n0000000000 65535 f\r\n4 2\n${String(newObj4).padStart(10, '0')} 00000 n\r\n0000000000 00001 f\r\n`;
    text += `trailer\n<< /Size 6 /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
    return { text, newObj4 };
  }

  test('later sections win, deletions stick, older trailer keys are kept', async () => {
    const { text, newObj4 } = updated();
    const doc = await open(text);
    expect(doc.index.a[4]).toBe(newObj4);
    expect(doc.index.get(5)).toBe(E_FREE);
    expect(doc.trailer.get('Info')).toBeDefined(); // only in the original trailer
  });

  test('a /Prev loop does not hang', async () => {
    const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    const doc = await open(text.replace('/Root 1 0 R', `/Root 1 0 R /Prev ${xref}`));
    expect(doc.repaired).toBe(false);
  });
});

describe('damaged cross-reference data', () => {
  test('a few wrong offsets are relocated by scanning, the rest of the xref is kept', async () => {
    const { text, offsets } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const bad = text.replace(String(offsets.get(3)!).padStart(10, '0'), String(offsets.get(3)! + 5).padStart(10, '0'));
    const doc = await open(bad);
    expect(doc.repaired).toBe(true);
    expect(doc.index.a[3]).toBe(offsets.get(3)!);
    expect(doc.warnings.join()).toContain('Repaired 1');
  });

  test('offsets pointing at whitespace before the object are tolerated', async () => {
    const { text, offsets } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const o = offsets.get(3)!;
    const doc = await open(text.replace(String(o).padStart(10, '0'), String(o - 1).padStart(10, '0')));
    expect(doc.repaired).toBe(false);
    expect(doc.index.a[3]).toBe(o);
  });

  test('junk before the header shifts every offset', async () => {
    const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const doc = await open('JUNKJUNK' + text);
    expect(doc.repaired).toBe(false);
    expect(await doc.getObject(2)).toBeInstanceOf(PdfDict);
  });

  test('missing startxref triggers a full rebuild, including the trailer', async () => {
    const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const doc = await open(text.replace(/startxref[\s\S]*$/, ''));
    expect(doc.repaired).toBe(true);
    expect(doc.index.get(4)).toBe(E_OFFSET);
    expect(doc.trailer.get('Root')).toBeDefined();
  });

  test('rebuild without any trailer finds the catalog', async () => {
    const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
    const doc = await open(text.slice(0, text.indexOf('xref')));
    expect(doc.repaired).toBe(true);
    expect(((await doc.resolve(doc.trailer.get('Root'))) as PdfDict).get('Type')).toEqual(new PdfName('Catalog'));
  });

  test('rebuild ignores object-like bytes inside stream data', async () => {
    const payload = 'x 99 0 obj << /Fake true >> endobj x';
    const objs = [...BASE_OBJECTS, { num: 5, body: `<< /Length ${payload.length} >>\nstream\n${payload}\nendstream` }];
    const { text } = miniPdf(objs, '/Root 1 0 R');
    const doc = await open(text.slice(0, text.indexOf('xref')));
    expect(doc.index.get(99)).toBe(0);
    expect(doc.index.get(5)).toBe(E_OFFSET);
  });

  test('rebuild picks up objects inside object streams', async () => {
    const text = objStmPdf();
    const doc = await open(text.replace(/startxref[\s\S]*$/, ''));
    expect(doc.repaired).toBe(true);
    expect(doc.index.get(3)).toBe(E_COMPRESSED);
    expect(((await doc.getObject(3)) as PdfDict).get('Type')).toEqual(new PdfName('Page'));
  });

  test('not a PDF at all', async () => {
    await expect(open('hello world, this is not a pdf')).rejects.toThrow('Not a PDF');
  });

  test('xref parsing reads a bounded amount of the file', async () => {
    const big = new Uint8Array(4 << 20);
    const payload = bin(big);
    const objs = [...BASE_OBJECTS, { num: 5, body: `<< /Length ${payload.length} >>\nstream\n${payload}\nendstream` }];
    const src = new BytesSource(latin1Bytes(miniPdf(objs, '/Root 1 0 R').text));
    await PdfDocument.open(new SourceReader(src));
    expect(src.bytesRead).toBeLessThan(1 << 20);
  });
});

describe('encrypted documents with damaged cross-references', () => {
  const encryptObjs = [...BASE_OBJECTS, { num: 5, body: '<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00112233> /U <44556677> /P -4 >>' }];

  test('a rebuilt trailer still knows the file is encrypted', async () => {
    const { text } = miniPdf(encryptObjs, '/Root 1 0 R /Encrypt 5 0 R /ID [<01><02>]');
    const doc = await open(text.slice(0, text.indexOf('xref'))); // trailer lost
    expect(doc.repaired).toBe(true);
    expect(doc.trailer.get('Encrypt')).toBeDefined();
  });

  test('an unreadable catalog in an encrypted file is not mistaken for damage', async () => {
    const { text } = miniPdf(encryptObjs, '/Root 9 0 R /Encrypt 5 0 R');
    const doc = await open(text);
    expect(doc.repaired).toBe(false);
    expect(doc.trailer.get('Encrypt')).toBeDefined();
  });
});
