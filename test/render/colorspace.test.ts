import { describe, expect, test } from 'bun:test';
import { PdfDict, PdfName, type PdfObj } from '../../src/core/objects.ts';
import { loadColorSpace, type ColorSpace } from '../../src/render/colorspace.ts';
import type { DocBuilder } from '../support/pdfgen.ts';
import { docWith, Garbage, maxDiff, mupdfPage, pixel, ref, u8 } from './objects-helper.ts';

const name = (s: string) => new PdfName(s);

/** A document whose page resources define color spaces `spaces` (name -> PDF text). */
async function withSpaces(spaces: Record<string, string>, add?: (d: DocBuilder) => void, content = '') {
  return docWith((d) => {
    add?.(d);
    const text = Object.entries(spaces)
      .map(([k, v]) => `/${k} ${v}`)
      .join(' ');
    d.page({ width: 10, height: 10, resources: ` /ColorSpace << ${text} >>`, content });
  });
}

/** The page's /ColorSpace resource dictionary. */
async function resources(doc: Awaited<ReturnType<typeof withSpaces>>['doc']): Promise<PdfDict> {
  const root = (await doc.resolve(doc.trailer.get('Root'))) as PdfDict;
  const pages = (await doc.resolve(root.get('Pages'))) as PdfDict;
  const page = (await doc.resolve((pages.get('Kids') as PdfObj[])[0])) as PdfDict;
  const res = (await doc.resolve(page.get('Resources'))) as PdfDict;
  return (await doc.resolve(res.get('ColorSpace'))) as PdfDict;
}

/**
 * Fill cells of a `cols`-wide grid with the given colors (`op` sets the color from each entry),
 * render with MuPDF and return the center pixel of each cell.
 */
async function mupdfColors(colors: number[][], op: (c: number[]) => string, spaces: Record<string, string> = {}, add?: (d: DocBuilder) => void): Promise<[number, number, number][]> {
  const cols = Math.ceil(Math.sqrt(colors.length));
  const rows = Math.ceil(colors.length / cols);
  const cell = 8;
  const { bytes } = await docWith((d) => {
    add?.(d);
    const cs = Object.entries(spaces).map(([k, v]) => `/${k} ${v}`).join(' ');
    let content = '';
    colors.forEach((c, i) => (content += `${op(c)} ${(i % cols) * cell} ${(rows - 1 - Math.floor(i / cols)) * cell} ${cell} ${cell} re f\n`));
    d.page({ width: cols * cell, height: rows * cell, resources: cs ? ` /ColorSpace << ${cs} >>` : '', content });
  });
  const r = mupdfPage(bytes);
  return colors.map((_, i) => pixel(r, (i % cols) * cell + cell / 2, Math.floor(i / cols) * cell + cell / 2));
}

function stats(ours: number[][], theirs: number[][]) {
  let sum = 0;
  let max = 0;
  ours.forEach((c, i) => {
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(c[k] - theirs[i][k]);
      sum += e;
      max = Math.max(max, e);
    }
  });
  return { mean: sum / ours.length / 3, max };
}

const grid = (levels: number[], dims: number): number[][] =>
  dims === 0 ? [[]] : grid(levels, dims - 1).flatMap((g) => levels.map((l) => [...g, l]));

async function load(o: PdfObj, spaces: Record<string, string> = {}, add?: (d: DocBuilder) => void): Promise<ColorSpace | undefined> {
  const { doc } = await withSpaces(spaces, add);
  return loadColorSpace(doc, o, Object.keys(spaces).length ? await resources(doc) : undefined);
}

describe('device spaces', () => {
  test('names, abbreviations and basics', async () => {
    const { doc } = await docWith(() => 0);
    for (const [n, fam, comps, initial] of [
      ['DeviceGray', 'DeviceGray', 1, [0]],
      ['G', 'DeviceGray', 1, [0]],
      ['DeviceRGB', 'DeviceRGB', 3, [0, 0, 0]],
      ['RGB', 'DeviceRGB', 3, [0, 0, 0]],
      ['DeviceCMYK', 'DeviceCMYK', 4, [0, 0, 0, 1]],
      ['CMYK', 'DeviceCMYK', 4, [0, 0, 0, 1]],
    ] as const) {
      const cs = (await loadColorSpace(doc, name(n)))!;
      expect(cs.name).toBe(fam);
      expect(cs.n).toBe(comps);
      expect(cs.initial).toEqual(initial);
      expect(cs.defaultDecode(8)).toEqual(Array(comps).fill([0, 1]).flat());
      expect(cs.rgb(cs.initial)).toEqual(comps === 4 ? cs.rgb([0, 0, 0, 1]) : [0, 0, 0]);
    }
    const rgb = (await loadColorSpace(doc, [name('DeviceRGB')]))!;
    expect(rgb.rgb([1, 0.5, 0])).toEqual([255, 128, 0]);
    expect(rgb.rgb([2, -1, NaN])).toEqual([255, 0, 0]);
    const gray = (await loadColorSpace(doc, name('G')))!;
    expect(gray.rgb([0.2])).toEqual([51, 51, 51]);
  });

  test('rgbRow: offsets, stride 4, alpha untouched, same as rgb()', async () => {
    const { doc } = await docWith(() => 0);
    for (const n of ['DeviceGray', 'DeviceRGB', 'DeviceCMYK']) {
      const cs = (await loadColorSpace(doc, name(n)))!;
      const px = grid([0, 0.3, 1], cs.n);
      const src = new Float32Array(2 + px.length * cs.n);
      px.forEach((c, i) => src.set(c, 2 + i * cs.n));
      const dst = new Uint8ClampedArray(4 + px.length * 4).fill(7);
      cs.rgbRow(src, 2, px.length, dst, 4);
      expect(Array.from(dst.subarray(0, 4))).toEqual([7, 7, 7, 7]);
      px.forEach((c, i) => {
        // CMYK rows interpolate a table of the polynomial rgb() evaluates.
        expect(maxDiff(dst.subarray(4 + 4 * i, 7 + 4 * i), cs.rgb(Float32Array.from(c)))).toBeLessThanOrEqual(n === 'DeviceCMYK' ? 4 : 0);
        expect(dst[7 + 4 * i]).toBe(7);
      });
    }
  });

  test('DeviceCMYK is close to MuPDF, much closer than the naive formula', async () => {
    const colors = grid([0, 0.2, 0.4, 0.6, 0.8, 1], 4);
    const theirs = await mupdfColors(colors, (c) => `${c.join(' ')} k`);
    const cs = (await load(name('DeviceCMYK')))!;
    const ours = stats(colors.map((c) => cs.rgb(c)), theirs);
    const naive = stats(colors.map(([c, m, y, k]) => [c, m, y].map((v) => Math.round(255 * (1 - v) * (1 - k)))), theirs);
    expect(ours.mean).toBeLessThan(2);
    expect(ours.max).toBeLessThan(40);
    expect(naive.mean).toBeGreaterThan(10);
    // Common colors are close.
    for (const c of [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0.2, 0.2, 0.2, 0], [0, 0, 0, 0.5], [1, 1, 0, 0]]) {
      const i = colors.findIndex((x) => x.every((v, k) => Math.abs(v - c[k]) < 1e-9));
      if (i >= 0) expect(maxDiff(cs.rgb(c), theirs[i])).toBeLessThanOrEqual(10);
    }
    expect(cs.rgb([0, 0, 0, 0])).toEqual([255, 255, 255]);
    // Rows (through the table) are about as close.
    const src = Float32Array.from(colors.flat());
    const dst = new Uint8ClampedArray(colors.length * 4);
    cs.rgbRow(src, 0, colors.length, dst, 0);
    const rows = stats(colors.map((_, i) => Array.from(dst.subarray(4 * i, 4 * i + 3))), theirs);
    expect(rows.mean).toBeLessThan(2);
    expect(rows.max).toBeLessThan(40);
    {
    }
    // Measured: mean 1.49, max 16 (the naive formula: mean 16.4, max 116).
  });

  test('CalGray and CalRGB: gamma, matrix and white point, compared with MuPDF', async () => {
    const cases: [string, number[]][] = [
      ['[/CalRGB << /WhitePoint [0.9505 1 1.089] /Gamma [2.2 2.2 2.2] /Matrix [0.4124 0.2126 0.0193 0.3576 0.7152 0.1192 0.1805 0.0722 0.9505] >>]', [0.5, 0.2, 0.8]],
      ['[/CalRGB << /WhitePoint [0.9505 1 1.089] /Gamma [1.8 1.8 1.8] /Matrix [0.4497 0.2446 0.0252 0.3163 0.672 0.1412 0.1845 0.0833 0.9227] >>]', [0.7, 0.3, 0.1]],
      ['[/CalRGB << /WhitePoint [0.9642 1 0.8249] /Gamma [2.2 2.2 2.2] /Matrix [0.6097 0.3111 0.0195 0.2053 0.6257 0.0609 0.1492 0.0632 0.7446] >>]', [0.3, 0.8, 0.5]],
      ['[/CalRGB << /WhitePoint [0.9505 1 1.089] /Matrix [0.4124 0.2126 0.0193 0.3576 0.7152 0.1192 0.1805 0.0722 0.9505] >>]', [0.5, 0.5, 0.5]], // gamma 1
      ['[/CalGray << /WhitePoint [0.9505 1 1.089] >>]', [0.5]],
      ['[/CalGray << /WhitePoint [0.9505 1 1.089] /Gamma 1.8 >>]', [0.3]],
      ['[/CalGray << /WhitePoint [0.9505 1 1.089] /Gamma 2.2 >>]', [0.5]],
    ];
    const spaces = Object.fromEntries(cases.map(([cs], i) => [`C${i}`, cs]));
    const theirs = await mupdfColors(cases.map((c) => c[1]), (c) => `/C${cases.findIndex((x) => x[1] === c)} cs ${c.join(' ')} sc`, spaces);
    for (const [i, [, c]] of cases.entries()) {
      const cs = (await load(name(`C${i}`), spaces))!;
      expect(cs.name).toBe(c.length === 1 ? 'CalGray' : 'CalRGB');
      expect(cs.n).toBe(c.length);
      expect(maxDiff(cs.rgb(c), theirs[i])).toBeLessThanOrEqual(2);
    }
  });
});

describe('Lab', () => {
  test('matches MuPDF (white point ignored, range clipping)', async () => {
    const spaces = { L: '[/Lab << /WhitePoint [0.9505 1 1.089] /Range [-128 127 -128 127] >>]' };
    const colors = grid([0, 25, 50, 75, 100], 1).flatMap(([l]) => grid([-100, -40, 0, 40, 100, 200], 2).map((ab) => [l, ...ab]));
    const theirs = await mupdfColors(colors, (c) => `/L cs ${c.join(' ')} sc`, spaces);
    const cs = (await load(name('L'), spaces))!;
    expect(cs.name).toBe('Lab');
    expect(cs.n).toBe(3);
    expect(cs.defaultDecode(8)).toEqual([0, 100, -128, 127, -128, 127]);
    const s = stats(colors.map((c) => cs.rgb(c)), theirs);
    expect(s.mean).toBeLessThan(1.5);
    expect(s.max).toBeLessThanOrEqual(6);
    expect(cs.rgb([100, 0, 0])).toEqual([255, 255, 255]);
    expect(cs.rgb([0, 0, 0])).toEqual([0, 0, 0]);
  });

  test('default range and initial color', async () => {
    const cs = (await load([name('Lab'), new PdfDict()]))!;
    expect(cs.defaultDecode(8)).toEqual([0, 100, -100, 100, -100, 100]);
    expect(cs.initial).toEqual([0, 0, 0]);
    const shifted = (await load(name('L'), { L: '[/Lab << /WhitePoint [1 1 1] /Range [10 20 -5 5] >>]' }))!;
    expect(shifted.initial).toEqual([0, 10, 0]);
  });
});

describe('ICCBased', () => {
  const iccStream = (d: DocBuilder, dict: string) => d.stream(dict, u8(0, 1, 2, 3));
  test('uses /N or /Alternate; /Range becomes the decode array', async () => {
    let refs: number[] = [];
    const { doc } = await docWith((d) => {
      refs = [iccStream(d, '/N 3'), iccStream(d, '/N 4'), iccStream(d, '/N 1'), iccStream(d, '/N 3 /Alternate /DeviceGray'), iccStream(d, '/N 3 /Alternate [/Lab << /WhitePoint [1 1 1] >>]'), iccStream(d, '/N 2'), iccStream(d, '/N 1 /Range [0 2]')];
    });
    const cs = await Promise.all(refs.map((r) => loadColorSpace(doc, [name('ICCBased'), ref(r)])));
    expect(cs.map((c) => c?.n)).toEqual([3, 4, 1, 3, 3, undefined, 1]);
    expect(cs.every((c) => !c || c.name === 'ICCBased')).toBe(true);
    expect(cs[0]!.rgb([1, 0, 0])).toEqual([255, 0, 0]);
    expect(cs[1]!.rgb([0, 0, 0, 1])).toEqual((await loadColorSpace(doc, name('DeviceCMYK')))!.rgb([0, 0, 0, 1]));
    expect(cs[3]!.rgb([1, 0, 0])).toEqual([255, 0, 0]); // wrong /Alternate: /N wins
    expect(cs[4]!.rgb([100, 0, 0])).toEqual([255, 255, 255]); // Lab alternate
    expect(cs[6]!.defaultDecode(8)).toEqual([0, 2]);
    expect(cs[0]!.defaultDecode(8)).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

describe('Indexed', () => {
  test('lookup from a string or a stream, over RGB, CMYK and Lab bases; compared with MuPDF', async () => {
    const spaces = {
      I1: '[/Indexed /DeviceRGB 2 <FF000000FF00 0000FF>]',
      I2: (d: DocBuilder) => `[/Indexed /DeviceCMYK 3 ${d.stream('', u8(255, 0, 0, 0, 0, 0, 0, 255, 0, 128, 128, 0, 10, 20, 30, 40))} 0 R]`,
      I3: '[/I [/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>] 1 (\\377\\200\\200\\100\\300\\060)]',
      I4: '[/Indexed /G 255 <' + Array.from({ length: 256 }, (_, i) => (255 - i).toString(16).padStart(2, '0')).join('') + '>]',
    } as unknown as Record<string, string>;
    const probes: [string, number[]][] = [
      ['I1', [0]], ['I1', [1]], ['I1', [2]], ['I2', [0]], ['I2', [1]], ['I2', [2]], ['I2', [3]], ['I3', [0]], ['I3', [1]], ['I4', [0]], ['I4', [100]],
    ];
    let pdfSpaces: Record<string, string> = {};
    const { doc, bytes } = await docWith((d) => {
      pdfSpaces = Object.fromEntries(Object.entries(spaces).map(([k, v]) => [k, typeof v === 'function' ? (v as (d: DocBuilder) => string)(d) : v]));
      const text = Object.entries(pdfSpaces).map(([k, v]) => `/${k} ${v}`).join(' ');
      const content = probes.map(([s, c], i) => `/${s} cs ${c.join(' ')} sc ${i * 8} 0 8 8 re f`).join('\n');
      d.page({ width: probes.length * 8, height: 8, resources: ` /ColorSpace << ${text} >>`, content });
    });
    const r = mupdfPage(bytes);
    const res = await resources(doc);
    for (const [i, [s, c]] of probes.entries()) {
      const cs = (await loadColorSpace(doc, name(s), res))!;
      expect(cs.name).toBe('Indexed');
      expect(cs.n).toBe(1);
      expect(maxDiff(cs.rgb(c), pixel(r, i * 8 + 4, 4))).toBeLessThanOrEqual(s === 'I2' ? 12 : 3);
    }
    const i1 = (await loadColorSpace(doc, name('I1'), res))!;
    expect(i1.defaultDecode(4)).toEqual([0, 15]);
    expect(i1.initial).toEqual([0]);
    // Out-of-range and fractional indexes clip and round.
    expect(i1.rgb([7])).toEqual([0, 0, 255]);
    expect(i1.rgb([-1])).toEqual([255, 0, 0]);
    expect(i1.rgb([0.6])).toEqual([0, 255, 0]);
    const dst = new Uint8ClampedArray(12);
    i1.rgbRow([2, 1, 0], 0, 3, dst, 0);
    expect(Array.from(dst)).toEqual([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0]);
  });

  test('bad tables', async () => {
    for (const a of ['[/Indexed /DeviceRGB -1 <00>]', '[/Indexed /DeviceRGB 1]', '[/Indexed /Pattern 1 <00>]', '[/Indexed /Foo 1 <00>]', '[/Indexed /DeviceRGB 1 5]']) {
      expect(await load(name('X'), { X: a })).toBeUndefined();
    }
    // A short table reads as zeros; hival above 255 is clipped.
    const cs = (await load(name('X'), { X: '[/Indexed /DeviceRGB 300 <FFFFFF>]' }))!;
    expect(cs.rgb([0])).toEqual([255, 255, 255]);
    expect(cs.rgb([255])).toEqual([0, 0, 0]);
  });
});

describe('Separation and DeviceN', () => {
  const tint4 = (d: DocBuilder, src: string, m: number, n: number) =>
    d.stream(`/FunctionType 4 /Domain [${'0 1 '.repeat(m)}] /Range [${'0 1 '.repeat(n)}]`, new TextEncoder().encode(src));

  test('tint transforms into CMYK and RGB, compared with MuPDF', async () => {
    const spaces: Record<string, string> = {};
    const tints = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1];
    const add = (d: DocBuilder) => {
      spaces.S1 = `[/Separation /Spot1 /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.1 0.9 0.2 0.05] /N 1 >>]`;
      spaces.S2 = `[/Separation /Spot2 /DeviceRGB ${tint4(d, '{ dup 1 exch sub exch dup mul 0.5 }', 1, 3)} 0 R]`;
      spaces.D1 = `[/DeviceN [/Cyan /Orange] /DeviceCMYK ${tint4(d, '{ exch 0.5 mul exch dup 0.6 mul exch 0 }', 2, 4)} 0 R]`;
      spaces.D2 = `[/DeviceN [/A /B /C] /DeviceRGB ${tint4(d, '{ 3 1 roll 1 exch sub 3 1 roll 1 exch sub 3 1 roll 1 exch sub 3 1 roll }', 3, 3)} 0 R << /Subtype /NChannel >>]`;
    };
    const probes: [string, number[]][] = [
      ...tints.map((t): [string, number[]] => ['S1', [t]]),
      ...tints.map((t): [string, number[]] => ['S2', [t]]),
      ...grid([0, 0.4, 1], 2).map((c): [string, number[]] => ['D1', c]),
      ...grid([0, 0.5, 1], 3).map((c): [string, number[]] => ['D2', c]),
    ];
    const { doc, bytes } = await docWith((d) => {
      add(d);
      const text = Object.entries(spaces).map(([k, v]) => `/${k} ${v}`).join(' ');
      const content = probes.map(([s, c], i) => `/${s} cs ${c.join(' ')} sc ${(i % 20) * 8} ${Math.floor(i / 20) * 8} 8 8 re f`).join('\n');
      d.page({ width: 160, height: 8 * Math.ceil(probes.length / 20), resources: ` /ColorSpace << ${text} >>`, content });
    });
    const r = mupdfPage(bytes);
    const res = await resources(doc);
    const spacesLoaded = new Map<string, ColorSpace>();
    for (const s of ['S1', 'S2', 'D1', 'D2']) spacesLoaded.set(s, (await loadColorSpace(doc, name(s), res))!);
    expect(spacesLoaded.get('S1')!.name).toBe('Separation');
    expect(spacesLoaded.get('D2')!.name).toBe('DeviceN');
    expect(spacesLoaded.get('D2')!.n).toBe(3);
    expect(spacesLoaded.get('S1')!.initial).toEqual([1]);
    expect(spacesLoaded.get('D1')!.initial).toEqual([1, 1]);
    for (const [i, [s, c]] of probes.entries()) {
      const theirs = pixel(r, (i % 20) * 8 + 4, r.height - 1 - (Math.floor(i / 20) * 8 + 4));
      const cs = spacesLoaded.get(s)!;
      // CMYK alternates carry the polynomial's error.
      expect(maxDiff(cs.rgb(c), theirs)).toBeLessThanOrEqual(s === 'S2' || s === 'D2' ? 1 : 10);
      // The row path (a table for one component, memoized for several) agrees with rgb().
      const dst = new Uint8ClampedArray(8);
      cs.rgbRow([...c, ...c], 0, 2, dst, 0);
      expect(maxDiff(dst.subarray(4), cs.rgb(c))).toBeLessThanOrEqual(1);
    }
  });

  test('/All, /None and broken transforms', async () => {
    const all = (await load(name('X'), { X: '[/Separation /All /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 >>]' }))!;
    expect(all.rgb([1])).toEqual([0, 0, 0]);
    expect(all.rgb([0.25])).toEqual([191, 191, 191]);
    expect(all.none).toBeFalsy();
    const none = (await load(name('X'), { X: '[/Separation /None /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 >>]' }))!;
    expect(none.none).toBe(true);
    const noneN = (await load(name('X'), { X: '[/DeviceN [/None /None] /DeviceGray << /FunctionType 2 /Domain [0 1] /N 1 >>]' }))!;
    expect(noneN.none).toBe(true);
    expect(noneN.n).toBe(2);
    for (const bad of [
      '[/Separation /Spot /DeviceCMYK]',
      '[/Separation /Spot /DeviceCMYK /Identity]',
      '[/Separation /Spot /Nope << /FunctionType 2 /Domain [0 1] /N 1 >>]',
      '[/Separation /Spot /Pattern << /FunctionType 2 /Domain [0 1] /N 1 >>]',
      '[/DeviceN [] /DeviceGray << /FunctionType 2 /Domain [0 1] /N 1 >>]',
    ]) {
      expect(await load(name('X'), { X: bad })).toBeUndefined();
    }
  });
});

describe('Pattern, resources and defaults', () => {
  test('Pattern spaces', async () => {
    const p = (await load(name('Pattern')))!;
    expect([p.name, p.n, p.base]).toEqual(['Pattern', 0, undefined]);
    const q = (await load([name('Pattern'), name('DeviceRGB')]))!;
    expect([q.name, q.n, q.base?.name]).toEqual(['Pattern', 3, 'DeviceRGB']);
    expect(q.rgb([0, 1, 0])).toEqual([0, 255, 0]);
    const r = (await load(name('P'), { P: '[/Pattern /CS0]', CS0: '[/ICCBased 999 0 R]' }))!;
    expect([r.name, r.n, r.base]).toEqual(['Pattern', 0, undefined]);
  });

  test('resource names, references and cycles', async () => {
    const spaces = { A: '/DeviceCMYK', B: '/A', C: '[/Indexed /B 0 <00000000>]', Loop1: '/Loop2', Loop2: '/Loop1', Self: '[/Indexed /Self 0 <00>]' };
    const { doc } = await withSpaces(spaces);
    const res = await resources(doc);
    expect((await loadColorSpace(doc, name('B'), res))?.name).toBe('DeviceCMYK');
    expect((await loadColorSpace(doc, name('C'), res))?.name).toBe('Indexed');
    expect(await loadColorSpace(doc, name('Loop1'), res)).toBeUndefined();
    expect(await loadColorSpace(doc, name('Self'), res)).toBeUndefined();
    expect(await loadColorSpace(doc, name('Missing'), res)).toBeUndefined();
    expect(await loadColorSpace(doc, name('B'))).toBeUndefined();
    const viaRef = await docWith((d) => d.obj('[/Indexed /DeviceRGB 0 <FF0000>]'));
    expect((await loadColorSpace(viaRef.doc, ref(viaRef.value)))?.rgb([0])).toEqual([255, 0, 0]);
  });

  test('DefaultGray, DefaultRGB and DefaultCMYK replace device spaces when they fit', async () => {
    const spaces = { DefaultRGB: '[/Indexed /DeviceRGB 0 <00FF00>]', DefaultGray: '[/CalGray << /WhitePoint [1 1 1] >>]', DefaultCMYK: '/DeviceRGB' };
    const { doc } = await withSpaces(spaces);
    const res = await resources(doc);
    expect((await loadColorSpace(doc, name('DeviceGray'), res))?.name).toBe('CalGray');
    expect((await loadColorSpace(doc, name('DeviceCMYK'), res))?.name).toBe('DeviceCMYK'); // wrong n: ignored
    expect((await loadColorSpace(doc, name('DeviceRGB'), res))?.name).toBe('DeviceRGB'); // Indexed has 1 component
    const { doc: doc2 } = await withSpaces({ DefaultRGB: '[/ICCBased 5 0 R]' }, (d) => d.setStream(5, '/N 3', u8(0)));
    const def = (await loadColorSpace(doc2, name('RGB'), await resources(doc2)))!;
    expect([def.name, def.n]).toEqual(['ICCBased', 3]);
  });

  test('unusable input', async () => {
    const { doc } = await docWith(() => 0);
    for (const o of [undefined, null, 3, [], [3], name('Nope'), [name('Indexed')], [name('Lab')], [name('DeviceN')], name('constructor'), name('__proto__'), [name('toString'), name('DeviceRGB')]]) {
      expect(await loadColorSpace(doc, o as PdfObj)).toBeUndefined();
    }
  });
});

describe('garbage', () => {
  test('random color space arrays never throw; colors stay in range', async () => {
    const g = new Garbage(11);
    const fams = ['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'CalGray', 'CalRGB', 'Lab', 'ICCBased', 'Indexed', 'I', 'Separation', 'DeviceN', 'Pattern', 'G', 'X'];
    let loaded = 0;
    for (let i = 0; i < 300; i++) {
      const parts = [`/${g.pick(fams)}`];
      for (let k = g.int(5); k > 0; k--) parts.push(g.int(4) ? g.value() : `<< /FunctionType 2 /Domain [0 1] /C1 [${g.num()} ${g.num()}] /N ${g.num()} >>`);
      const text = g.int(5) ? `[${parts.join(' ')}]` : parts[0];
      const { doc } = await withSpaces({ X: text, Y: '/X' });
      const cs = await loadColorSpace(doc, name(g.pick(['X', 'Y', 'X'])), await resources(doc));
      if (!cs) continue;
      loaded++;
      expect(cs.initial.length).toBe(cs.n);
      for (let j = 0; j < 4; j++) {
        const c = Array.from({ length: cs.n }, () => g.int(7) / 3 - 0.5);
        for (const v of cs.rgb(c)) expect(v >= 0 && v <= 255 && Number.isInteger(v)).toBe(true);
        const dst = new Uint8ClampedArray(8);
        cs.rgbRow([...c, ...c], 0, 2, dst, 0);
      }
      expect(Array.isArray(cs.defaultDecode(g.pick([1, 8, 16])))).toBe(true);
    }
    expect(loaded).toBeGreaterThan(50);
  });
});
