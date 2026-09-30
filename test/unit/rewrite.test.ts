import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { PdfDocument } from '../../src/core/document.ts';
import { PdfDict, PdfName, PdfRef } from '../../src/core/objects.ts';
import { SourceReader } from '../../src/core/reader.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { E_COMPRESSED, E_FREE, E_OFFSET } from '../../src/core/xref.ts';
import { BASE_OBJECTS, BytesSink, BytesSource, latin1Bytes, miniPdf } from './util.ts';

const open = (b: Uint8Array | string) => PdfDocument.open(new SourceReader(new BytesSource(b)));

async function run(input: string | Uint8Array, plugins: Plugin[]) {
  const sink = new BytesSink();
  const report = await rewritePdf(new BytesSource(input), sink, plugins);
  const out = sink.bytes();
  return { report, out, text: Buffer.from(out).toString('latin1'), doc: await open(out) };
}

/** Catalog and pages in an object stream (objects 2, 3), content stream 4, info 6. */
function objStmDoc(): string {
  const members = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>'];
  const head = `2 0 3 ${members[0].length + 1} `;
  const body = head + members.join(' ');
  let text = '%PDF-1.5\n';
  const off: number[] = [];
  const add = (n: number, s: string) => {
    off[n] = text.length;
    text += `${n} 0 obj\n${s}\nendobj\n`;
  };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(4, '<< /Length 23 >>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream');
  add(5, `<< /Type /ObjStm /N 2 /First ${head.length} /Length ${body.length} >>\nstream\n${body}\nendstream`);
  add(6, '<< /Title (Old) /Producer (x) >>');
  const rows = [[0, 0, 255], [1, off[1], 0], [2, 5, 0], [2, 5, 1], [1, off[4], 0], [1, off[5], 0], [1, off[6], 0], [1, text.length, 0]];
  const data = Buffer.from(Uint8Array.from(rows.flatMap(([t, a, b]) => [t, (a >> 8) & 255, a & 255, b]))).toString('latin1');
  text += `7 0 obj\n<< /Type /XRef /Size 8 /W [1 2 1] /Root 1 0 R /Info 6 0 R /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${off[7] ?? text.length - 0}\n%%EOF\n`;
  return text.replace(/startxref\n\d+/, `startxref\n${text.indexOf('7 0 obj')}`);
}

describe('rewrite engine edits', () => {
  test('setEntry on an uncompressed dict, a stream (data kept) and an object inside an object stream', async () => {
    const { text, doc } = await run(latin1Bytes(objStmDoc()), [
      {
        prepare(ctx) {
          ctx.setEntry(1, 'Lang', new PdfName('nl'));
          ctx.setEntry(4, 'Extra', 42);
          ctx.setEntry(3, 'Rotate', 90);
          ctx.setEntry(3, 'MediaBox', [0, 0, 300, 300]);
        },
      },
    ]);
    expect(doc.repaired).toBe(false);
    expect(((await doc.getObject(1)) as PdfDict).get('Lang')).toEqual(new PdfName('nl'));
    const content = (await doc.header(4))!;
    expect((content.value as PdfDict).get('Extra')).toBe(42);
    expect(text).toContain('/Extra 42\n>>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream');
    // Page 3 was compressed; it's now an uncompressed object that wins over the stale copy.
    expect(doc.index.get(3)).toBe(E_OFFSET);
    const page = (await doc.getObject(3)) as PdfDict;
    expect([page.get('Rotate'), page.get('MediaBox'), page.get('Parent')]).toEqual([90, [0, 0, 300, 300], new PdfRef(2, 0)]);
    expect(doc.index.get(2)).toBe(E_COMPRESSED); // untouched member keeps its compressed entry
  });

  test('addObject, setObject, setTrailer and setKeep', async () => {
    const { doc, text } = await run(latin1Bytes(objStmDoc()), [
      {
        prepare(ctx) {
          const info = ctx.addObject(new PdfDict());
          ctx.setObject(info.num, dictOf({ Producer: new PdfName('leanpdf') }));
          ctx.setTrailer('Info', info);
        },
        finalize(ctx) {
          ctx.setKeep((n) => n !== 6); // old Info object goes
        },
      },
    ]);
    expect(doc.index.get(6)).toBe(E_FREE);
    const infoRef = doc.trailer.get('Info') as PdfRef;
    expect(infoRef.num).toBeGreaterThanOrEqual(8);
    expect(((await doc.getObject(infoRef.num)) as PdfDict).get('Producer')).toEqual(new PdfName('leanpdf'));
    expect(text).not.toContain('(Old)');
  });

  test('getObject sees earlier edits; transform receives the edited dictionary', async () => {
    let seen: unknown;
    let viaCtx: unknown;
    await run(miniPdf(BASE_OBJECTS, '/Root 1 0 R').text, [
      { prepare: (ctx) => ctx.setEntry(4, 'Tag', new PdfName('A')) },
      {
        async finalize(ctx) {
          viaCtx = ((await ctx.getObject(4)) as PdfDict).get('Tag');
        },
        transform(num, hdr) {
          if (num === 4) seen = (hdr.value as PdfDict).get('Tag');
          return undefined;
        },
      },
    ]);
    expect(viaCtx).toEqual(new PdfName('A'));
    expect(seen).toEqual(new PdfName('A'));
  });

  test('a task that keeps the object still writes the edits', async () => {
    const data = deflateSync(Buffer.alloc(5000, 7));
    const objs = [...BASE_OBJECTS, { num: 5, body: `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${Buffer.from(data).toString('latin1')}\nendstream` }];
    const { doc } = await run(miniPdf(objs, '/Root 1 0 R').text, [
      { prepare: (ctx) => ctx.setEntry(5, 'Note', 1) },
      { transform: (num) => (num === 5 ? { task: Promise.resolve(null) } : undefined) },
    ]);
    const hdr = (await doc.header(5))!;
    expect((hdr.value as PdfDict).get('Note')).toBe(1);
    expect((await doc.streamData(hdr, 1 << 20))!.length).toBe(5000);
  });

  test('an unedited document comes out with the same objects', async () => {
    const src = miniPdf(BASE_OBJECTS, '/Root 1 0 R').text;
    const { text } = await run(src, []);
    for (const o of BASE_OBJECTS) expect(text).toContain(`${o.num} 0 obj\n${o.body}\nendobj\n`);
  });
});

function dictOf(entries: Record<string, PdfName | number>): PdfDict {
  const d = new PdfDict();
  for (const [k, v] of Object.entries(entries)) d.set(k, v, new Uint8Array());
  return d;
}
