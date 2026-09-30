import { describe, expect, test } from 'bun:test';
import { PdfDict } from '../../src/core/objects.ts';
import { loadShading, type GradientStop, type ShadingPaint } from '../../src/render/shading.ts';
import type { DocBuilder } from '../support/pdfgen.ts';
import type { Raster } from '../support/render.ts';
import { docWith, Garbage, mupdfPage, pixel, ref } from './objects-helper.ts';

type Raster2 = Extract<ShadingPaint, { kind: 'raster' }>;

/** Pack big-endian bit fields; each record (vertex or patch) starts on a byte boundary. */
function mesh(records: [number, number][][]): Uint8Array {
  const out: number[] = [];
  for (const rec of records) {
    let acc = 0n;
    let n = 0;
    for (const [v, bits] of rec) {
      acc = (acc << BigInt(bits)) | BigInt(Math.round(v));
      n += bits;
    }
    const pad = (8 - (n % 8)) % 8;
    acc <<= BigInt(pad);
    n += pad;
    for (let i = n - 8; i >= 0; i -= 8) out.push(Number((acc >> BigInt(i)) & 255n));
  }
  return Uint8Array.from(out);
}

/**
 * A page of `w` x `h` whose content paints shading /S (defined by `add`, returning its object
 * number) with `sh`, plus our loaded shading and MuPDF's rendering.
 */
async function setup(w: number, h: number, add: (d: DocBuilder) => number, content = '/S sh', colorSpaces = '') {
  let sh = 0;
  const { doc, bytes } = await docWith((d) => {
    sh = add(d);
    d.page({ width: w, height: h, resources: ` /Shading << /S ${sh} 0 R >>${colorSpaces ? ` /ColorSpace << ${colorSpaces} >>` : ''}`, content });
  });
  let cs: PdfDict | undefined;
  if (colorSpaces) {
    const get = async (d: unknown, k: string) => (await doc.resolve((d as PdfDict).get(k))) as PdfDict;
    const pages = await get(await get(doc.trailer, 'Root'), 'Pages');
    const page = (await doc.resolve((pages.get('Kids') as PdfDict[])[0])) as PdfDict;
    cs = await get(await get(page, 'Resources'), 'ColorSpace');
  }
  const paint = await loadShading(doc, ref(sh), cs);
  return { paint, mu: mupdfPage(bytes), doc, sh };
}

/** A stop list's color at `s` (0..1), interpolated as canvas gradients do. */
function stopColor(stops: GradientStop[], s: number): number[] {
  if (s <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (s <= b.offset) {
      const u = b.offset > a.offset ? (s - a.offset) / (b.offset - a.offset) : 1;
      return a.color.map((c, k) => c + u * (b.color[k] - c));
    }
  }
  return stops[stops.length - 1].color;
}

/**
 * Compare our raster with MuPDF's on pixels we cover whose 5 x 5 neighbourhood we also cover
 * (edges are rasterized differently). Returns mean and 99th percentile error, and the coverage.
 */
function compare(ours: Uint8ClampedArray, mu: Raster, w: number, h: number) {
  const errs: number[] = [];
  let covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ours[(y * w + x) * 4 + 3]) continue;
      covered++;
      let inner = true;
      for (let dy = -2; dy <= 2 && inner; dy++) for (let dx = -2; dx <= 2 && inner; dx++) inner = x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && ours[((y + dy) * w + x + dx) * 4 + 3] === 255;
      if (!inner) continue;
      const m = pixel(mu, x, y);
      for (let c = 0; c < 3; c++) errs.push(Math.abs(ours[(y * w + x) * 4 + c] - m[c]));
    }
  }
  errs.sort((a, b) => a - b);
  return { mean: errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length), p99: errs[Math.floor(errs.length * 0.99)] ?? 0, covered: covered / (w * h), n: errs.length };
}

/** Our raster for a page of height `h` (shading space = default user space). */
const rasterize = (p: ShadingPaint | undefined, w: number, h: number) => (p as Raster2).render([1, 0, 0, -1, 0, h], w, h);

describe('axial and radial shadings', () => {
  test('axial RGB: few stops for a linear function, colors along the axis match MuPDF', async () => {
    const { paint, mu } = await setup(200, 20, (d) => d.obj('<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0.5 1] /N 1 >> /Extend [true false] >>'));
    expect(paint?.kind).toBe('axial');
    if (paint?.kind !== 'axial') return;
    expect(paint.coords).toEqual([0, 0, 200, 0]);
    expect(paint.extend).toEqual([true, false]);
    expect(paint.stops.length).toBeLessThanOrEqual(3);
    expect(paint.stops[0]).toEqual({ offset: 0, color: [255, 0, 0] });
    expect(paint.stops[paint.stops.length - 1]).toEqual({ offset: 1, color: [0, 128, 255] });
    for (let x = 0; x < 200; x += 7) expect(Math.max(...stopColor(paint.stops, (x + 0.5) / 200).map((c, k) => Math.abs(c - pixel(mu, x, 10)[k])))).toBeLessThanOrEqual(3);
  });

  test('nonlinear functions keep enough stops; stitching jumps become two stops at one offset', async () => {
    const { paint, mu } = await setup(300, 10, (d) => {
      const a = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 3 >>');
      const b = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 0 0] /N 1 >>');
      return d.obj(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 300 0] /Domain [2 5] /Function << /FunctionType 3 /Domain [2 5] /Functions [${a} 0 R ${b} 0 R] /Bounds [3.5] /Encode [0 1 0 1] >> >>`);
    });
    if (paint?.kind !== 'axial') throw new Error('axial expected');
    const at = paint.stops.filter((s) => Math.abs(s.offset - 0.5) < 1e-9);
    expect(at.map((s) => s.color)).toEqual([[255, 255, 255], [0, 0, 255]]);
    expect(paint.stops.length).toBeLessThan(80);
    // Every sample of the function is within about 1 of the stops' interpolation.
    for (let i = 0; i <= 600; i++) {
      const s = i / 600;
      const t = 2 + 3 * s;
      const want = t < 3.5 ? [0, 1, 2].map(() => 255 * ((t - 2) / 1.5) ** 3) : [255 * ((t - 3.5) / 1.5), 0, 255 * (1 - (t - 3.5) / 1.5)];
      if (Math.abs(s - 0.5) > 0.002) expect(Math.max(...stopColor(paint.stops, s).map((c, k) => Math.abs(c - want[k])))).toBeLessThanOrEqual(1.6);
    }
    for (let x = 0; x < 300; x += 11) {
      if (Math.abs(x - 150) < 3) continue;
      // MuPDF looks colors up in a 256-entry table of the function: steep parts differ a little.
      expect(Math.max(...stopColor(paint.stops, (x + 0.5) / 300).map((c, k) => Math.abs(c - pixel(mu, x, 5)[k])))).toBeLessThanOrEqual(8);
    }
  });

  test('radial CMYK with an array of functions, background and bbox', async () => {
    const { paint, mu } = await setup(
      120,
      120,
      (d) =>
        d.obj(
          '<< /ShadingType 3 /ColorSpace /DeviceCMYK /Coords [60 60 0 60 60 60] /Extend [false true] /Background [0 0 0 0.2] /BBox [0 0 120 120] /Function [' +
            '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> ' +
            '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0.5] /N 2 >> << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [0] /N 1 >>] >>',
        ),
    );
    if (paint?.kind !== 'radial') throw new Error('radial expected');
    expect(paint.coords).toEqual([60, 60, 0, 60, 60, 60]);
    expect(paint.extend).toEqual([false, true]);
    expect(paint.bbox).toEqual([0, 0, 120, 120]);
    expect(paint.background).toBeDefined();
    for (let r = 2; r < 58; r += 5) {
      const theirs = pixel(mu, 60 + r, 60);
      const ours = stopColor(paint.stops, (r + 0.5) / 60);
      expect(Math.max(...ours.map((c, k) => Math.abs(c - theirs[k])))).toBeLessThanOrEqual(12); // CMYK polynomial and sampling
    }
  });

  test('degenerate and bad input', async () => {
    const { doc } = await docWith(() => 0);
    expect(await loadShading(doc, undefined)).toBeUndefined();
    expect(await loadShading(doc, new PdfDict())).toBeUndefined();
    const bad = [
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] >>', // no function
      '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>',
      '<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [0 0 -1 0 0 5] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>',
      '<< /ShadingType 2 /ColorSpace /Nope /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>',
      '<< /ShadingType 2 /ColorSpace /Pattern /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>',
      '<< /ShadingType 9 /ColorSpace /DeviceRGB >>',
      '<< /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 1 0 1 0 1 0 1 0 1] >>', // not a stream
    ];
    for (const s of bad) {
      const { doc: d2, value } = await docWith((d) => d.obj(s));
      expect(await loadShading(d2, ref(value))).toBeUndefined();
    }
    // Domain with t0 = t1: one color.
    const { doc: d3, value: v3 } = await docWith((d) => d.obj('<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Domain [0.5 0.5] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>'));
    const one = await loadShading(d3, ref(v3));
    if (one?.kind !== 'axial') throw new Error('axial expected');
    expect(new Set(one.stops.map((s) => s.color.join())).size).toBe(1);
  });

  test('named color spaces go through the resource dictionary', async () => {
    const { paint } = await setup(
      50,
      10,
      (d) => d.obj('<< /ShadingType 2 /ColorSpace /Spot /Coords [0 0 50 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>'),
      '/S sh',
      '/Spot [/Separation /Gold /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 0.8 0] /N 1 >>]',
    );
    if (paint?.kind !== 'axial') throw new Error('axial expected');
    expect(paint.stops[paint.stops.length - 1].color).toEqual([255, 204, 0]);
  });
});

describe('function-based shadings (type 1)', () => {
  test('rasterized over Domain through Matrix, compared with MuPDF', async () => {
    const W = 160;
    const H = 120;
    const { paint, mu } = await setup(W, H, (d) => {
      const fn = d.stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]', new TextEncoder().encode('{ 2 copy mul 3 1 roll exch 1 exch sub exch }'));
      return d.obj(`<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [100 0 20 80 30 20] /Function ${fn} 0 R >>`);
    });
    expect(paint?.kind).toBe('raster');
    const p = paint as Raster2;
    expect(p.bbox).toEqual([30, 20, 150, 100]);
    const ours = rasterize(p, W, H);
    const c = compare(ours, mu, W, H);
    expect(c.n).toBeGreaterThan(5000);
    expect(c.mean).toBeLessThan(1.5);
    expect(c.p99).toBeLessThanOrEqual(4);
    // Nothing outside the parallelogram.
    expect(ours[(5 * W + 5) * 4 + 3]).toBe(0);
    // Large rasters interpolate between function samples.
    const big = p.render([10, 0, 0, -10, 0, 1200], 1600, 1200);
    expect(big.length).toBe(1600 * 1200 * 4);
  });
});

/** An RGB free-form mesh: two triangles, the second sharing an edge via flag 1 and flag 2. */
const bpc16 = (v: number, lo: number, hi: number): [number, number] => [((v - lo) / (hi - lo)) * 65535, 16];
const c8 = (v: number): [number, number] => [v * 255, 8];

describe('mesh shadings', () => {
  test('type 4: free-form triangles with edge flags, compared with MuPDF', async () => {
    const W = 200;
    const H = 150;
    const v = (f: number, x: number, y: number, r: number, g: number, b: number): [number, number][] => [[f, 8], bpc16(x, 0, 200), bpc16(y, 0, 200), c8(r), c8(g), c8(b)];
    const data = mesh([v(0, 10, 10, 1, 0, 0), v(0, 190, 20, 0, 1, 0), v(0, 60, 140, 0, 0, 1), v(1, 180, 130, 1, 1, 0), v(2, 120, 60, 0, 1, 1)]);
    const { paint, mu } = await setup(W, H, (d) => d.stream('/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 200 0 200 0 1 0 1 0 1]', data));
    const p = paint as Raster2;
    expect(p.kind).toBe('raster');
    [10, 10, 190, 140].forEach((v, i) => expect(p.bbox![i]).toBeCloseTo(v, 2));
    const c = compare(rasterize(p, W, H), mu, W, H);
    expect(c.n).toBeGreaterThan(8000);
    expect(c.mean).toBeLessThan(1.5);
    expect(c.p99).toBeLessThanOrEqual(4);
  });

  test('type 4 with a parametric function in CMYK', async () => {
    const W = 120;
    const H = 120;
    const v = (x: number, y: number, t: number): [number, number][] => [[0, 8], bpc16(x, 0, 120), bpc16(y, 0, 120), [t * 65535, 16]];
    const data = mesh([v(5, 5, 0), v(115, 10, 0.5), v(20, 115, 1), v(115, 10, 0.5), v(20, 115, 1), v(110, 110, 0.2)]);
    const { paint, mu } = await setup(W, H, (d) => d.stream('/ShadingType 4 /ColorSpace /DeviceCMYK /BitsPerCoordinate 16 /BitsPerComponent 16 /BitsPerFlag 8 /Decode [0 120 0 120 0 1] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0.2 0.9 0] /C1 [0.9 0.1 0 0.3] /N 1.5 >>', data));
    const c = compare(rasterize(paint, W, H), mu, W, H);
    expect(c.n).toBeGreaterThan(5000);
    expect(c.mean).toBeLessThan(3);
    expect(c.p99).toBeLessThanOrEqual(10);
  });

  test('type 5: lattice, Lab colors interpolated per pixel, compared with MuPDF', async () => {
    const W = 160;
    const H = 160;
    const rows: [number, number][][] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        const x = 10 + c * 35 + (r % 2) * 5;
        const y = 10 + r * 45;
        rows.push([bpc16(x, 0, 160), bpc16(y, 0, 160), [(40 + 15 * r) * 2.55, 8], [128 + (c - 2) * 25, 8], [128 + (r - 2) * 30, 8]]);
      }
    }
    const { paint, mu } = await setup(W, H, (d) => d.stream('/ShadingType 5 /ColorSpace [/Lab << /WhitePoint [0.9642 1 0.8249] /Range [-128 127 -128 127] >>] /BitsPerCoordinate 16 /BitsPerComponent 8 /VerticesPerRow 5 /Decode [0 160 0 160 0 100 -128 127 -128 127]', mesh(rows)));
    const c = compare(rasterize(paint, W, H), mu, W, H);
    // MuPDF converts vertex colors to RGB and interpolates those; Lab interpolated per pixel (as
    // the spec has it) differs inside the triangles.
    expect(c.n).toBeGreaterThan(10000);
    expect(c.mean).toBeLessThan(4);
    expect(c.p99).toBeLessThanOrEqual(20);
  });

  /** Coons patch points (12) in stream order around a square with bulging edges. */
  const coons = (x0: number, y0: number, s: number, bulge: number): number[][] => [
    [x0, y0], [x0 - bulge, y0 + s / 3], [x0 - bulge, y0 + (2 * s) / 3], [x0, y0 + s], // left edge, up
    [x0 + s / 3, y0 + s + bulge], [x0 + (2 * s) / 3, y0 + s + bulge], [x0 + s, y0 + s], // top edge, right
    [x0 + s + bulge, y0 + (2 * s) / 3], [x0 + s + bulge, y0 + s / 3], [x0 + s, y0], // right edge, down
    [x0 + (2 * s) / 3, y0 - bulge], [x0 + s / 3, y0 - bulge], // bottom edge, left
  ];

  test('type 6: Coons patches with shared edges (flags 0-3), compared with MuPDF', async () => {
    const W = 220;
    const H = 220;
    const pt = (p: number[]): [number, number][] => [bpc16(p[0], -20, 240), bpc16(p[1], -20, 240)];
    const col = (r: number, g: number, b: number): [number, number][] => [c8(r), c8(g), c8(b)];
    const first = coons(40, 40, 70, 12);
    // Each flagged patch takes an edge of the previous one as its p00..p03 and adds 8 points.
    const rec: [number, number][][] = [
      [[0, 8], ...first.flatMap(pt), ...col(1, 0, 0), ...col(0, 1, 0), ...col(0, 0, 1), ...col(1, 1, 0)],
      // Flag 2: the first patch's right edge (p33 .. p30, downwards); this one extends to the right.
      [[2, 8], ...[[140, 35], [170, 35], [200, 40], [205, 63], [205, 87], [200, 110], [170, 115], [140, 115]].flatMap(pt), ...col(1, 0, 1), ...col(0, 1, 1)],
      // Flag 1: that patch's p03 .. p33 (its bottom edge); this one extends downwards.
      [[1, 8], ...[[203, 30], [203, 15], [200, 5], [170, 2], [140, 2], [110, 5], [107, 18], [107, 30]].flatMap(pt), ...col(1, 1, 1), ...col(0.2, 0.2, 0.2)],
      // Flag 3: that patch's p30 .. p00 (its left edge, upwards); this one extends to the left.
      [[3, 8], ...[[85, 26], [60, 26], [40, 26], [38, 18], [38, 10], [40, 5], [63, 3], [87, 3]].flatMap(pt), ...col(0.5, 0, 0), ...col(0, 0, 0.5)],
    ];
    const { paint, mu } = await setup(W, H, (d) => d.stream('/ShadingType 6 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [-20 240 -20 240 0 1 0 1 0 1]', mesh(rec)));
    const ours = rasterize(paint, W, H);
    const c = compare(ours, mu, W, H);
    expect(c.covered).toBeGreaterThan(0.2);
    expect(c.n).toBeGreaterThan(8000);
    expect(c.mean).toBeLessThan(3);
    expect(c.p99).toBeLessThanOrEqual(16);
  });

  test('type 7: a tensor-product patch with moved inner points, compared with MuPDF', async () => {
    const W = 200;
    const H = 200;
    const pt = (p: number[]): [number, number][] => [bpc16(p[0], 0, 200), bpc16(p[1], 0, 200)];
    const boundary = coons(30, 30, 140, 20);
    const inner = [[60, 60], [90, 150], [150, 140], [140, 90]];
    const rec: [number, number][][] = [[[0, 8], ...boundary.flatMap(pt), ...inner.flatMap(pt), c8(0), c8(0.33), c8(1), c8(0.66)]];
    const { paint, mu } = await setup(W, H, (d) => d.stream('/ShadingType 7 /ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 200 0 200 0 1]', mesh(rec)));
    const c = compare(rasterize(paint, W, H), mu, W, H);
    expect(c.n).toBeGreaterThan(10000);
    expect(c.mean).toBeLessThan(2);
    expect(c.p99).toBeLessThanOrEqual(8);
  });

  test('patch subdivision follows the device size and stays bounded', async () => {
    const pt = (p: number[]): [number, number][] => [bpc16(p[0], -10, 110), bpc16(p[1], -10, 110)];
    const rec: [number, number][][] = [];
    for (let i = 0; i < 3000; i++) rec.push([[0, 8], ...coons((i % 50) * 2, Math.floor(i / 50) * 1.5, 2, 0.5).flatMap(pt), c8(i % 2), c8(0.5), c8(1), c8(0)]);
    const { doc, value } = await docWith((d) => d.stream('/ShadingType 6 /ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [-10 110 -10 110 0 1]', mesh(rec)));
    const p = (await loadShading(doc, ref(value))) as Raster2;
    const t0 = performance.now();
    const out = p.render([20, 0, 0, -20, 0, 2000], 2000, 2000);
    expect(performance.now() - t0).toBeLessThan(10000);
    let covered = 0;
    for (let i = 3; i < out.length; i += 4) if (out[i]) covered++;
    expect(covered).toBeGreaterThan(2000 * 1800 * 0.9);
  });

  test('damaged mesh data: partial meshes, nothing thrown', async () => {
    const v = (f: number, x: number, y: number, g: number): [number, number][] => [[f, 8], bpc16(x, 0, 100), bpc16(y, 0, 100), c8(g)];
    const good = mesh([v(0, 0, 0, 0), v(0, 100, 0, 0.5), v(0, 0, 100, 1), v(1, 100, 100, 0.2)]);
    const dict = '/ShadingType 4 /ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1]';
    for (const data of [good.subarray(0, good.length - 3), good.subarray(0, 10), new Uint8Array(0), Uint8Array.from({ length: 999 }, (_, i) => (i * 7919) & 255)]) {
      const { doc, value } = await docWith((d) => d.stream(dict, data));
      const p = await loadShading(doc, ref(value));
      if (p) expect((p as Raster2).render([1, 0, 0, -1, 0, 100], 100, 100).length).toBe(40000);
    }
    // Flags before any triangle, flag values out of range, bad bit depths.
    const { doc, value } = await docWith((d) => d.stream(dict, mesh([v(1, 0, 0, 0), v(7, 1, 1, 1), ...[...good].map((b) => [[b, 8]] as [number, number][])])));
    expect(await loadShading(doc, ref(value))).toBeDefined();
    for (const bad of [dict.replace('/BitsPerCoordinate 16', '/BitsPerCoordinate 7'), dict.replace('/BitsPerFlag 8', '/BitsPerFlag 3'), dict.replace(' /Decode [0 100 0 100 0 1]', ''), dict.replace('/ShadingType 4', '/ShadingType 5')]) {
      const r = await docWith((d) => d.stream(bad, good));
      expect(await loadShading(r.doc, ref(r.value))).toBeUndefined();
    }
    // Patches: truncated, and a flag without a previous patch.
    const pdict = '/ShadingType 6 /ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1]';
    const pt = (p: number[]): [number, number][] => [bpc16(p[0], 0, 100), bpc16(p[1], 0, 100)];
    const patch = mesh([[[0, 8], ...coons(10, 10, 50, 5).flatMap(pt), c8(0), c8(1), c8(0), c8(1)]]);
    const cut = await docWith((d) => d.stream(pdict, patch.subarray(0, 30)));
    expect(await loadShading(cut.doc, ref(cut.value))).toBeUndefined();
    const flagged = await docWith((d) => d.stream(pdict, mesh([[[1, 8], ...coons(10, 10, 50, 5).slice(4).flatMap(pt), c8(0), c8(1)]])));
    expect(await loadShading(flagged.doc, ref(flagged.value))).toBeUndefined();
    // Degenerate transforms render nothing.
    const ok = await docWith((d) => d.stream(dict, good));
    const p = (await loadShading(ok.doc, ref(ok.value))) as Raster2;
    expect(p.render([0, 0, 0, 0, 0, 0], 50, 50).some((x) => x)).toBe(false);
    expect(p.render([1e300, 0, 0, 1e300, 0, 0], 50, 50).length).toBe(10000);
    expect(p.render([NaN, 0, 0, 1, 0, 0], 20, 20).some((x) => x)).toBe(false);
  });
});

describe('shared behaviour', () => {
  test('Background is converted; without /BBox the mesh bounds are the extent unless a background is set', async () => {
    const v = (x: number, y: number): [number, number][] => [[0, 8], bpc16(x, 0, 100), bpc16(y, 0, 100), c8(0.5)];
    const data = mesh([v(10, 20), v(90, 20), v(50, 80)]);
    const dict = '/ShadingType 4 /ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1]';
    const a = await docWith((d) => d.stream(dict, data));
    const pa = (await loadShading(a.doc, ref(a.value))) as Raster2;
    [10, 20, 90, 80].forEach((v, i) => expect(pa.bbox![i]).toBeCloseTo(v, 2));
    const b = await docWith((d) => d.stream(dict + ' /Background [0.2]', data));
    const pb = (await loadShading(b.doc, ref(b.value))) as Raster2;
    expect(pb.bbox).toBeUndefined();
    expect(pb.background).toEqual([51, 51, 51]);
    const c = await docWith((d) => d.stream(dict + ' /BBox [100 100 0 0] /Background [0.2 0.3]', data));
    const pc = (await loadShading(c.doc, ref(c.value))) as Raster2;
    expect(pc.bbox).toEqual([0, 0, 100, 100]);
    expect(pc.background).toEqual([51, 51, 51]);
  });

  test('a /None separation paints nothing: unusable', async () => {
    const { doc, value } = await docWith((d) => d.obj('<< /ShadingType 2 /ColorSpace [/Separation /None /DeviceGray << /FunctionType 2 /Domain [0 1] /N 1 >>] /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /N 1 >> >>'));
    expect(await loadShading(doc, ref(value))).toBeUndefined();
  });
});

describe('garbage', () => {
  test('random shadings never throw; rasters have the requested size', async () => {
    const g = new Garbage(5);
    let loaded = 0;
    for (let i = 0; i < 250; i++) {
      const type = 1 + g.int(7);
      let dict = `/ShadingType ${type} /ColorSpace ${g.pick(['/DeviceRGB', '/DeviceGray', '/DeviceCMYK', '[/Indexed /DeviceRGB 1 <FF000000FF00>]', g.value()])}`;
      for (const k of ['Coords', 'Domain', 'Extend', 'Matrix', 'BBox', 'Background', 'Decode']) if (g.int(3)) dict += ` /${k} ${g.value()}`;
      if (g.int(4)) dict += ` /Function ${g.pick(['<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >>', '<< /FunctionType 2 /Domain [0 1 0 1] /C1 [1 0.5 0] /N 2 >>', g.value()])}`;
      if (type >= 4) {
        dict += ` /BitsPerCoordinate ${g.pick([8, 16, 32, 1, 5])} /BitsPerComponent ${g.pick([8, 16, 4, 1])} /BitsPerFlag ${g.pick([8, 2, 4])} /VerticesPerRow ${g.pick([2, 3, 0, 100])}`;
        if (g.int(2)) dict += ` /Decode [${Array.from({ length: 10 }, () => g.pick(['0', '1', '100', '-50', '0.5'])).join(' ')}]`;
      }
      const data = g.bytes(g.int(600));
      const { doc, value } = await docWith((d) => d.stream(dict, data));
      const p = await loadShading(doc, ref(value));
      if (!p) continue;
      loaded++;
      if (p.kind === 'raster') {
        const w = 1 + g.int(60);
        const h = 1 + g.int(60);
        const m = [g.int(3) - 1 || 0.5, g.int(3) / 2, g.int(3) / 3, g.int(3) - 1, g.int(40), g.int(40)];
        expect(p.render(m, w, h).length).toBe(w * h * 4);
      } else {
        for (const s of p.stops) {
          expect(s.offset >= 0 && s.offset <= 1).toBe(true);
          for (const c of s.color) expect(c >= 0 && c <= 255).toBe(true);
        }
      }
    }
    expect(loaded).toBeGreaterThan(20);
  });
});
