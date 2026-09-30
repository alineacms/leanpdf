import { describe, expect, test } from 'bun:test';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { PdfDict } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { walkPages } from '../../src/core/pages.ts';
import { rewritePdf, type Plugin } from '../../src/core/rewrite.ts';
import { selectPages } from '../../src/features/pages-select.ts';
import { rotatePages } from '../../src/features/rotate.ts';
import { bytes, drawText, flate, PdfBuilder, text } from '../support/pdfgen.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, qpdfTransform } from '../support/qpdf.ts';
import { meanAbsError, renderPdf, type Raster } from '../support/render.ts';
import { BytesSink, BytesSource } from '../unit/util.ts';

if (!hasQpdf) console.warn(QPDF_MISSING);

async function run(input: Uint8Array, plugins: Plugin[]) {
  const sink = new BytesSink();
  const report = await rewritePdf(new BytesSource(input), sink, plugins);
  return { out: sink.bytes(), report };
}

function expectValid(out: Uint8Array): void {
  if (!hasQpdf) return;
  const r = qpdfCheck(out);
  if (r.code !== 0) console.error(r.output);
  expect(r.code).toBe(0);
}

/**
 * Four pages under a two-level tree: the middle node gives its three pages /Rotate 90, which
 * page 1 overrides with 180 and page 2 with 0; page 3 hangs off the root (0).
 */
function tree(objStm = false): { bytes: Uint8Array; pages: number[] } {
  const b = new PdfBuilder();
  const cat = b.alloc();
  const root = b.alloc();
  const mid = b.alloc();
  const font = b.obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pages = [b.alloc(), b.alloc(), b.alloc(), b.alloc()];
  const own = [undefined, 180, 0, undefined];
  pages.forEach((p, i) => {
    // Asymmetric content, so every rotation looks different.
    const content = `0.8 0.1 0.1 rg 10 250 60 40 re f 0.1 0.1 0.8 rg 150 10 40 20 re f\n${drawText(`Page ${i}`, 20, 150, 20)}`;
    const c = b.stream('/Filter /FlateDecode', flate(bytes(content)));
    const parent = i < 3 ? mid : root;
    b.setObj(p, `<< /Type /Page /Parent ${parent} 0 R /Contents ${c} 0 R${own[i] === undefined ? '' : ` /Rotate ${own[i]}`} >>`);
  });
  b.setObj(mid, `<< /Type /Pages /Parent ${root} 0 R /Kids [${pages.slice(0, 3).map((p) => `${p} 0 R`).join(' ')}] /Count 3 /Rotate 90 >>`);
  b.setObj(root, `<< /Type /Pages /Kids [${mid} 0 R ${pages[3]} 0 R] /Count 4 /MediaBox [0 0 200 300] /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  b.setObj(cat, `<< /Type /Catalog /Pages ${root} 0 R >>`);
  b.trailer('Root', `${cat} 0 R`);
  return { bytes: b.build(objStm ? { xref: 'stream', objStm: true, version: '1.5' } : {}).bytes, pages };
}

async function rotations(b: Uint8Array): Promise<number[]> {
  const out: number[] = [];
  for await (const p of walkPages(await openPdf(new BytesSource(b)))) out.push(p.rotate);
  return out;
}

/** Turn a raster clockwise by `deg` (a multiple of 90). */
function turn(r: Raster, deg: number): Raster {
  for (let k = 0; k < ((deg / 90) % 4 + 4) % 4; k++) {
    const { width: w, height: h } = r;
    const rgb = new Uint8Array(r.rgb.length);
    for (let y = 0; y < w; y++) for (let x = 0; x < h; x++) rgb.set(r.rgb.subarray(((h - 1 - x) * w + y) * 3, ((h - 1 - x) * w + y) * 3 + 3), (y * h + x) * 3);
    r = { width: h, height: w, rgb };
  }
  return r;
}

/**
 * Output page i looks like input page i turned by `by[i]` degrees (text is rasterized a little
 * differently when turned, shapes exactly the same).
 */
function expectTurned(input: Uint8Array, out: Uint8Array, by: number[]): void {
  const a = renderPdf(input, 8);
  const b = renderPdf(out, 8);
  expect(b.pageCount).toBe(a.pageCount);
  by.forEach((deg, i) => {
    expect(meanAbsError(turn(a.pages[i]!, deg), b.pages[i]!)).toBeLessThan(1);
    expect(meanAbsError(turn(a.pages[i]!, deg + 180), b.pages[i]!)).toBeGreaterThan(5);
  });
}

for (const objStm of [false, true]) {
  const label = objStm ? ' (object streams)' : '';
  const doc = tree(objStm);

  describe(`rotatePages${label}`, () => {
    test('the fixture inherits and overrides /Rotate', async () => {
      expect(await rotations(doc.bytes)).toEqual([90, 180, 0, 0]);
      expectValid(doc.bytes);
    });

    test('a number rotates every page by that much', async () => {
      const { out } = await run(doc.bytes, [rotatePages(90)]);
      expectValid(out);
      expect(await rotations(out)).toEqual([180, 270, 90, 90]);
      expectTurned(doc.bytes, out, [90, 90, 90, 90]);
      // Every page carries its own value now.
      const d = await openPdf(new BytesSource(out));
      for (const p of doc.pages) expect(((await d.getObject(p)) as PdfDict).get('Rotate')).toBeNumber();
    });

    test('rotations are normalized', async () => {
      for (const [by, expected] of [[-90, [0, 90, 270, 270]], [450, [180, 270, 90, 90]], [360, [90, 180, 0, 0]], [-540, [270, 0, 180, 180]]] as const) {
        const { out } = await run(doc.bytes, [rotatePages(by)]);
        expectValid(out);
        expect(await rotations(out)).toEqual([...expected]);
      }
    });

    test('a function sets absolute rotations and leaves unchanged pages alone', async () => {
      const seen: [number, number][] = [];
      const { out } = await run(doc.bytes, [
        rotatePages((i, cur) => {
          seen.push([i, cur]);
          return i === 0 ? -360 : i === 3 ? 630 : cur;
        }),
      ]);
      expectValid(out);
      expect(seen).toEqual([[0, 90], [1, 180], [2, 0], [3, 0]]);
      expect(await rotations(out)).toEqual([0, 180, 0, 270]);
      expectTurned(doc.bytes, out, [-90, 0, 0, 270]);
      if (!objStm) {
        // Pages 1 and 2 are copied byte for byte.
        const src = text(doc.bytes);
        const dst = text(out);
        for (const p of doc.pages.slice(1, 3)) {
          const body = new RegExp(`\\n${p} 0 obj[\\s\\S]*?endobj`).exec(src)![0];
          expect(dst).toContain(body);
        }
      }
    });
  });
}

describe('rotatePages validation', () => {
  test('rotations must be multiples of 90', async () => {
    for (const bad of [45, 1.5, NaN, Infinity]) expect(() => rotatePages(bad)).toThrow(RangeError);
    await expect(run(tree().bytes, [rotatePages(() => 45)])).rejects.toBeInstanceOf(RangeError);
  });

  test('encrypted documents are rejected, also next to a decrypting plugin', async () => {
    if (!hasQpdf) return;
    const enc = qpdfTransform(tree().bytes, ['--encrypt', 'u', 'o', '256', '--']);
    await expect(run(enc, [rotatePages(90)])).rejects.toBeInstanceOf(PdfEncryptedError);
    await expect(run(enc, [{ decrypts: true }, rotatePages(90)])).rejects.toBeInstanceOf(PdfEncryptedError);
  });

  test('composes with selectPages in either order', async () => {
    const input = tree().bytes;
    const turnFirst = (i: number, cur: number) => (i === 3 ? cur + 90 : cur);
    const a = await run(input, [rotatePages(turnFirst), selectPages([3, 0])]);
    const b = await run(input, [selectPages([3, 0]), rotatePages(turnFirst)]);
    for (const { out } of [a, b]) {
      expectValid(out);
      expect(await rotations(out)).toEqual([90, 90]);
    }
    // The same pages (entries may come in another order).
    const ra = renderPdf(a.out);
    const rb = renderPdf(b.out);
    ra.pages.forEach((p, i) => expect(meanAbsError(p!, rb.pages[i]!)).toBe(0));
  });
});
