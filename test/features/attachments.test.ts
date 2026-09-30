import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { deflateRawSync } from 'node:zlib';
import { PdfEncryptedError, PdfError } from '../../src/core/errors.ts';
import { openPdf } from '../../src/core/open.ts';
import { attachmentStream, listAttachments, readAttachment, type Attachment } from '../../src/features/attachments.ts';
import { getInfo } from '../../src/features/info.ts';
import { bytes as latin1, bytesEqual, damage, DocBuilder, flate } from '../support/pdfgen.ts';
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

const HELLO = latin1('hello world');
/** 3 MB that compresses somewhat: runs of random bytes. */
const BIG = (() => {
  const r = new Rng(7);
  const out = new Uint8Array(3 << 20);
  for (let i = 0; i < out.length; ) {
    const v = r.int(0, 255);
    const n = r.int(1, 40);
    out.fill(v, i, Math.min(out.length, i + n));
    i += n;
  }
  return out;
})();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') + '>';

/** Attachments of every kind: see the names. */
function attachDoc(): Uint8Array {
  const b = new DocBuilder();
  b.page({ content: '' });
  const p2 = b.alloc();
  const fs = (entries: string, stream: number) => b.obj(`<< /Type /Filespec ${entries} /EF << /F ${stream} 0 R /UF ${stream} 0 R >> >>`);
  const plain = b.stream(
    "/Type /EmbeddedFile /Subtype /text#2Fplain /Params << /Size 11 /CreationDate (D:20200102030405Z) /ModDate (D:20210102030405+01'00') >>",
    HELLO,
  );
  const fsA = fs('/F (a.txt) /UF (a.txt) /Desc (A file) /AFRelationship /Source', plain);
  const big = b.stream(`/Type /EmbeddedFile /Subtype /application#2Foctet-stream /Filter /FlateDecode /Params << /Size ${BIG.length} >>`, flate(BIG));
  const fsBig = fs('/F (big.bin) /UF <FEFF0062006900670020263A002E00620069006E>', big);
  const raw = b.stream('/Type /EmbeddedFile /Filter /Fl /DL 11', new Uint8Array(deflateRawSync(HELLO)));
  const fsRaw = fs('/F (raw.txt) /UF (raw.txt)', raw);
  const hexS = b.stream('/Type /EmbeddedFile /Filter [/ASCIIHexDecode /FlateDecode]', latin1(hex(flate(HELLO))));
  const fsHex = fs('/F (hex.txt) /UF (hex.txt)', hexS);
  const corrupt = b.stream(`/Type /EmbeddedFile /Filter /FlateDecode /Params << /Size ${BIG.length} >>`, flate(BIG).subarray(0, 50000));
  const fsCorrupt = fs('/F (corrupt.bin) /UF (corrupt.bin)', corrupt);
  const external = b.obj('<< /Type /Filespec /F (external.pdf) >>');
  const leaf1 = b.obj(`<< /Limits [(a.txt) (big.bin)] /Names [(a.txt) ${fsA} 0 R (big.bin) ${fsBig} 0 R] >>`);
  const leaf2 = b.obj(
    `<< /Limits [(corrupt) (raw)] /Names [(corrupt) ${fsCorrupt} 0 R (dup) ${fsA} 0 R (ext) ${external} 0 R <FEFF0068006500780020263A> ${fsHex} 0 R (raw) ${fsRaw} 0 R] >>`,
  );
  const tree = b.obj(`<< /Kids [${leaf1} 0 R ${leaf2} 0 R] >>`);
  // A FileAttachment annotation on page 2, and another one sharing a.txt's file.
  const note = b.stream('/Type /EmbeddedFile /Filter /FlateDecode', flate(latin1('annotated')));
  const annot = b.obj(`<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 20 20] /Contents (See this) /FS ${b.obj(`<< /Type /Filespec /F (note.txt) /EF << /F ${note} 0 R >> >>`)} 0 R >>`);
  const annot2 = b.obj(`<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 20 20] /FS ${fsA} 0 R >>`);
  b.setObj(p2, b.pageDict({ content: '', extra: ` /Annots [${annot} 0 R ${annot2} 0 R 999 0 R]` }, b.stream('', new Uint8Array(0))));
  b.pages.push(p2);
  b.catalogExtra = ` /Names << /EmbeddedFiles ${tree} 0 R >>`;
  return b.finish().build().bytes;
}

const strip = (a: Attachment) => {
  const { handle: _, ...rest } = a;
  return rest;
};

describe('listAttachments', () => {
  test('name tree with Kids and annotations; dedupe; external files left out', async () => {
    const list = await listAttachments(await open(attachDoc()));
    expect(list.map(strip)).toEqual([
      {
        name: 'a.txt', filename: 'a.txt', description: 'A file', size: 11, mimeType: 'text/plain', relationship: 'Source',
        created: new Date('2020-01-02T03:04:05Z'), modified: new Date('2021-01-02T02:04:05Z'),
      },
      { name: 'big.bin', filename: 'big ☺.bin', size: BIG.length, mimeType: 'application/octet-stream' },
      { name: 'corrupt', filename: 'corrupt.bin', size: BIG.length },
      { name: 'hex ☺', filename: 'hex.txt' },
      { name: 'raw', filename: 'raw.txt', size: 11 },
      { name: 'note.txt', filename: 'note.txt', description: 'See this', pageIndex: 1 },
    ]);
    expect((await getInfo(await open(attachDoc()))).attachments).toBe(7);
  });

  test('contents: uncompressed, zlib, raw deflate, filter chains', async () => {
    const doc = await open(attachDoc());
    const list = await listAttachments(doc);
    const byName = new Map(list.map((a) => [a.name, a]));
    expect(await readAttachment(doc, byName.get('a.txt')!)).toEqual(HELLO);
    expect(bytesEqual(await readAttachment(doc, byName.get('big.bin')!.handle), BIG)).toBe(true);
    expect(await readAttachment(doc, byName.get('raw')!)).toEqual(HELLO);
    expect(await readAttachment(doc, byName.get('hex ☺')!)).toEqual(HELLO);
    expect(await readAttachment(doc, byName.get('note.txt')!)).toEqual(latin1('annotated'));
  });

  test('corrupt data with a declared size is an error', async () => {
    const doc = await open(attachDoc());
    const corrupt = (await listAttachments(doc)).find((a) => a.name === 'corrupt')!;
    expect(readAttachment(doc, corrupt)).rejects.toBeInstanceOf(PdfError);
    expect(readAttachment(doc, { stream: 1 })).rejects.toBeInstanceOf(PdfError);
  });

  test('streams from the source as the consumer pulls', async () => {
    const r = new Rng(3);
    const data = r.bytes(6 << 20); // incompressible: the Flate data is as large
    const b = new DocBuilder();
    b.page({ content: '' });
    const s = b.stream(`/Type /EmbeddedFile /Filter /FlateDecode /Params << /Size ${data.length} >>`, flate(data, 1));
    b.catalogExtra = ` /Names << /EmbeddedFiles << /Names [(x) ${b.obj(`<< /F (x) /EF << /F ${s} 0 R >> >>`)} 0 R] >> >>`;
    const src = new BytesSource(b.finish().build().bytes);
    const doc = await openPdf(src);
    const [att] = await listAttachments(doc);
    const before = src.bytesRead;
    const reader = attachmentStream(doc, att).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(src.bytesRead - before).toBeLessThan(1 << 20);
    const parts = [first.value!];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(parts.length).toBeGreaterThan(10);
    expect(bytesEqual(Buffer.concat(parts), data)).toBe(true);
    // Cancelling part way stops reading.
    const r2 = attachmentStream(doc, att).getReader();
    await r2.read();
    const mark = src.bytesRead;
    await r2.cancel();
    expect(src.bytesRead - mark).toBeLessThan(1 << 20);
  });

  test('agrees with mupdf', async () => {
    const bytes = attachDoc();
    const doc = await open(bytes);
    const ours = new Map((await listAttachments(doc)).map((a) => [a.name, a]));
    const m = mu(bytes);
    const theirs = m.getEmbeddedFiles();
    for (const [name, fs] of Object.entries(theirs)) {
      const a = ours.get(name);
      if (name === 'ext' || name === 'dup') {
        expect(a).toBeUndefined();
        continue;
      }
      expect(a).toBeDefined();
      const p = m.getFilespecParams(fs);
      expect(p.filename).toBe(a!.filename);
      expect(p.mimetype).toBe(a!.mimeType ?? 'application/octet-stream'); // mupdf's default
      if (a!.created) expect(p.creationDate.getTime()).toBe(a!.created.getTime());
      // mupdf gives nothing for raw deflate data (no zlib header); we decode it.
      if (name === 'corrupt' || name === 'raw') continue;
      const c = m.getEmbeddedFileContents(fs);
      const mine = await readAttachment(doc, a!);
      const their = new Uint8Array(c!.asUint8Array());
      expect(bytesEqual(their, mine)).toBe(true);
    }
    expect(Object.keys(theirs).length).toBe(7);
    m.destroy();
  });

  test('attachments written by mupdf, with object streams and a damaged xref', async () => {
    const d = new mupdf.PDFDocument();
    d.insertPage(-1, d.addPage([0, 0, 100, 100], 0, d.newDictionary(), ''));
    const files: [string, Uint8Array][] = [['one.txt', HELLO], ['two.bin', BIG.subarray(0, 100000)], ['ünï.txt', latin1('x')]];
    for (const [n, c] of files) d.insertEmbeddedFile(n, d.addEmbeddedFile(n, 'application/x-test', c, new Date('2020-01-01T00:00:00Z'), new Date('2021-06-01T12:00:00Z'), false));
    const bytes = new Uint8Array(d.saveToBuffer('compress').asUint8Array());
    d.destroy();
    const variants = [bytes, damage.startxref(bytes, 1)];
    if (hasQpdf) variants.push(qpdfTransform(bytes, ['--object-streams=generate']));
    for (const v of variants) {
      const doc = await open(v);
      const list = await listAttachments(doc);
      expect(list.map((a) => [a.name, a.filename, a.mimeType, a.size, a.created?.toISOString(), a.modified?.toISOString()])).toEqual(
        files.map(([n, c]) => [n, n, 'application/x-test', c.length, '2020-01-01T00:00:00.000Z', '2021-06-01T12:00:00.000Z']),
      );
      for (let i = 0; i < files.length; i++) expect(bytesEqual(await readAttachment(doc, list[i]), files[i][1])).toBe(true);
    }
  });

  test('damaged copies settle with a result or an Error', async () => {
    const n = await survives(attachDoc(), 4, async (doc) => {
      for (const a of await listAttachments(doc)) await readAttachment(doc, a).catch((e) => expect(e).toBeInstanceOf(Error));
    });
    expect(n).toBeGreaterThan(20);
  });

  test('encrypted documents are rejected', async () => {
    if (!hasQpdf) return;
    const plain = await open(attachDoc());
    const [a] = await listAttachments(plain);
    const enc = await open(qpdfTransform(attachDoc(), ['--encrypt', '', 'o', '256', '--']));
    expect(listAttachments(enc)).rejects.toBeInstanceOf(PdfEncryptedError);
    expect(readAttachment(enc, a)).rejects.toBeInstanceOf(PdfEncryptedError);
  });
});
