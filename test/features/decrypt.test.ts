import { afterAll, describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { SharpImageCodec } from '../../src/codecs/sharp.ts';
import { compressPdf } from '../../src/core/compress.ts';
import { PdfDocument } from '../../src/core/document.ts';
import { PdfEncryptedError, PdfFormatError } from '../../src/core/errors.ts';
import type { PdfDict } from '../../src/core/objects.ts';
import { SourceReader } from '../../src/core/reader.ts';
import { rewritePdf } from '../../src/core/rewrite.ts';
import type { RandomAccessSource } from '../../src/core/types.ts';
import { AESV2, authenticate, RC4 } from '../../src/features/crypto-handler.ts';
import { md5 } from '../../src/features/crypto-md5.ts';
import { rc4 } from '../../src/features/crypto-rc4.ts';
import {
  checkPassword, decrypt, decryptPdf, isEncrypted, openEncryptedPdf, PdfPasswordError,
} from '../../src/features/decrypt.ts';
import {
  bytes, bytesEqual, DocBuilder, drawImage, drawText, find, flate, imageDict, paragraph, text, vectorArt,
} from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfCheck, qpdfTransform } from '../support/qpdf.ts';
import { sameRaster, type Raster } from '../support/render.ts';
import { BASE_OBJECTS, BytesSink, BytesSource, miniPdf } from '../unit/util.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

const TMP = mkdtempSync(join(tmpdir(), 'leanpdf-decrypt-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let seq = 0;

/** Run qpdf on `data` (written to a temp file, appended as the last argument). */
function qpdfOn(data: Uint8Array, args: string[]): { code: number; out: string; stdout: string } {
  const p = join(TMP, `${seq++}.pdf`);
  writeFileSync(p, data);
  try {
    const r = spawnSync('qpdf', [...args, p], { encoding: 'utf8', maxBuffer: 256 << 20 });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
  } finally {
    rmSync(p, { force: true });
  }
}

// biome-ignore lint: qpdf JSON is untyped
type Json = Record<string, any>;

/** qpdf's JSON view of all objects (strings and stream data decrypted when `password` is given). */
function qpdfObjects(data: Uint8Array, password?: string): Json {
  const pw = password === undefined ? [] : [`--password=${password}`];
  const r = qpdfOn(data, ['--json=2', '--json-key=qpdf', '--json-stream-data=inline', '--decode-level=none', ...pw]);
  if (r.code !== 0 && r.code !== 3) throw new Error(`qpdf --json failed: ${r.out}`);
  return JSON.parse(r.stdout).qpdf[1];
}

/** The Info dictionary from qpdf JSON, with indirect values resolved. */
function infoOf(objs: Json): Json {
  const info = objs[`obj:${objs.trailer.value['/Info']}`].value as Json;
  return Object.fromEntries(Object.entries(info).map(([k, v]) => [k, typeof v === 'string' && / R$/.test(v) ? objs[`obj:${v}`].value : v]));
}

/** Render every page with mupdf, authenticating `password` if the document needs one. */
function render(data: Uint8Array, password = ''): Raster[] {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    if (doc.needsPassword() && !doc.authenticatePassword(password)) throw new Error('mupdf rejected the password');
    const pages: Raster[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const width = pix.getWidth();
      const height = pix.getHeight();
      const stride = pix.getStride();
      const px = pix.getPixels();
      const rgb = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y++) rgb.set(px.subarray(y * stride, y * stride + width * 3), y * width * 3);
      pages.push({ width, height, rgb });
      pix.destroy();
      page.destroy();
    }
    return pages;
  } finally {
    doc.destroy();
    mupdf.setLog(null);
  }
}

function expectSameRendering(a: Raster[], b: Raster[]): void {
  expect(a.length).toBe(b.length);
  expect(a.length).toBeGreaterThan(0);
  for (let i = 0; i < a.length; i++) expect(sameRaster(a[i], b[i])).toBe(true);
}

async function run(input: Uint8Array, password?: string) {
  const sink = new BytesSink();
  const report = await decryptPdf(new BytesSource(input), sink, { password });
  return { report, out: sink.bytes() };
}

const reopen = (b: Uint8Array) => PdfDocument.open(new SourceReader(new BytesSource(b)));
const hex = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------------------------
// Fixture: two pages with Flate content, a large Flate image (several read chunks), a JPEG,
// annotations, outline titles, an embedded file, XMP metadata, a signature and Info strings.

const ATTACHMENT = 'An attached text file, line after line.\n'.repeat(40);
const XMP =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Decryption test</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const SIG_CONTENTS = '3082000a06092a864886f70d01070200000000000000000000';

function gradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.set([(x * 255) / w, (y * 255) / h, ((x + y) * 127) / (w + h)], (y * w + x) * 3);
  }
  return px;
}

async function sourcePdf(): Promise<Uint8Array> {
  const rng = new Rng(20240901);
  const b = new DocBuilder();
  const N = 330; // 330x330 RGB noise: > 256 KiB of Flate data, decrypted in several chunks
  const im1 = b.stream(imageDict({ width: N, height: N, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), flate(rng.bytes(N * N * 3), 1));
  const jpeg = await sharp(gradient(200, 150), { raw: { width: 200, height: 150, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  const im2 = b.stream(imageDict({ width: 200, height: 150, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), new Uint8Array(jpeg));
  const freeText = b.obj(
    '<< /Type /Annot /Subtype /FreeText /Rect [72 690 520 740] /Contents (Free text: \\(parens\\) and \\\\ backslash) ' +
      '/DA (/Helv 14 Tf 0 0 1 rg) /T (Annotator) /M (D:20240102030405Z) /NM (ft-1) >>',
  );
  const link = b.obj('<< /Type /Annot /Subtype /Link /Rect [72 640 300 660] /Border [0 0 0] /A << /S /URI /URI (https://example.com/\\(q\\)?x=1) >> >>');
  const note = b.obj('<< /Type /Annot /Subtype /Text /Rect [500 780 520 800] /Contents <FEFF004E006F00740065002000E9> /T (Reviewer) /Open false >>');
  const p1 = b.page({
    content: drawText('Encrypted page one', 72, 780, 24) + vectorArt(72, 420, 450, 180) + drawImage('Im1', 72, 80, 300, 300),
    xobjects: { Im1: im1 },
    extra: ` /Annots [${freeText} 0 R ${link} 0 R ${note} 0 R]`,
  });
  const sig = b.obj(
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <${SIG_CONTENTS}> ` +
      '/M (D:20240101000000Z) /Name (Test Signer) /Reason (Testing decryption) >>',
  );
  const sigField = b.obj(`<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /V ${sig} 0 R >>`);
  const p2 = b.page({
    content: drawText('Page two', 72, 780, 24) + drawImage('Im2', 72, 400, 400, 300) + paragraph(72, 350, 8),
    xobjects: { Im2: im2 },
    extra: ` /Annots [${sigField} 0 R]`,
  });
  const sum = createHash('md5').update(ATTACHMENT).digest('hex');
  const att = b.stream(
    `/Type /EmbeddedFile /Subtype /text#2Fplain /Filter /FlateDecode /Params << /Size ${ATTACHMENT.length} /ModDate (D:20240101000000Z) /CheckSum <${sum}> >>`,
    flate(bytes(ATTACHMENT)),
  );
  const fs = b.obj(`<< /Type /Filespec /F (attachment.txt) /UF <FEFF00E4002E007400780074> /Desc (An attached \\(text\\) file) /EF << /F ${att} 0 R >> >>`);
  const meta = b.stream('/Type /Metadata /Subtype /XML', bytes(XMP));
  const outlines = b.alloc();
  const o1 = b.alloc();
  const o2 = b.alloc();
  b.setObj(outlines, `<< /Type /Outlines /First ${o1} 0 R /Last ${o2} 0 R /Count 2 >>`);
  b.setObj(o1, `<< /Title (Chapter \\(one\\)) /Parent ${outlines} 0 R /Next ${o2} 0 R /Dest [${p1} 0 R /Fit] >>`);
  b.setObj(o2, `<< /Title <FEFF00C700E0> /Parent ${outlines} 0 R /Prev ${o1} 0 R /Dest [${p2} 0 R /Fit] >>`);
  const creator = b.obj('(leanpdf \\(tests\\))');
  const arr = b.obj('[(first) <7365636f6e64> 3.25 /Name (third)]');
  const info = b.obj(
    `<< /Title (Decryption \\(test\\) \\\\ one) /Author <FEFF005A006F00EB> /Subject (Caf\\351 cr\\350me) /Keywords (rc4, aes) ` +
      `/Creator ${creator} 0 R /CreationDate (D:20240102030405+01'00') >>`,
  );
  b.trailer('Info', `${info} 0 R`);
  b.catalogExtra =
    ` /Names << /EmbeddedFiles << /Names [(attachment.txt) ${fs} 0 R] >> >> /Metadata ${meta} 0 R` +
    ` /AcroForm << /Fields [${sigField} 0 R] /SigFlags 3 >> /Outlines ${outlines} 0 R /TestArray ${arr} 0 R`;
  b.finish('decrypt-test');
  return b.build().bytes;
}

const SOURCE = await sourcePdf();

interface Case {
  name: string;
  /** qpdf key length and options. */
  args: string[];
  user: string;
  owner: string;
  method: string;
  objStm: boolean;
  clearMeta?: boolean;
}

const CASES: Case[] = [
  { name: 'RC4 40-bit (R2)', args: ['40'], user: 'user', owner: 'owner', method: 'RC4 40-bit (R2)', objStm: false },
  { name: 'RC4 128-bit (R3), empty user password, object streams', args: ['128'], user: '', owner: 'owner', method: 'RC4 128-bit (R3)', objStm: true },
  { name: 'RC4 128-bit (R3), non-ASCII password', args: ['128'], user: 'mötley', owner: 'owner', method: 'RC4 128-bit (R3)', objStm: false },
  { name: 'RC4 crypt filters (V4 R4)', args: ['128', '--force-V4'], user: 'user', owner: 'owner', method: 'RC4 128-bit (R4)', objStm: false },
  {
    name: 'AES-128 (R4), cleartext metadata, object streams',
    args: ['128', '--use-aes=y', '--cleartext-metadata'],
    user: 'user',
    owner: 'owner',
    method: 'AES-128 (R4)',
    objStm: true,
    clearMeta: true,
  },
  { name: 'AES-256 (R5)', args: ['256', '--force-R5'], user: 'user', owner: 'owner', method: 'AES-256 (R5)', objStm: false },
  { name: 'AES-256 (R6), object streams, non-ASCII password', args: ['256'], user: 'pässwörd', owner: 'owner', method: 'AES-256 (R6)', objStm: true },
  {
    name: 'AES-256 (R6), owner password only, cleartext metadata',
    args: ['256', '--cleartext-metadata'],
    user: '',
    owner: 'owner',
    method: 'AES-256 (R6)',
    objStm: false,
    clearMeta: true,
  },
];

const encryptWith = (c: Case): Uint8Array =>
  qpdfTransform(SOURCE, [
    '--allow-weak-crypto', '--encrypt', c.user, c.owner, ...c.args, '--', `--object-streams=${c.objStm ? 'generate' : 'disable'}`,
  ]);

// ---------------------------------------------------------------------------------------------
// Primitives

describe('crypto primitives', () => {
  test('md5 matches node:crypto', () => {
    const rng = new Rng(7);
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const d = rng.bytes(n);
      expect(hex(md5(d))).toBe(createHash('md5').update(d).digest('hex'));
    }
  });

  test('rc4 matches the reference vectors and continues across chunks', () => {
    expect(hex(rc4(bytes('Key'))(bytes('Plaintext')))).toBe('bbf316e8d940af0ad3');
    expect(hex(rc4(bytes('Secret'))(bytes('Attack at dawn')))).toBe('45a01f645fc35b383552544b9bf5');
    const data = new Rng(3).bytes(1000);
    const whole = rc4(bytes('k3y'))(data);
    const f = rc4(bytes('k3y'));
    const parts = [f(data.subarray(0, 1)), f(data.subarray(1, 300)), f(data.subarray(300))];
    expect(bytesEqual(Buffer.concat(parts), whole)).toBe(true);
    expect(hex(data.subarray(0, 4))).toBe(hex(new Rng(3).bytes(4))); // input untouched
  });
});

// ---------------------------------------------------------------------------------------------
// qpdf-encrypted documents

describe.skipIf(!hasQpdf)('qpdf-encrypted documents', () => {
  const plainObjects = hasQpdf ? qpdfObjects(SOURCE) : {};

  for (const c of CASES) {
    describe(c.name, () => {
      const enc = hasQpdf ? encryptWith(c) : new Uint8Array(0);
      const decrypted = hasQpdf ? run(enc, c.user) : Promise.reject(new Error('no qpdf'));
      decrypted.catch(() => {});

      test('the fixture is what we asked qpdf for', () => {
        const r = qpdfOn(enc, ['--show-encryption', `--password=${c.owner}`]);
        expect(r.out).toContain('Supplied password is owner password');
        expect(qpdfOn(enc, ['--check', `--password=${c.user}`]).code).toBe(0);
      });

      test('decrypts with the user password into a valid, unencrypted file', async () => {
        const { report, out } = await decrypted;
        expect(report.encrypted).toBe(true);
        expect(report.method).toBe(c.method);
        expect(report.password).toBe('user');
        expect(qpdfCheck(out).code).toBe(0);
        expect(qpdfOn(out, ['--show-encryption']).out).toContain('File is not encrypted');
        const doc = await reopen(out);
        expect(isEncrypted(doc)).toBe(false);
        expect(doc.trailer.get('ID')).toBeDefined();
        expect(text(out)).not.toContain('/Encrypt');
      });

      test('renders exactly like the encrypted original', async () => {
        const { out } = await decrypted;
        expectSameRendering(render(out), render(enc, c.user));
      });

      test("every object equals qpdf's decrypted view", async () => {
        const { out } = await decrypted;
        const ref = qpdfObjects(enc, c.user);
        const got = qpdfObjects(out);
        const encRef = ref.trailer.value['/Encrypt'];
        let compared = 0;
        for (const [k, v] of Object.entries(ref)) {
          if (k === 'trailer' || k === `obj:${encRef}` || v?.stream?.dict?.['/Type'] === '/XRef') continue;
          expect([k, got[k]]).toEqual([k, v]);
          compared++;
        }
        expect(compared).toBeGreaterThan(20);
        expect(got.trailer.value['/ID']).toEqual(ref.trailer.value['/ID']);
      });

      test("Info strings equal qpdf --decrypt's and the source's", async () => {
        const { out } = await decrypted;
        const reference = qpdfObjects(qpdfTransform(enc, ['--decrypt', `--password=${c.user}`]));
        const info = infoOf(qpdfObjects(out));
        expect(info).toEqual(infoOf(reference));
        expect(info).toEqual(infoOf(plainObjects));
        expect(info['/Title']).toBe('u:Decryption (test) \\ one');
        expect(info['/Author']).toBe('u:Zoë');
        expect(info['/Subject']).toBe('u:Café crème');
      });

      test('keeps the signature /Contents and metadata as the source has them', async () => {
        const { out } = await decrypted;
        const got = qpdfObjects(out);
        const sig = Object.values(got).find((o: Json) => o?.value?.['/Type'] === '/Sig') as Json;
        expect(sig.value['/Contents']).toBe(`b:${SIG_CONTENTS}`);
        expect(sig.value['/Name']).toBe('u:Test Signer');
        const meta = Object.values(got).find((o: Json) => o?.stream?.dict?.['/Type'] === '/Metadata') as Json;
        const metaRaw = new Uint8Array(Buffer.from(meta.stream.data, 'base64'));
        const flated = meta.stream.dict['/Filter'] === '/FlateDecode';
        expect(Buffer.from(flated ? inflateSync(metaRaw) : metaRaw).toString('latin1')).toBe(XMP);
        // Cleartext metadata was left alone: the same bytes are in the encrypted file.
        expect(find(enc, metaRaw) > 0).toBe(!!c.clearMeta);
        const file = Object.values(got).find((o: Json) => o?.stream?.dict?.['/Type'] === '/EmbeddedFile') as Json;
        expect(bytesEqual(new Uint8Array(Buffer.from(file.stream.data, 'base64')), flate(bytes(ATTACHMENT)))).toBe(true);
      });

      test('the owner password, or parallel tasks, give the same output', async () => {
        const { out } = await decrypted;
        const r = await run(enc, c.owner);
        expect(r.report.password).toBe('owner');
        expect(bytesEqual(r.out, out)).toBe(true);
        const sink = new BytesSink();
        await decryptPdf(new BytesSource(enc), sink, { password: c.user, concurrency: 4 });
        expect(bytesEqual(sink.bytes(), out)).toBe(true);
      });

      test('a wrong password is refused with PdfPasswordError', async () => {
        const sink = new BytesSink();
        await expect(decryptPdf(new BytesSource(enc), sink, { password: 'wrong' })).rejects.toBeInstanceOf(PdfPasswordError);
        if (c.user !== '') await expect(run(enc)).rejects.toBeInstanceOf(PdfPasswordError);
      });

      test('checkPassword tells user and owner passwords apart', async () => {
        const doc = await openEncryptedPdf(new Blob([enc as Uint8Array<ArrayBuffer>]), { password: c.user });
        expect(isEncrypted(doc)).toBe(true);
        expect(await checkPassword(doc, c.user)).toBe('user');
        expect(await checkPassword(doc, c.owner)).toBe('owner');
        expect(await checkPassword(doc, 'nope')).toBe(null);
      });
    });
  }

  test('the plugin works directly in rewritePdf, and chained compression works on the output', async () => {
    const c = CASES.find((x) => x.method === 'AES-256 (R6)' && x.user === '')!;
    const enc = encryptWith(c);
    const sink = new BytesSink();
    const plugin = decrypt();
    const report = await rewritePdf(new BytesSource(enc), sink, [plugin]);
    expect(plugin.report).toEqual({ encrypted: true, method: 'AES-256 (R6)', password: 'user' });
    expect(report.signaturesInvalidated).toBe(true);
    const out = sink.bytes();
    expect(qpdfCheck(out).code).toBe(0);

    // compressPdf refuses the encrypted file but works on the decrypted one.
    const codec = new SharpImageCodec();
    await expect(compressPdf(new BytesSource(enc), new BytesSink(), { codec })).rejects.toBeInstanceOf(PdfEncryptedError);
    const small = new BytesSink();
    const r = await compressPdf(new BytesSource(out), small, { codec, minImageBytes: 1000 });
    expect(r.imagesRecompressed).toBeGreaterThanOrEqual(1);
    const compressed = small.bytes();
    expect(compressed.length).toBeLessThan(out.length);
    expect(qpdfCheck(compressed).code).toBe(0);
    expect(render(compressed).length).toBe(2);
  });

  test('a multi-megabyte stream is read, decrypted and written in bounded chunks', async () => {
    // ~6 MiB of incompressible image data (stored Flate), so the stream is as big as the file.
    const W = 1450;
    const data = flate(new Rng(99).bytes(W * W * 3), 0);
    const b = new DocBuilder();
    const im = b.stream(imageDict({ width: W, height: W, colorSpace: '/DeviceRGB', filter: '/FlateDecode' }), data);
    b.page({ content: drawImage('I', 0, 0, 595, 595), xobjects: { I: im } });
    b.finish('big');
    const plain = b.build().bytes;

    /** Tracks the largest read, and how many large reads (not header windows) hit [from, to). */
    class CountingSource extends BytesSource {
      maxRead = 0;
      dataReads = 0;
      from = 0;
      to = 0;
      override async read(offset: number, length: number): Promise<Uint8Array> {
        this.maxRead = Math.max(this.maxRead, length);
        if (length > 1 << 16 && offset < this.to && offset + length > this.from) this.dataReads++;
        return super.read(offset, length);
      }
    }
    /** Tracks the largest chunk, and how much of the stream was read when its data began to arrive. */
    class ChunkSink extends BytesSink {
      maxChunk = 0;
      readAtFirstData = -1;
      readonly source: CountingSource;
      constructor(source: CountingSource) {
        super();
        this.source = source;
      }
      override async write(chunk: Uint8Array): Promise<void> {
        this.maxChunk = Math.max(this.maxChunk, chunk.length);
        // The writer batches small writes into 64 KiB; bigger chunks are stream data passed through.
        if (chunk.length > 1 << 16 && this.readAtFirstData < 0) this.readAtFirstData = this.source.dataReads;
        this.chunks.push(chunk);
      }
      override async copyRange(src: RandomAccessSource, offset: number, length: number): Promise<void> {
        for (let p = offset; p < offset + length; p += 1 << 16) this.chunks.push(await src.read(p, Math.min(1 << 16, offset + length - p)));
      }
    }
    const findImage = async (bytes: Uint8Array) => {
      const doc = await reopen(bytes);
      const spans = [];
      for (const num of doc.index.sortedOffsets()) {
        const hdr = (await doc.header(num))!;
        if (hdr.stream && (hdr.value as PdfDict).get('Width') === W) spans.push(await doc.span(hdr, bytes.length));
      }
      expect(spans.length).toBe(1);
      return spans[0];
    };
    const CHUNK = 256 << 10;
    for (const [bits, aes, method] of [['256', 'y', 'AES-256 (R6)'], ['128', 'y', 'AES-128 (R4)'], ['128', 'n', 'RC4 128-bit (R3)']]) {
      const enc = qpdfTransform(plain, ['--allow-weak-crypto', '--encrypt', '', 'o', bits, ...(bits === '128' ? [`--use-aes=${aes}`] : []), '--']);
      const source = new CountingSource(enc);
      const encSpan = await findImage(enc);
      source.from = encSpan.dataStart;
      source.to = encSpan.dataEnd;
      const sink = new ChunkSink(source);
      const report = await decryptPdf(source, sink);
      expect(report.method).toBe(method);
      // Bounded reads and writes, and the data is written while it is being read: when its first
      // chunk reached the sink, only one chunk of it had been read (of about 24).
      expect(source.maxRead).toBeLessThanOrEqual(CHUNK);
      expect(sink.maxChunk).toBeLessThanOrEqual(CHUNK);
      expect(sink.readAtFirstData).toBe(1);
      expect(source.dataReads).toBeGreaterThanOrEqual(Math.floor((encSpan.dataEnd - encSpan.dataStart) / CHUNK));
      // The image data comes out exactly as it went in.
      const out = sink.bytes();
      const span = await findImage(out);
      expect(bytesEqual(out.subarray(span.dataStart, span.dataEnd), data)).toBe(true);
      expect(qpdfCheck(out).code).toBe(0);
    }
  });

  test('incremental updates made by mupdf to an encrypted file are decrypted too', async () => {
    const c = CASES.find((x) => x.method === 'AES-128 (R4)')!;
    mupdf.setLog({ error: () => {}, warning: () => {} });
    const doc = mupdf.Document.openDocument(encryptWith(c), 'application/pdf') as mupdf.PDFDocument;
    expect(doc.authenticatePassword(c.user)).toBeGreaterThan(0);
    doc.setMetaData('info:Title', 'New tïtle (updated)');
    const page = doc.loadPage(1) as mupdf.PDFPage;
    const note = page.createAnnotation('FreeText');
    note.setContents('Added after encryption');
    note.setRect([72, 72, 400, 120]);
    note.update();
    const updated = doc.saveToBuffer('incremental').asUint8Array().slice();
    page.destroy();
    doc.destroy();
    mupdf.setLog(null);
    expect(text(updated).split('%%EOF').length).toBe(3);

    const { out } = await run(updated, c.user);
    expect(qpdfCheck(out).code).toBe(0);
    expectSameRendering(render(out), render(updated, c.user));
    const got = qpdfObjects(out);
    expect(infoOf(got)['/Title']).toBe('u:New tïtle (updated)');
    expect(Object.values(got).some((o: Json) => o?.value?.['/Contents'] === 'u:Added after encryption')).toBe(true);
  });

  test('a file cut before its xref decrypts with its recovered /Encrypt (R6); R3 fails clearly without /ID', async () => {
    const cut = (b: Uint8Array): Uint8Array => b.slice(0, text(b).lastIndexOf('\nxref') + 1);
    const r6 = CASES.find((x) => x.method === 'AES-256 (R6)' && !x.objStm)!;
    const enc6 = encryptWith(r6);
    const { report, out } = await run(cut(enc6), r6.user);
    expect(report).toMatchObject({ encrypted: true, xrefRepaired: true, method: 'AES-256 (R6)' });
    expect(qpdfCheck(out).code).toBe(0);
    expectSameRendering(render(out), render(enc6, r6.user));
    const r3 = CASES.find((x) => x.method === 'RC4 128-bit (R3)' && !x.objStm)!;
    const e = await run(cut(encryptWith(r3)), r3.user).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PdfFormatError);
    expect((e as Error).message).toContain('/ID is needed');
  });

  test('AES decryptors give the same result for any chunking, and strip only valid padding', async () => {
    const c = CASES.find((x) => x.method === 'AES-128 (R4)')!;
    const enc = encryptWith(c);
    const key = Buffer.from(/Encryption key = ([0-9a-f]+)/.exec(qpdfOn(enc, ['--show-encryption', '--show-encryption-key', `--password=${c.user}`]).out)![1], 'hex');
    const doc = await openEncryptedPdf(new BytesSource(enc), { password: c.user });
    const sec = (await authenticate(doc, c.user))!;
    const num = 12;
    const gen = 0;
    const objKey = createHash('md5').update(Buffer.concat([key, Buffer.from([num, 0, 0, gen, 0]), Buffer.from('sAlT')])).digest();
    const rng = new Rng(11);
    const aes = (data: Uint8Array, pad: boolean): Uint8Array => {
      const iv = rng.bytes(16);
      const ci = createCipheriv('aes-128-cbc', objKey, iv).setAutoPadding(pad);
      return new Uint8Array(Buffer.concat([iv, ci.update(data), ci.final()]));
    };
    const decryptChunks = async (data: Uint8Array, sizes: number[]): Promise<Uint8Array> => {
      const d = sec.decryptor(AESV2, num, gen);
      const out: Uint8Array[] = [];
      let at = 0;
      for (let i = 0; at < data.length; i++) {
        const n = sizes[i % sizes.length];
        out.push(await d(data.subarray(at, at + n), at + n >= data.length));
        at += n;
      }
      if (!data.length) out.push(await d(data, true));
      return new Uint8Array(Buffer.concat(out));
    };
    for (const n of [0, 1, 15, 16, 17, 100, 4096, 70_000]) {
      const plain = rng.bytes(n);
      const ct = aes(plain, true);
      for (const sizes of [[ct.length], [1], [7, 9], [16], [17, 15, 32], [1000, 3]]) {
        // Byte-sized chunks are covered up to 4 KB; on 70 KB they'd only cost seconds.
        if (n > 4096 && sizes[0] < 16) continue;
        expect(hex(await decryptChunks(ct, sizes))).toBe(hex(plain));
      }
    }
    // No padding: 32 bytes whose last byte is not a valid pad are kept whole.
    const raw = rng.bytes(32);
    raw[31] = 200;
    expect(hex(await decryptChunks(aes(raw, false), [5]))).toBe(hex(raw));
    raw.set([7, 3, 3], 29); // looks like padding of 3, but isn't
    expect(hex(await decryptChunks(aes(raw, false), [48]))).toBe(hex(raw));
    raw.set([3, 3, 3], 29); // is padding of 3
    expect(hex(await decryptChunks(aes(raw, false), [48]))).toBe(hex(raw.subarray(0, 29)));
    // Too short to hold an IV, or only an IV: nothing.
    expect((await decryptChunks(rng.bytes(10), [3])).length).toBe(0);
    expect((await decryptChunks(rng.bytes(16), [16])).length).toBe(0);
    // RC4 decryptors are fresh per call.
    const r1 = sec.decryptor(RC4, 5, 0);
    const r2 = sec.decryptor(RC4, 5, 0);
    expect(hex(await r1(bytes('abc'), true))).toBe(hex(await r2(bytes('abc'), true)));
  });
});

// ---------------------------------------------------------------------------------------------
// Hand-made: the catalog inside an encrypted object stream, crypt filters (StrF and EFF
// /Identity, a /Crypt stream filter), an indirect /Length. Encrypted with node:crypto.

/** Build the document; with `enc`, add /Encrypt and RC4-encrypt the stream data (V4, StdCF). */
function handmade(enc?: { o: string; u: string; p: number; key: Buffer; cf?: string }): { bytes: Uint8Array; compressedCatalog: boolean } {
  const b = new DocBuilder();
  const img = b.stream(
    imageDict({
      width: 64,
      height: 64,
      colorSpace: '/DeviceRGB',
      filter: '[/Crypt /FlateDecode]',
      decodeParms: '[<< /Type /CryptFilterDecodeParms /Name /Identity >> null]',
    }),
    flate(gradient(64, 64)),
  );
  const att = b.stream(`/Type /EmbeddedFile /Filter /FlateDecode /Params << /Size ${ATTACHMENT.length} >>`, flate(bytes(ATTACHMENT)));
  const fs = b.obj(`<< /Type /Filespec /F (a.txt) /EF << /F ${att} 0 R >> >>`);
  b.page(
    { content: drawText('Hand-made encryption', 72, 780, 24) + drawImage('Im1', 72, 400, 256, 256) + vectorArt(72, 100, 400, 200), xobjects: { Im1: img } },
    { length: 'indirect' },
  );
  const info = b.obj('<< /Title (Plain strings \\(StrF Identity\\)) >>');
  b.trailer('Info', `${info} 0 R`);
  b.catalogExtra = ` /Names << /EmbeddedFiles << /Names [(a.txt) ${fs} 0 R] >> >>`;
  if (enc) {
    const e = b.obj(
      `<< /Filter /Standard /V 4 /R 4 /Length 128 /P ${enc.p} /O <${enc.o}> /U <${enc.u}> ` +
        `/CF << /StdCF << /CFM /V2 ${enc.cf ?? '/Length 16'} /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /Identity /EFF /Identity >>`,
      { compressible: false },
    );
    b.trailer('Encrypt', `${e} 0 R`);
  }
  b.finish('handmade');
  const built = b.build({ xref: 'stream', objStm: true });
  const out = built.bytes.slice();
  if (enc) {
    for (const [num, o] of built.objects) {
      const s = text(out, o.offset, o.end);
      const at = s.indexOf('stream\n');
      if (at < 0 || /\/Type \/XRef|\/Crypt|\/EmbeddedFile/.test(s.slice(0, at))) continue;
      const start = o.offset + at + 7;
      const end = o.offset + s.lastIndexOf('\nendstream');
      const k = createHash('md5')
        .update(Buffer.concat([enc.key, Buffer.from([num, num >> 8, num >> 16, o.gen, o.gen >> 8])]))
        .digest()
        .subarray(0, Math.min(enc.key.length + 5, 16));
      out.set(createCipheriv('rc4', k, null).update(out.subarray(start, end)), start);
    }
  }
  return { bytes: out, compressedCatalog: built.compressed.has(b.catalog) };
}

describe.skipIf(!hasQpdf)('catalog in an encrypted object stream, with crypt filters', () => {
  // Borrow /O, /U and /P from qpdf for the same first /ID string and an empty user password.
  const seed = new DocBuilder();
  seed.page({ content: drawText('seed', 10, 10) });
  seed.finish('handmade');
  const seedEnc = hasQpdf ? qpdfTransform(seed.build().bytes, ['--allow-weak-crypto', '--encrypt', '', 'secret', '128', '--force-V4', '--']) : new Uint8Array(0);
  const params = () => {
    const j = qpdfObjects(seedEnc, '');
    const e = j[`obj:${j.trailer.value['/Encrypt']}`].value;
    const key = /Encryption key = ([0-9a-f]+)/.exec(qpdfOn(seedEnc, ['--show-encryption', '--show-encryption-key']).out)![1];
    return { o: e['/O'].slice(2), u: e['/U'].slice(2), p: e['/P'] as number, key: Buffer.from(key, 'hex') };
  };

  test('decrypts, drops the /Crypt filter and keeps identity-filtered data', async () => {
    const plain = handmade();
    const enc = handmade(params());
    expect(enc.compressedCatalog).toBe(true);
    // The fixture is sound: qpdf and mupdf read it.
    expect(qpdfCheck(enc.bytes).code).toBe(0);
    expectSameRendering(render(enc.bytes), render(plain.bytes));

    const { report, out } = await run(enc.bytes);
    expect(report).toMatchObject({ encrypted: true, method: 'RC4 128-bit (R4)', password: 'user' });
    expect(qpdfCheck(out).code).toBe(0);
    expectSameRendering(render(out), render(plain.bytes));
    const s = text(out);
    expect(s).not.toContain('/Crypt');
    expect(s).not.toContain('/Encrypt');
    const got = qpdfObjects(out);
    expect(infoOf(got)['/Title']).toBe('u:Plain strings (StrF Identity)');
    const file = Object.values(got).find((o: Json) => o?.stream?.dict?.['/Type'] === '/EmbeddedFile') as Json;
    expect(bytesEqual(new Uint8Array(Buffer.from(file.stream.data, 'base64')), flate(bytes(ATTACHMENT)))).toBe(true);
    const image = Object.values(got).find((o: Json) => o?.stream?.dict?.['/Subtype'] === '/Image') as Json;
    expect(image.stream.dict['/Filter']).toEqual(['/FlateDecode']);
    expect(image.stream.dict['/DecodeParms']).toBeUndefined();

    // Same through the plugin, on the source or on a document from openEncryptedPdf.
    const doc = await openEncryptedPdf(new BytesSource(enc.bytes));
    for (const input of [doc, new BytesSource(enc.bytes)]) {
      const sink = new BytesSink();
      await rewritePdf(input, sink, [decrypt()]);
      expect(bytesEqual(sink.bytes(), out)).toBe(true);
    }
    await expect(openEncryptedPdf(new BytesSource(enc.bytes), { password: 'x' })).rejects.toBeInstanceOf(PdfPasswordError);
    expect(await checkPassword(doc, 'secret')).toBe('owner');
  });
});

/** /O, /U and the file key for R4 RC4 with an empty user password (Algorithms 2, 3 and 5), key of `n` bytes. */
function r4Params(n: number, owner: string, p: number, id: Buffer) {
  const PAD32 = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
  const pad = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD32]).subarray(0, 32);
  const md = (b: Buffer) => createHash('md5').update(b).digest();
  const rc = (k: Buffer, b: Buffer) => createCipheriv('rc4', k, null).update(b);
  const xor = (k: Buffer, i: number) => Buffer.from(k.map((b) => b ^ i));
  let h = md(pad(owner));
  for (let i = 0; i < 50; i++) h = md(h.subarray(0, n));
  let o = rc(h.subarray(0, n), pad(''));
  for (let i = 1; i <= 19; i++) o = rc(xor(h.subarray(0, n), i), o);
  const pb = Buffer.alloc(4);
  pb.writeInt32LE(p);
  let k = md(Buffer.concat([pad(''), o, pb, id]));
  for (let i = 0; i < 50; i++) k = md(k.subarray(0, n));
  const key = k.subarray(0, n);
  let u = rc(key, md(Buffer.concat([PAD32, id])));
  for (let i = 1; i <= 19; i++) u = rc(xor(key, i), u);
  return { o: o.toString('hex'), u: Buffer.concat([u, Buffer.alloc(16)]).toString('hex'), p, key };
}

test('V4 with an RC4 key length given in bytes in the crypt filter (/Length 5: 40 bits)', async () => {
  const id = Buffer.from('handmade'.padEnd(16, '.'), 'latin1');
  const enc = handmade({ ...r4Params(5, 'owner', -4, id), cf: '/Length 5' });
  const { report, out } = await run(enc.bytes);
  expect(report).toMatchObject({ encrypted: true, method: 'RC4 40-bit (R4)', password: 'user' });
  expectSameRendering(render(out), render(handmade().bytes));
});

// ---------------------------------------------------------------------------------------------
// Unencrypted, unsupported and malformed input

describe('unencrypted, unsupported and malformed input', () => {
  const withEncrypt = (encrypt: string, extra: { num: number; body: string }[] = []): Uint8Array =>
    bytes(miniPdf([...BASE_OBJECTS, ...extra], `/Root 1 0 R /Encrypt ${encrypt} /ID [<0102> <0102>]`).text);
  const O = `<${'ab'.repeat(32)}>`;

  test('unencrypted input is copied as is', async () => {
    const src = bytes(miniPdf(BASE_OBJECTS, '/Root 1 0 R').text);
    const { report, out } = await run(src);
    expect(report.encrypted).toBe(false);
    expect(text(out)).toContain('0 0 1 rg 0 0 50 50 re f');
    if (hasQpdf) expect(qpdfCheck(out).code).toBe(0);
    await expect(checkPassword(await reopen(src), '')).rejects.toBeInstanceOf(PdfFormatError);
  });

  test('public-key security handlers are unsupported', async () => {
    const src = withEncrypt('<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /R 4 /Recipients [<00>] >>');
    const e = await run(src).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PdfEncryptedError);
    expect((e as Error).message).toContain('/Adobe.PubSec');
  });

  test('unsupported versions and malformed dictionaries give clear errors', async () => {
    const cases: [string, typeof PdfFormatError | typeof PdfEncryptedError, string][] = [
      [`<< /Filter /Standard /V 3 /R 3 /O ${O} /U ${O} /P -4 >>`, PdfEncryptedError, '/V 3'],
      [`<< /Filter /Standard /V 2 /R 7 /O ${O} /U ${O} /P -4 >>`, PdfEncryptedError, '/R 7'],
      ['<< /Filter /Standard /V 2 /R 3 /O <abcd> /U <abcd> /P -4 >>', PdfFormatError, '/O or /U'],
      [`<< /Filter /Standard /V 2 /R 3 /O ${O} /U ${O} >>`, PdfFormatError, '/P'],
      [`<< /Filter /Standard /V 2 /R 3 /Length 12345 /O ${O} /U ${O} /P -4 >>`, PdfFormatError, 'key length'],
      [`<< /Filter /Standard /V 4 /R 4 /O ${O} /U ${O} /P -4 /StmF /Nope >>`, PdfFormatError, '/Nope'],
      [`<< /Filter /Standard /V 4 /R 4 /O ${O} /U ${O} /P -4 /CF << /X << /CFM /Magic >> >> /StmF /X >>`, PdfEncryptedError, 'crypt filter'],
      ['99 0 R', PdfFormatError, 'not a dictionary'],
      ['(nonsense)', PdfFormatError, 'not a dictionary'],
    ];
    for (const [enc, type, msg] of cases) {
      const e = await run(withEncrypt(enc)).catch((x: unknown) => x);
      expect([enc, e instanceof type]).toEqual([enc, true]);
      expect((e as Error).message).toContain(msg);
    }
  });

  test('a well-formed dictionary with the wrong password data is a password error', async () => {
    const e = await run(withEncrypt(`<< /Filter /Standard /V 2 /R 3 /Length 128 /O ${O} /U ${O} /P -4 >>`)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PdfPasswordError);
  });
});
