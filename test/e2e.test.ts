/**
 * End-to-end tests over the generated corpus (test/corpus). For each fixture: compress with the
 * sharp codec through both the Blob and the Node file I/O, then check the report, qpdf's opinion
 * of the output, rendering (mupdf), object-level byte identity, idempotence and determinism.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SharpImageCodec } from '../src/codecs/sharp.ts';
import { compressPdf } from '../src/core/compress.ts';
import { PdfEncryptedError } from '../src/core/errors.ts';
import { nameOf, PdfRef } from '../src/core/objects.ts';
import type { CompressOptions, CompressReport } from '../src/core/types.ts';
import { BlobPartsSink, BlobSource } from '../src/io/blob.ts';
import { compressPdfFile } from '../src/io/node.ts';
import { availableFixtures, fixtureBytes, fixtures, type Fixture } from './corpus/index.ts';
import { inspect, type ObjInfo, type Structure } from './support/inspect.ts';
import { bytesEqual, text } from './support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfShowXref, severity } from './support/qpdf.ts';
import { meanAbsError, renderPdf, sameRaster, ssim } from './support/render.ts';

const OUT_DIR = join(import.meta.dir, '.out', 'e2e');
const codec = new SharpImageCodec();
const RENDER_PAGES = 4;
const T = 120_000;

/** Pages with recompressed images must look like the original at this level. */
const MIN_SSIM = 0.94;
const MAX_MAE = 4;

if (!hasQpdf) console.warn(QPDF_MISSING);
const skipped = fixtures.filter((f) => f.needsQpdf && !hasQpdf);
if (skipped.length) console.warn(`skipping fixtures that need qpdf to generate: ${skipped.map((f) => f.name).join(', ')}`);

async function viaBlob(input: Uint8Array, opts: Partial<CompressOptions> = {}): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const sink = new BlobPartsSink();
  const report = await compressPdf(new BlobSource(new Blob([input as Uint8Array<ArrayBuffer>])), sink, { codec, ...opts });
  return { bytes: new Uint8Array(await sink.blob.arrayBuffer()), report };
}

async function viaFile(name: string, input: Uint8Array, opts: Partial<CompressOptions> = {}): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const dir = join(OUT_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const inPath = join(dir, 'in.pdf');
  const outPath = join(dir, 'out.pdf');
  writeFileSync(inPath, input);
  const report = await compressPdfFile(inPath, outPath, { codec, ...opts });
  return { bytes: new Uint8Array(readFileSync(outPath)), report };
}

interface Run {
  input: Uint8Array;
  output: Uint8Array;
  report: CompressReport;
}

const runs = new Map<string, Promise<Run>>();
function run(f: Fixture): Promise<Run> {
  let p = runs.get(f.name);
  if (!p) {
    p = (async () => {
      const input = await fixtureBytes(f);
      const { bytes, report } = await viaBlob(input, f.options);
      return { input, output: bytes, report };
    })();
    runs.set(f.name, p);
  }
  return p;
}

const structures = new Map<Uint8Array, Promise<Structure>>();
const structure = (b: Uint8Array): Promise<Structure> => {
  let s = structures.get(b);
  if (!s) structures.set(b, (s = inspect(b)));
  return s;
};

const KNOWN_BUGS: Record<string, { idempotence?: string }> = {};

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

/** Size of the final cross-reference section (from its start to EOF). */
const xrefOverhead = (s: Structure, b: Uint8Array): number => b.length - s.startxref;

/** Old xref streams and a first-object linearization dictionary are dropped by design. */
function isDroppable(o: ObjInfo, first: boolean): boolean {
  if (!o.dict) return false;
  if (o.stream && nameOf(o.dict.get('Type')) === 'XRef') return true;
  return first && !o.stream && o.dict.get('Linearized') !== undefined;
}

describe('corpus generation', () => {
  test('is deterministic', async () => {
    const f = fixtures.find((x) => x.name === 'incremental-delete')!;
    const a = await f.build();
    const b = await f.build();
    expect(bytesEqual(a, b)).toBe(true);
    expect(bytesEqual(a, await fixtureBytes(f))).toBe(true);
  }, T);

  test.skipIf(!hasQpdf)('clean fixtures pass qpdf --check', async () => {
    for (const f of availableFixtures()) {
      if (f.expect.damaged || f.expect.encrypted) continue;
      const r = qpdfCheck(await fixtureBytes(f));
      expect({ name: f.name, code: r.code, output: r.code ? r.output : '' }).toEqual({ name: f.name, code: 0, output: '' });
    }
  }, T);
});

for (const f of availableFixtures()) {
  describe(f.name, () => {
    if (f.expect.encrypted) {
      test('is refused with PdfEncryptedError (Blob I/O)', async () => {
        const input = await fixtureBytes(f);
        const sink = new BlobPartsSink();
        const p = compressPdf(new BlobSource(new Blob([input as Uint8Array<ArrayBuffer>])), sink, { codec });
        await expect(p).rejects.toBeInstanceOf(PdfEncryptedError);
        expect(() => sink.blob).toThrow();
      }, T);

      test('is refused with PdfEncryptedError (Node file I/O), leaving no output', async () => {
        const input = await fixtureBytes(f);
        const dir = join(OUT_DIR, f.name);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'in.pdf'), input);
        const e = await compressPdfFile(join(dir, 'in.pdf'), join(dir, 'out.pdf'), { codec }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(PdfEncryptedError);
        expect(existsSync(join(dir, 'out.pdf'))).toBe(false);
        expect(readdirSync(dir)).toEqual(['in.pdf']);
      }, T);
      return;
    }

    test('report matches the fixture', async () => {
      const { input, output, report } = await run(f);
      const e = f.expect;
      expect(report.inputBytes).toBe(input.length);
      expect(report.outputBytes).toBe(output.length);
      expect(report.imagesRecompressed).toBe(e.recompressed);
      expect(report.imagesSkipped).toEqual(e.skipped ?? {});
      expect(report.imagesSeen).toBe(e.recompressed + sum(e.skipped ?? {}));
      expect(report.signaturesInvalidated).toBe(e.signed ?? false);
      if (e.signed) expect(report.warnings.some((w) => /sign/i.test(w))).toBe(true);
      if (e.repaired !== undefined) expect(report.xrefRepaired).toBe(e.repaired);
      expect(text(output, 0, 5)).toBe('%PDF-');
      expect(text(output, output.length - 6)).toBe('%%EOF\n');
      if (e.recompressed > 0) expect(output.length).toBeLessThan(input.length);
    }, T);

    test('when nothing is recompressed the output grows by at most the new xref', async () => {
      const { input, output, report } = await run(f);
      if (report.imagesRecompressed > 0) return;
      const s = await structure(output);
      expect(output.length).toBeLessThanOrEqual(input.length + xrefOverhead(s, output) + 64);
    }, T);

    test.skipIf(!hasQpdf)('qpdf --check: output is clean (or no worse than a damaged input)', async () => {
      const { input, output } = await run(f);
      const out = qpdfCheck(output);
      if (!f.expect.damaged) {
        expect(out.code === 0 ? '' : out.output).toBe('');
        return;
      }
      const inp = qpdfCheck(input);
      if (severity(out.code) > severity(inp.code)) {
        throw new Error(`qpdf is less happy with the output (${out.code}) than the input (${inp.code}):\n${out.output}`);
      }
    }, T);

    test('renders like the input', async () => {
      const { input, output, report } = await run(f);
      const a = renderPdf(f.renderReference ? await f.renderReference() : input, RENDER_PAGES);
      const b = renderPdf(output, RENDER_PAGES);
      expect(b.pageCount).toBe(a.pageCount);
      const statics = new Set(f.expect.staticPages ?? []);
      for (let i = 0; i < a.pages.length; i++) {
        const pa = a.pages[i];
        const pb = b.pages[i];
        if (!pa) {
          // mupdf could not render the damaged input page; the output must not be worse.
          continue;
        }
        expect(pb).not.toBeNull();
        if (!pb) continue;
        expect([pb.width, pb.height]).toEqual([pa.width, pa.height]);
        if (sameRaster(pa, pb)) continue;
        const metrics = { page: i, ssim: ssim(pa, pb), mae: meanAbsError(pa, pb) };
        // A page may only change when an image on it was recompressed.
        expect({ page: i, static: statics.has(i), changedWithoutRecompression: report.imagesRecompressed === 0 }).toEqual({
          page: i,
          static: false,
          changedWithoutRecompression: false,
        });
        expect(metrics.ssim).toBeGreaterThanOrEqual(MIN_SSIM);
        expect(metrics.mae).toBeLessThanOrEqual(MAX_MAE);
      }
    }, T);

    test('objects that were not rewritten are byte-identical', async () => {
      const { input, output, report } = await run(f);
      const si = await structure(input);
      const so = await structure(output);
      const firstIn = [...si.uncompressed.values()].sort((x, y) => x.offset - y.offset)[0]?.num;
      let dropped = 0;
      let rewritten = 0;
      for (const [num, o] of si.uncompressed) {
        const n = so.uncompressed.get(num);
        if (isDroppable(o, num === firstIn)) {
          dropped++;
          expect({ num, inOutput: n !== undefined || so.compressed.has(num) }).toEqual({ num, inOutput: false });
          continue;
        }
        expect({ num, present: n !== undefined }).toEqual({ num, present: true });
        if (!n) continue;
        expect(n.gen).toBe(o.gen);
        if (bytesEqual(o.bytes, n.bytes)) continue;
        // Objects that lacked `endobj` get one appended; anything else must be a recompressed image.
        const withEndobj = new Uint8Array([...o.bytes, ...Buffer.from('\nendobj')]);
        if (bytesEqual(withEndobj, n.bytes)) continue;
        if (!o.dict || o.value === undefined) {
          // Unparseable in the source: copied verbatim up to the next object.
          expect(text(n.bytes).startsWith(text(o.bytes).trimEnd())).toBe(true);
          continue;
        }
        rewritten++;
        await checkRewrittenImage(num, o, n);
      }
      expect(rewritten).toBe(report.imagesRecompressed);
      expect(dropped).toBe(f.expect.dropped ?? 0);
      // Object-stream members keep their entries (the streams are copied verbatim).
      for (const [num, [stm, idx]] of si.compressed) {
        if (!si.uncompressed.has(stm)) continue;
        expect({ num, entry: so.compressed.get(num) }).toEqual({ num, entry: [stm, idx] });
      }
      // Nothing new appears.
      for (const [num, o] of so.uncompressed) {
        if (o.stream && nameOf(o.dict?.get('Type')) === 'XRef' && o.offset === so.startxref) continue; // the new xref stream
        expect({ num, known: si.uncompressed.has(num) }).toEqual({ num, known: true });
      }
      for (const num of so.compressed.keys()) expect({ num, known: si.compressed.has(num) }).toEqual({ num, known: true });
    }, T);

    test.skipIf(!hasQpdf)('the written xref agrees with qpdf --show-xref', async () => {
      const { input, output } = await run(f);
      const so = await structure(output);
      const q = qpdfShowXref(output);
      expect(q.code).toBe(0);
      for (const [num, o] of so.uncompressed) expect({ num, e: q.entries.get(num) }).toEqual({ num, e: { type: 'uncompressed', offset: o.offset, gen: o.gen } });
      for (const [num, [stream, index]] of so.compressed) expect({ num, e: q.entries.get(num) }).toEqual({ num, e: { type: 'compressed', stream, index } });
      expect(q.entries.size).toBe(so.uncompressed.size + so.compressed.size);
      if (!f.expect.damaged) {
        // And the project's reader agrees with qpdf about the (undamaged) input.
        const si = await structure(input);
        const qi = qpdfShowXref(input);
        // qpdf shows offsets as written; the project's reader rebases them on the %PDF- header.
        const header = text(input, 0, 1024).indexOf('%PDF-');
        for (const [num, o] of si.uncompressed) {
          expect({ num, e: qi.entries.get(num) }).toEqual({ num, e: { type: 'uncompressed', offset: o.offset - header, gen: o.gen } });
        }
        for (const [num, [stream, index]] of si.compressed) expect({ num, e: qi.entries.get(num) }).toEqual({ num, e: { type: 'compressed', stream, index } });
      }
    }, T);

    const idemBug = KNOWN_BUGS[f.name]?.idempotence;
    (idemBug ? test.failing : test)(`is idempotent: compressing the output again changes nothing but the xref${idemBug ? ` [KNOWN SRC BUG: ${idemBug}]` : ''}`, async () => {
      const { output } = await run(f);
      const again = await viaBlob(output, f.options);
      expect(again.report.imagesRecompressed).toBe(0);
      expect(again.report.xrefRepaired).toBe(false);
      const s1 = await structure(output);
      const s2 = await structure(again.bytes);
      // Everything before the cross-reference section is byte-identical.
      expect(s2.startxref).toBeGreaterThan(0);
      const body1 = output.subarray(0, s1.startxref);
      const body2 = again.bytes.subarray(0, s2.startxref);
      expect(body2.length).toBe(body1.length);
      expect(bytesEqual(body1, body2)).toBe(true);
      // With a classic table even the xref comes out the same.
      if (text(output, s1.startxref, s1.startxref + 4) === 'xref') expect(bytesEqual(again.bytes, output)).toBe(true);
      expect(again.bytes.length).toBeLessThanOrEqual(output.length + 64);
    }, T);

    test('is deterministic across I/O adapters (Node files vs Blobs)', async () => {
      const { input, output, report } = await run(f);
      const viaNode = await viaFile(f.name, input, f.options);
      expect(bytesEqual(viaNode.bytes, output)).toBe(true);
      expect(viaNode.report).toEqual(report);
    }, T);
  });
}

describe('concurrency', () => {
  for (const name of ['brochure-photos', 'png-filters']) {
    test(`${name}: concurrency 4 gives the same bytes as concurrency 1`, async () => {
      const f = fixtures.find((x) => x.name === name)!;
      const { input, output, report } = await run(f);
      const par = await viaBlob(input, { ...f.options, concurrency: 4 });
      expect(bytesEqual(par.bytes, output)).toBe(true);
      expect(par.report).toEqual(report);
    }, T);
  }
});

/** A recompressed image: same keys except the encoding ones, valid JPEG matching its dictionary. */
async function checkRewrittenImage(num: number, o: ObjInfo, n: ObjInfo): Promise<void> {
  const di = o.dict!;
  const dn = n.dict!;
  const ctx = { num };
  expect({ ...ctx, subtype: nameOf(di.get('Subtype')) }).toEqual({ ...ctx, subtype: 'Image' });
  if (nameOf(dn.get('Filter')) === 'FlateDecode') return checkShrunkMask(num, o, n);
  expect({ ...ctx, filter: nameOf(dn.get('Filter')) }).toEqual({ ...ctx, filter: 'DCTDecode' });
  expect(n.data).toBeDefined();
  expect(o.data).toBeDefined();
  expect(n.data!.length).toBeLessThan(o.data!.length);
  const meta = await sharp(n.data!).metadata();
  expect({ ...ctx, format: meta.format, w: meta.width, h: meta.height }).toEqual({ ...ctx, format: 'jpeg', w: dn.get('Width') as number, h: dn.get('Height') as number });
  // Encoding keys change; everything else is carried over verbatim.
  const encoding = new Set(['Width', 'Height', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Decode', 'DL', 'Length', 'ColorSpace']);
  for (const [k, raw] of di.raw) {
    if (encoding.has(k)) continue;
    expect({ ...ctx, k, raw: text(dn.raw.get(k) ?? new Uint8Array()) }).toEqual({ ...ctx, k, raw: text(raw) });
  }
  // Colour: ICCBased is kept when the component count is unchanged; gray stays gray.
  const csIn = di.get('ColorSpace');
  const csOut = dn.get('ColorSpace');
  const channels = meta.channels;
  if (Array.isArray(csIn) && nameOf(csIn[0]) === 'ICCBased') {
    expect(text(dn.raw.get('ColorSpace')!)).toBe(text(di.raw.get('ColorSpace')!));
  } else {
    const gray = nameOf(csIn) === 'DeviceGray' || nameOf(csIn) === 'G';
    expect({ ...ctx, cs: nameOf(csOut), channels }).toEqual({ ...ctx, cs: gray ? 'DeviceGray' : 'DeviceRGB', channels: gray ? 1 : 3 });
  }
  expect(dn.get('Decode')).toBeUndefined();
  expect(dn.get('DecodeParms')).toBeUndefined();
  const sm = di.get('SMask');
  if (sm instanceof PdfRef) expect(dn.get('SMask')).toEqual(sm);
}

/** A shrunk soft mask: still gray and lossless (Flate + PNG predictor), inside the box, same aspect. */
function checkShrunkMask(num: number, o: ObjInfo, n: ObjInfo): void {
  const di = o.dict!;
  const dn = n.dict!;
  const ctx = { num };
  const [w, h, ow, oh] = [di.get('Width'), di.get('Height'), dn.get('Width'), dn.get('Height')] as number[];
  expect({ ...ctx, cs: nameOf(dn.get('ColorSpace')), bpc: dn.get('BitsPerComponent') }).toEqual({ ...ctx, cs: 'DeviceGray', bpc: 8 });
  expect(text(dn.raw.get('DecodeParms')!)).toBe(`<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${ow} >>`);
  expect(ow <= 1600 && oh <= 1600 && ow <= w && oh <= h).toBe(true);
  expect(Math.abs(ow / oh - w / h)).toBeLessThan(0.01);
  expect(n.data!.length).toBeLessThan(o.data!.length);
  const encoding = new Set(['Width', 'Height', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Decode', 'DL', 'Length']);
  for (const [k, raw] of di.raw) {
    if (encoding.has(k)) continue;
    expect({ ...ctx, k, raw: text(dn.raw.get(k) ?? new Uint8Array()) }).toEqual({ ...ctx, k, raw: text(raw) });
  }
}
