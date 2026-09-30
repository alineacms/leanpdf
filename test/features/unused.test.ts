import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { reachable } from '../../src/core/gc.ts';
import { nameOf, PdfDict, PdfRef } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { repairPdf, repairStreams } from '../../src/features/repair.ts';
import { removeUnused } from '../../src/features/unused.ts';
import { fixture, fixtureBytes } from '../corpus/index.ts';
import { bytes, DocBuilder, drawText, text } from '../support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfShowXref } from '../support/qpdf.ts';
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

function expectSameRendering(a: Uint8Array, b: Uint8Array): void {
  const x = renderPdf(a, 8);
  const y = renderPdf(b, 8);
  expect(y.pageCount).toBe(x.pageCount);
  x.pages.forEach((p, i) => expect(sameRaster(p!, y.pages[i]!)).toBe(true));
}

/** The file's bytes plus the inflated data of every stream. */
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

/**
 * Two pages, an /Info dictionary, and orphans: an uncompressed stream, a plain object, a chain
 * of objects referring to each other, and (with object streams) orphan members packed together
 * with live ones.
 */
function orphans(objStm: boolean) {
  const b = new DocBuilder();
  const n: Record<string, number> = {};
  b.page({ content: drawText('One', 40, 780, 20) });
  b.page({ content: drawText('Two', 40, 780, 20) });
  n.info = b.obj('<< /Title (Kept title) >>');
  n.orphanStream = b.stream('', bytes('ORPHAN-STREAM '.repeat(20)));
  n.orphan = b.obj('<< /Secret (ORPHAN-PLAIN) >>');
  n.cycleA = b.alloc();
  n.cycleB = b.obj(`<< /Back ${n.cycleA} 0 R /Secret (ORPHAN-CYCLE) >>`);
  b.setObj(n.cycleA, `<< /Next ${n.cycleB} 0 R >>`);
  b.finish('orphans');
  b.trailer('Info', `${n.info} 0 R`);
  const built = b.build(objStm ? { xref: 'stream', objStm: true, version: '1.5' } : {});
  return { bytes: built.bytes, n, built };
}

describe('removeUnused', () => {
  for (const objStm of [false, true]) {
    test(`drops unreferenced objects${objStm ? ' (object streams)' : ''}`, async () => {
      const { bytes: input, n } = orphans(objStm);
      expect(everything(input)).toContain('ORPHAN-PLAIN');
      const { out } = await run(input, [removeUnused()]);
      expectValid(out);
      expectSameRendering(input, out);
      const all = everything(out);
      for (const s of ['ORPHAN-STREAM', 'ORPHAN-PLAIN', 'ORPHAN-CYCLE']) expect(all).not.toContain(s);
      expect(all).toContain('Kept title');
      const doc = await open(out);
      for (const k of ['orphanStream', 'orphan', 'cycleA', 'cycleB']) expect(await doc.getObject(n[k])).toBeUndefined();
      expect(await doc.getObject(n.info)).toBeInstanceOf(PdfDict);
      expect(out.length).toBeLessThan(input.length);
    });
  }

  test('object streams keep their live members in place and lose the others', async () => {
    const { bytes: input, n, built } = orphans(true);
    const { out } = await run(input, [removeUnused()]);
    if (!hasQpdf) return;
    const xref = qpdfShowXref(out).entries;
    const [stm] = built.compressed.get(n.info)!;
    // Live members are still compressed at the same slots; the orphans have no entry.
    for (const [num, [s, i]] of built.compressed) {
      if ([n.orphan, n.cycleA, n.cycleB].includes(num)) expect(xref.get(num)).toBeUndefined();
      else expect(xref.get(num)).toEqual({ type: 'compressed', stream: s, index: i });
    }
    expect(xref.get(stm)?.type).toBe('uncompressed');
  });

  test('an object stream with no live member goes entirely', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('One', 40, 780) });
    b.finish('dead-stm');
    b.update();
    const dead = b.obj('<< /Dead (DEAD-1) >>');
    b.obj('<< /Dead (DEAD-2) >>');
    const built = b.build({ xref: ['table', 'stream'], objStm: [false, true], version: '1.5' });
    const [stm] = built.compressed.get(dead)!;
    expect(await (await open(built.bytes)).getObject(stm)).toBeDefined();
    const { out } = await run(built.bytes, [removeUnused()]);
    expectValid(out);
    expect(await (await open(out)).getObject(stm)).toBeUndefined();
    expect(everything(out)).not.toContain('DEAD-');
  });

  test('members superseded by an incremental update do not linger', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('One', 40, 780) });
    const info = b.obj('<< /Title (OLD-TITLE) >>');
    b.obj('<< /Unrelated true >>');
    b.trailer('Info', `${info} 0 R`);
    b.finish('superseded');
    b.update();
    b.setObj(info, '<< /Title (NEW-TITLE) >>');
    const input = b.build({ xref: ['stream', 'table'], objStm: [true, false], version: '1.5' }).bytes;
    expect(everything(input)).toContain('OLD-TITLE');
    const { out } = await run(input, [removeUnused()]);
    expectValid(out);
    expect(everything(out)).not.toContain('OLD-TITLE');
    expect(everything(out)).toContain('NEW-TITLE');
  });

  test('sees the edits of plugins listed after it', async () => {
    const { bytes: input, n } = orphans(false);
    // Detach /Info and add a new object that refers to an orphan, both in prepare.
    const editor: Plugin = {
      prepare(ctx) {
        const added = ctx.addObject([new PdfRef(n.orphan, 0)]);
        ctx.setTrailer('Info', null);
        ctx.setEntry((ctx.trailer().get('Root') as PdfRef).num, 'Extra', added);
      },
    };
    const { out } = await run(input, [removeUnused(), editor]);
    expectValid(out);
    const doc = await open(out);
    expect(await doc.getObject(n.info)).toBeUndefined();
    expect(await doc.getObject(n.orphan)).toBeInstanceOf(PdfDict);
    expect(await doc.getObject(n.cycleA)).toBeUndefined();
  });

  test('reachable() takes an object source and objects to skip', async () => {
    const { bytes: input, n } = orphans(true);
    const doc = await open(input);
    const all = await reachable(doc);
    expect(all(n.info)).toBe(true);
    expect(all(n.orphan)).toBe(false);
    // Pretend the orphan is referenced by a new object past the end, and skip /Info.
    const extra = doc.index.size + 3;
    const get = async (num: number) => (num === extra ? new PdfDict() : num === n.cycleA ? [new PdfRef(n.orphan, 0)] : doc.getObject(num));
    const keep = await reachable(doc, [...doc.trailer.map.values(), new PdfRef(extra, 0), new PdfRef(n.cycleA, 0)], get, (x) => x === n.info);
    expect(keep(n.info)).toBe(false);
    expect(keep(n.cycleA)).toBe(true);
    expect(keep(n.orphan)).toBe(true);
    expect(keep(n.cycleB)).toBe(false);
    expect(keep(extra)).toBe(true);
  });
});

describe('core behaviour removeUnused works around (reported, not fixed here)', () => {
  // The engine copies object streams verbatim. A plain setKeep that drops some members of a
  // stream it keeps leaves them in the copy, without a cross-reference entry: qpdf warns
  // "object N/0 has unexpected xref entry type". removeUnused rewrites such streams.
  test.failing('a bare setKeep dropping object-stream members gives a file qpdf warns about', async () => {
    if (!hasQpdf) throw new Error(QPDF_MISSING);
    const { bytes: input } = orphans(true);
    const bare: Plugin = { finalize: async (ctx) => ctx.setKeep(await reachable(ctx.doc)) };
    const { out } = await run(input, [bare]);
    expect(qpdfCheck(out).code).toBe(0);
  });

  // Members superseded by an incremental update stay inside the copied object stream, so a plain
  // rewrite keeps the old values recoverable.
  test.failing('a plain rewrite keeps superseded object-stream members', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('One', 40, 780) });
    const info = b.obj('<< /Title (OLD-TITLE) >>');
    b.obj('<< /Unrelated true >>');
    b.trailer('Info', `${info} 0 R`);
    b.finish('superseded');
    b.update();
    b.setObj(info, '<< /Title (NEW-TITLE) >>');
    const input = b.build({ xref: ['stream', 'table'], objStm: [true, false], version: '1.5' }).bytes;
    const { out } = await run(input, []);
    expect(everything(out)).not.toContain('OLD-TITLE');
  });
});

describe('repairPdf', () => {
  const damaged = ['broken-offsets', 'junk-before-header', 'wrong-length', 'missing-endobj', 'truncated-xref', 'truncated-object', 'garbage-after-eof', 'xref-off-by-one'];
  for (const name of damaged) {
    test(`${name}: the output is clean`, async () => {
      const f = fixture(name);
      const input = await fixtureBytes(f);
      const sink = new BytesSink();
      const report = await repairPdf(new BytesSource(input), sink);
      const out = sink.bytes();
      expectValid(out);
      if (f.expect.repaired !== undefined) expect(report.xrefRepaired).toBe(f.expect.repaired);
      const reference = f.renderReference ? await f.renderReference() : input;
      const a = renderPdf(reference, 4);
      const b = renderPdf(out, 4);
      expect(b.pageCount).toBe(a.pageCount);
      for (const i of f.expect.staticPages ?? []) expect(sameRaster(a.pages[i]!, b.pages[i]!)).toBe(true);
      // Nothing is dropped.
      const dst = await open(out);
      const src = await open(reference);
      for (let num = 1; num < src.index.size; num++) {
        const v = await src.getObject(num);
        const xref = v instanceof PdfDict && (nameOf(v.get('Type')) === 'XRef' || v.get('Linearized') !== undefined);
        // Stream lengths may have been fixed.
        const entries = (o: unknown) => (o instanceof PdfDict ? [...o.map].filter(([k]) => k !== 'Length') : o);
        if (v !== undefined && !xref) expect(entries(await dst.getObject(num))).toEqual(entries(v));
      }
    });
  }

  test('fixes stream lengths and missing endstream keywords', async () => {
    const input = await fixtureBytes(fixture('wrong-length'));
    const sink = new BytesSink();
    const report = await repairPdf(new BytesSource(input), sink);
    expect(report.warnings.filter((w) => w.includes('fixed the length')).length).toBe(3);
    if (hasQpdf) expect(qpdfCheck(input).code).not.toBe(0);
  });

  test('encrypted documents are rejected, also next to a decrypting plugin', async () => {
    const input = await fixtureBytes(fixture('encrypted-handmade'));
    await expect(repairPdf(new BytesSource(input), new BytesSink())).rejects.toBeInstanceOf(PdfEncryptedError);
    await expect(run(input, [{ decrypts: true }, repairStreams()])).rejects.toBeInstanceOf(PdfEncryptedError);
  });

  test('well-formed files pass through object for object', async () => {
    const input = await fixtureBytes(fixture('brochure-photos'));
    const a = await run(input, [repairStreams()]);
    const b = await run(input, []);
    expect(a.out).toEqual(b.out);
    expect(a.report.warnings).toEqual([]);
  });
});
