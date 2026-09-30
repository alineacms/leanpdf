import { describe, expect, test } from 'bun:test';
import type { PdfDocument } from '../../src/core/document.ts';
import { PdfName } from '../../src/core/objects.ts';
import { loadFunction, type PdfFunction } from '../../src/render/function.ts';
import { bytes } from '../support/pdfgen.ts';
import { docWith, Garbage, ref, u8 } from './objects-helper.ts';

/** Load the function defined by `add` (which returns its object number). */
async function fn(add: Parameters<typeof docWith<number>>[0]): Promise<PdfFunction | undefined> {
  const { doc, value } = await docWith(add);
  return loadFunction(doc, ref(value));
}

/** A type 4 function of `m` inputs and `n` outputs (ranges wide open). */
const calc = (src: string, m = 1, n = 1) =>
  fn((d) => d.stream(`/FunctionType 4 /Domain [${'-1000 1000 '.repeat(m)}] /Range [${'-1000000 1000000 '.repeat(n)}]`, bytes(src)));

const close = (a: number[], b: number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
};

describe('loadFunction: type 2 (exponential)', () => {
  test('interpolates C0..C1 with exponent N, clipping to Domain and Range', async () => {
    const f = (await fn((d) => d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0.5 1] /C1 [1 1 0] /N 2 >>')))!;
    close(f([0.5]), [0.25, 0.625, 0.75]);
    close(f([-3]), [0, 0.5, 1]);
    close(f([7]), [1, 1, 0]);
    const g = (await fn((d) => d.obj('<< /FunctionType 2 /Domain [0 10] /N 1 /Range [0 0.5] >>')))!;
    close(g([0.25]), [0.25]);
    close(g([4]), [0.5]);
  });

  test('reuses the output array', async () => {
    const f = (await fn((d) => d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [2] /N 1 >>')))!;
    const out: number[] = [];
    expect(f([0.25], out)).toBe(out);
    close(out, [0.5]);
  });

  test('entries may be references', async () => {
    const f = await fn((d) => {
      const c1 = d.obj('[0 1]');
      const n = d.obj('3');
      return d.obj(`<< /FunctionType 2 /Domain [0 1] /C1 ${c1} 0 R /C0 [1 1] /N ${n} 0 R >>`);
    });
    close(f!([0.5]), [0.875, 1]);
  });
});

describe('loadFunction: type 3 (stitching)', () => {
  test('selects and re-encodes sub-functions; exposes bounds', async () => {
    const f = (await fn((d) => {
      const a = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>');
      const b = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [10] /C1 [20] /N 1 >>');
      return d.obj(`<< /FunctionType 3 /Domain [0 2] /Functions [${a} 0 R ${b} 0 R] /Bounds [0.5] /Encode [0 1 1 0] >>`);
    }))!;
    close(f([0]), [0]);
    close(f([0.25]), [0.5]);
    close(f([0.5]), [20]); // bounds belong to the right-hand function
    close(f([2]), [10]);
    close(f([1.25]), [15]);
    expect(f.bounds).toEqual([0.5]);
  });

  test('Domain0 equal to Bounds0 gives the first function the single point', async () => {
    const f = (await fn((d) => {
      const a = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [5] /C1 [5] /N 1 >>');
      const b = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>');
      return d.obj(`<< /FunctionType 3 /Domain [0 1] /Functions [${a} 0 R ${b} 0 R] /Bounds [0] /Encode [0 1 0 1] >>`);
    }))!;
    close(f([0]), [5]);
    close(f([0.5]), [0.5]);
  });

  test('nested stitching bounds are mapped back', async () => {
    const f = (await fn((d) => {
      const e = d.obj('<< /FunctionType 2 /Domain [0 1] /N 1 >>');
      const inner = d.obj(`<< /FunctionType 3 /Domain [0 1] /Functions [${e} 0 R ${e} 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>`);
      return d.obj(`<< /FunctionType 3 /Domain [0 4] /Functions [${inner} 0 R ${e} 0 R] /Bounds [2] /Encode [0 1 0 1] >>`);
    }))!;
    expect(f.bounds).toEqual([1, 2]);
  });

  test('wide shared sub-function graphs load once; bounds stay bounded', async () => {
    const t0 = performance.now();
    const f = (await fn((d) => {
      let prev = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>');
      for (let level = 0; level < 6; level++) {
        const k = 40;
        const refs = Array(k).fill(`${prev} 0 R`).join(' ');
        const bounds = Array.from({ length: k - 1 }, (_, i) => ((i + 1) / k).toFixed(4)).join(' ');
        prev = d.obj(`<< /FunctionType 3 /Domain [0 1] /Functions [${refs}] /Bounds [${bounds}] /Encode [${'0 1 '.repeat(k)}] >>`);
      }
      return prev;
    }))!;
    expect(f).toBeDefined();
    expect(f.bounds!.length).toBeLessThanOrEqual(1024);
    close(f([0.5]), [f([0.5])[0]]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test('self-reference is rejected', async () => {
    expect(await fn((d) => d.setObj(5, '<< /FunctionType 3 /Domain [0 1] /Functions [5 0 R] /Bounds [] /Encode [0 1] >>') ?? 5)).toBeUndefined();
  });
});

describe('loadFunction: type 0 (sampled)', () => {
  test('1 input, 3 outputs, 8-bit samples: linear interpolation', async () => {
    const f = (await fn((d) => d.stream('/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [3] /BitsPerSample 8', u8(0, 255, 0, 255, 0, 128, 0, 0, 255))))!;
    close(f([0]), [0, 1, 0]);
    close(f([0.25]), [0.5, 0.5, 64 / 255], 1e-6);
    close(f([0.5]), [1, 0, 128 / 255]);
    close(f([1]), [0, 0, 1]);
    close(f([2]), [0, 0, 1]);
  });

  test('2 inputs: bilinear, first input varying fastest', async () => {
    // Size [2 2]: samples (0,0)=0 (1,0)=100 (0,1)=200 (1,1)=255
    const f = (await fn((d) => d.stream('/FunctionType 0 /Domain [0 1 0 1] /Range [0 255] /Decode [0 255] /Size [2 2] /BitsPerSample 8', u8(0, 100, 200, 255))))!;
    close(f([0, 0]), [0]);
    close(f([1, 0]), [100]);
    close(f([0, 1]), [200]);
    close(f([0.5, 0.5]), [138.75]);
    close(f([0.25, 1]), [213.75]);
  });

  test('bit depths 1, 2, 4, 12, 16, 24 and 32', async () => {
    const cases: [number, number[], number[]][] = [
      [1, [0b10110000], [1, 0, 1, 1]],
      [2, [0b11100100], [1, 2 / 3, 1 / 3, 0]],
      [4, [0xf0, 0x5a], [1, 0, 5 / 15, 10 / 15]],
      [12, [0xff, 0xf0, 0x00, 0x80, 0x00, 0x01], [1, 0, 0x800 / 4095, 1 / 4095]],
      [16, [0xff, 0xff, 0, 0, 0x80, 0, 0, 1], [1, 0, 0x8000 / 65535, 1 / 65535]],
      [24, [0xff, 0xff, 0xff, 0, 0, 0, 0x80, 0, 0, 0, 0, 1], [1, 0, 0x800000 / 0xffffff, 1 / 0xffffff]],
      [32, [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0x80000000 / 0xffffffff, 1 / 0xffffffff]],
    ];
    for (const [bps, data, want] of cases) {
      const f = (await fn((d) => d.stream(`/FunctionType 0 /Domain [0 3] /Range [0 1] /Size [4] /BitsPerSample ${bps} /Order 3`, Uint8Array.from(data))))!;
      close([0, 1, 2, 3].map((x) => f([x])[0]), want, 1e-7); // samples are kept as float32
    }
  });

  test('Encode and Decode', async () => {
    // Encode maps the domain onto the samples backwards; Decode scales outputs to [10, 20].
    const f = (await fn((d) => d.stream('/FunctionType 0 /Domain [0 1] /Range [0 100] /Size [2] /BitsPerSample 8 /Encode [1 0] /Decode [10 20]', u8(0, 255))))!;
    close(f([0]), [20]);
    close(f([1]), [10]);
    close(f([0.25]), [17.5]);
  });

  test('short data reads as zeros; bad parameters are rejected', async () => {
    const f = (await fn((d) => d.stream('/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [4] /BitsPerSample 8', u8(255))))!;
    close([0, 1 / 3, 1].map((x) => f([x])[0]), [1, 0, 0]);
    for (const dict of [
      '/FunctionType 0 /Domain [0 1] /Size [2] /BitsPerSample 8', // no Range
      '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 3',
      '/FunctionType 0 /Domain [0 1] /Range [0 1] /Size [0] /BitsPerSample 8',
      '/FunctionType 0 /Domain [0 1 0 1] /Range [0 1] /Size [100000 100000] /BitsPerSample 8',
      '/FunctionType 0 /Domain [0 1 0 1] /Range [0 1] /Size [2] /BitsPerSample 8',
    ]) {
      expect(await fn((d) => d.stream(dict, u8(1, 2, 3, 4)))).toBeUndefined();
    }
  });
});

describe('loadFunction: type 4 (PostScript calculator)', () => {
  const cases: [string, number[], number[]][] = [
    ['{ 2 mul 1 add }', [3], [7]],
    ['{ abs } ', [-2.5], [2.5]],
    ['{ 3 sub neg }', [1], [2]],
    ['{ 7 div }', [14], [2]],
    ['{ 7 idiv }', [-15], [-2]],
    ['{ 5 mod }', [-7], [-2]],
    ['{ 2 exp }', [3], [9]],
    ['{ sqrt }', [16], [4]],
    ['{ ln }', [Math.E], [1]],
    ['{ log }', [1000], [3]],
    ['{ sin }', [30], [0.5]],
    ['{ cos }', [60], [0.5]],
    ['{ 1 atan }', [-1], [315]],
    ['{ 0 exch atan }', [-1], [180]],
    ['{ ceiling }', [-1.5], [-1]],
    ['{ floor }', [-1.5], [-2]],
    ['{ round }', [-2.5], [-2]],
    ['{ round }', [2.5], [3]],
    ['{ truncate }', [-2.7], [-2]],
    ['{ cvi }', [3.9], [3]],
    ['{ cvr }', [3], [3]],
    ['{ 2 bitshift }', [3], [12]],
    ['{ -1 bitshift }', [-8], [-4]],
    ['{ 6 and }', [12], [4]],
    ['{ 6 or }', [12], [14]],
    ['{ 6 xor }', [12], [10]],
    ['{ not }', [5], [-6]],
    ['{ 0 gt { 1 } { 2 } ifelse }', [3], [1]],
    ['{ 0 gt { 1 } { 2 } ifelse }', [-3], [2]],
    ['{ dup 0 lt { neg } if }', [-4], [4]],
    ['{ dup 0 lt { neg } if }', [4], [4]],
    ['{ 1 eq }', [1], [1]],
    ['{ 1 ne }', [1], [0]],
    ['{ 1 ge }', [1], [1]],
    ['{ 1 le }', [2], [0]],
    ['{ 1 lt not }', [2], [1]], // not on a boolean
    ['{ pop true false or }', [0], [1]],
    ['{ pop true false xor { 5 } { 6 } ifelse }', [0], [5]],
    ['{ pop true true and false true and or { 5 } { 6 } ifelse }', [0], [5]],
    ['{ pop 1 2 3 exch }', [0], [1, 3, 2]],
    ['{ pop 1 2 3 3 copy }', [0], [1, 2, 3, 1, 2, 3]],
    ['{ pop 1 2 3 0 copy }', [0], [1, 2, 3]],
    ['{ pop 1 2 3 2 index }', [0], [1, 2, 3, 1]],
    ['{ pop 1 2 3 3 1 roll }', [0], [3, 1, 2]],
    ['{ pop 1 2 3 3 -1 roll }', [0], [2, 3, 1]],
    ['{ pop 1 2 3 4 3 5 roll }', [0], [1, 3, 4, 2]],
    ['{ pop 1 2 3 dup pop pop }', [0], [1, 2]],
    ['{ % a comment\n  1 add }', [1], [2]],
    ['{1 add dup 2 gt{2 mul}{3 mul}ifelse}', [1], [6]],
    ['{ 0 gt { 0 gt { 1 } { 2 } ifelse } { 3 } ifelse }', [5, 1], [1]],
    ['{ 0 gt { 0 gt { 1 } { 2 } ifelse } { 3 } ifelse }', [5, -1], [5, 3]],
    ['{ 0 gt { 0 gt { 1 } { 2 } ifelse } { 3 } ifelse }', [-5, 1], [2]],
  ];
  for (const [src, input, want] of cases) {
    test(`${src.replace(/\s+/g, ' ')} (${input})`, async () => {
      const f = (await fn((d) => d.stream(`/FunctionType 4 /Domain [${input.map(() => '-1000 1000').join(' ')}]`, bytes(src))))!;
      close(f(input), want);
    });
  }

  test('Range picks outputs from the top of the stack and clips them', async () => {
    const f = (await fn((d) => d.stream('/FunctionType 4 /Domain [0 1] /Range [0 1 0 5]', bytes('{ 7 8 9 }'))))!;
    close(f([0.5]), [1, 5]);
  });

  test('two inputs, Domain clipping', async () => {
    const f = (await calc('{ exch 10 mul add }', 2, 1))!;
    close(f([2, 3]), [23]);
    const g = (await fn((d) => d.stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 100]', bytes('{ exch 10 mul add }'))))!;
    close(g([5, -3]), [10]);
  });

  test('errors give zeros, not exceptions', async () => {
    for (const src of ['{ add }', '{ pop pop }', '{ 5 index }', '{ 3 1 roll }', '{ -1 copy }', '{ exch }', '{ 99 copy }']) {
      const f = (await calc(src))!;
      close(f([1]), [0]);
    }
    const deep = (await calc(`{ ${'1 '.repeat(150)} }`))!;
    close(deep([1]), [0]);
  });

  test('malformed programs are rejected', async () => {
    for (const src of ['1 add', '{ 1 add', '{ foo }', '{ { 1 } }', '{ 1 { 2 } { 3 } if }', '{ { 1 } ifelse }', '']) {
      expect(await calc(src)).toBeUndefined();
    }
  });

  test('long programs run in bounded time', async () => {
    const f = (await calc(`{ ${'1 add '.repeat(10000)} }`))!;
    close(f([0]), [10000]);
    expect(await calc(`{ ${'1 add '.repeat(40000)} }`)).toBeUndefined();
  });
});

describe('loadFunction: arrays and bad input', () => {
  test('an array of 1-output functions concatenates outputs', async () => {
    const f = (await fn((d) => {
      const a = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>');
      const b = d.obj('<< /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >>');
      return d.obj(`[${a} 0 R ${b} 0 R << /FunctionType 2 /Domain [0 1] /C0 [7] /C1 [7] /N 1 >>]`);
    }))!;
    close(f([0.25]), [0.25, 0.75, 7]);
  });

  test('unusable objects give undefined', async () => {
    const { doc } = await docWith(() => 0);
    const bad = [undefined, null, 5, new PdfName('Identity'), []];
    for (const o of bad) expect(await loadFunction(doc as PdfDocument, o)).toBeUndefined();
    expect(await fn((d) => d.obj('<< /FunctionType 7 /Domain [0 1] >>'))).toBeUndefined();
    expect(await fn((d) => d.obj('<< /FunctionType 2 /Domain [0 1] >>'))).toBeUndefined(); // no N
    expect(await fn((d) => d.obj('<< /FunctionType 4 /Domain [0 1] /Range [0 1] >>'))).toBeUndefined(); // not a stream
    expect(await fn((d) => d.obj('<< /FunctionType 3 /Domain [0 1] /Functions [] /Bounds [] /Encode [] >>'))).toBeUndefined();
  });
});

describe('loadFunction: garbage', () => {
  test('random dictionaries and data never throw; outputs are finite', async () => {
    const g = new Garbage(3);
    let loaded = 0;
    const ops = 'abs add atan ceiling cos cvi cvr div exp floor idiv ln log mod mul neg round sin sqrt sub truncate and bitshift eq false ge gt le lt ne not or true xor copy dup exch index pop roll { } if ifelse 0 1 2 -1 3.5'.split(' ');
    for (let i = 0; i < 400; i++) {
      const type = g.pick(['0', '2', '3', '4', '4', '0', '7', '(x)']);
      const keys = ['Domain', 'Range', 'Size', 'BitsPerSample', 'Encode', 'Decode', 'C0', 'C1', 'N', 'Functions', 'Bounds', 'Order'];
      let dict = `/FunctionType ${type}`;
      for (const k of keys) if (g.int(3)) dict += ` /${k} ${k === 'Functions' ? `[${g.value()} << /FunctionType 2 /Domain [0 1] /N ${g.num()} >>]` : g.value()}`;
      const data = type === '4' ? new TextEncoder().encode(`{ ${Array.from({ length: g.int(40) }, () => g.pick(ops)).join(' ')} }`) : g.bytes(g.int(64));
      const f = await fn((d) => d.stream(dict, data));
      if (!f) continue;
      loaded++;
      for (let j = 0; j < 5; j++) {
        const out = f([g.int(5) - 1, g.int(3) / 2, NaN, Infinity, -1e9].slice(0, 1 + g.int(4)));
        for (const v of out) expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(loaded).toBeGreaterThan(40);
  });
});
