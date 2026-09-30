/** Test helpers for the renderer's resource loaders: small documents built from object text. */
import type { PdfDocument } from '../../src/core/document.ts';
import { PdfRef } from '../../src/core/objects.ts';
import { openPdf } from '../../src/core/open.ts';
import { DocBuilder } from '../support/pdfgen.ts';
import { renderPdf, type Raster } from '../support/render.ts';
import { BytesSource } from '../unit/util.ts';

export const ref = (num: number): PdfRef => new PdfRef(num, 0);

/** Build a document with `add` (which defines objects and may add pages), then open it. */
export async function docWith<T>(add: (d: DocBuilder) => T): Promise<{ doc: PdfDocument; bytes: Uint8Array; value: T }> {
  const d = new DocBuilder();
  const value = add(d);
  if (!d.pages.length) d.page({ width: 10, height: 10, content: '' });
  const bytes = d.finish().build().bytes;
  return { doc: await openPdf(new BytesSource(bytes)), bytes, value };
}

/** Bytes of a binary stream from numbers. */
export const u8 = (...v: number[]): Uint8Array => Uint8Array.from(v);

/** The RGB of a MuPDF-rendered pixel. */
export function pixel(r: Raster, x: number, y: number): [number, number, number] {
  const o = (y * r.width + x) * 3;
  return [r.rgb[o], r.rgb[o + 1], r.rgb[o + 2]];
}

/** Render page 1 of `bytes` with MuPDF at 72 dpi. */
export function mupdfPage(bytes: Uint8Array): Raster {
  const r = renderPdf(bytes, 1);
  if (!r.pages[0]) throw new Error(r.messages.join('\n'));
  return r.pages[0];
}

/** Largest per-channel difference. */
export const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));

/** A seeded source of plausible-but-wrong PDF values, for robustness tests. */
export class Garbage {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    this.s = (Math.imul(this.s, 1103515245) + 12345) >>> 0;
    return Math.floor(((this.s >>> 8) / (1 << 24)) * n);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)];
  }
  num(): string {
    return this.pick(['0', '1', '-1', '0.5', '2', '255', '1000000', '-7.25', '3', '4', '16', '8', '1e3', '.1']);
  }
  /** A PDF value, sometimes nested. */
  value(depth = 0): string {
    const r = this.int(depth > 2 ? 6 : 9);
    if (r < 3) return this.num();
    if (r === 3) return this.pick(['/DeviceRGB', '/DeviceCMYK', '/DeviceGray', '/Pattern', '/None', '/All', '/Foo', '/Indexed', '/Lab']);
    if (r === 4) return this.pick(['true', 'false', 'null', '(abc)', '<00FF>']);
    if (r === 5) return `[${Array.from({ length: this.int(8) }, () => this.num()).join(' ')}]`;
    if (r === 6) return `[${Array.from({ length: this.int(5) }, () => this.value(depth + 1)).join(' ')}]`;
    return `<< ${Array.from({ length: this.int(4) }, () => `/${this.pick(['FunctionType', 'Domain', 'Range', 'N', 'C0', 'C1'])} ${this.value(depth + 1)}`).join(' ')} >>`;
  }
  bytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => this.int(256));
  }
}
