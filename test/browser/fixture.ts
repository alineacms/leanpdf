/**
 * Minimal PDF fixture generator for the browser end-to-end and demo tests. Hand-written objects
 * and a classic xref table; the images are photo-like synthetic pictures (see
 * test/contract/contract.ts `synthesize`), so the output is deterministic.
 */
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { synthesize, type SynthSpec } from '../contract/contract.ts';

export interface FixtureImage {
  /** Object number of the image XObject. */
  num: number;
  width: number;
  height: number;
  filter: string;
  /** Expected to be recompressed with the default options. */
  recompressible: boolean;
}

export interface FixturePdf {
  bytes: Uint8Array;
  pages: number;
  images: FixtureImage[];
}

const enc = new TextEncoder();

/** PNG-predictor encode (PDF /Predictor 10..15): each row gets a filter byte, cycling 0..4. */
export function pngPredict(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const row = width * bpp;
  const out = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const type = y % 5;
    const o = y * (row + 1);
    out[o] = type;
    const cur = y * row;
    const prev = (y - 1) * row;
    for (let i = 0; i < row; i++) {
      const x = data[cur + i];
      const a = i >= bpp ? data[cur + i - bpp] : 0;
      const b = y > 0 ? data[prev + i] : 0;
      const c = y > 0 && i >= bpp ? data[prev + i - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + 1 + i] = (x - pred) & 0xff;
    }
  }
  return out;
}

class PdfBuilder {
  private chunks: Uint8Array[] = [];
  private pos = 0;
  readonly offsets: number[] = [];

  push(x: string | Uint8Array): void {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    this.chunks.push(b);
    this.pos += b.length;
  }

  obj(num: number, body: string, stream?: Uint8Array): void {
    this.offsets[num] = this.pos;
    this.push(`${num} 0 obj\n${body}\n`);
    if (stream) {
      this.push('stream\n');
      this.push(stream);
      this.push('\nendstream\n');
    }
    this.push('endobj\n');
  }

  finish(root: number, info: number): Uint8Array {
    const size = this.offsets.length;
    const xref = this.pos;
    let s = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
    for (let n = 1; n < size; n++) s += `${String(this.offsets[n]).padStart(10, '0')} 00000 n\r\n`;
    s += `trailer\n<< /Size ${size} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.push(s);
    const out = new Uint8Array(this.pos);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const spec = (width: number, height: number, components: 1 | 3, seed: number): SynthSpec => ({ width, height, components, pattern: 'photo', seed });

/**
 * Two pages:
 *  - page 1: a 2400x1800 RGB /DCTDecode photo and a 1500x1000 RGB /FlateDecode image with a PNG
 *    predictor (rows cycle through all five PNG filters);
 *  - page 2: a 1200x1600 /DeviceGray Flate image without predictor, and a small 64x64 image that
 *    stays below minImageBytes.
 */
export async function buildFixturePdf(): Promise<FixturePdf> {
  const jpegSpec = spec(2400, 1800, 3, 101);
  const jpeg = await sharp(synthesize(jpegSpec), { raw: { width: 2400, height: 1800, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const rgb = spec(1500, 1000, 3, 102);
  const flateRgb = deflateSync(pngPredict(synthesize(rgb), rgb.width, rgb.height, 3));
  const gray = spec(1200, 1600, 1, 103);
  const flateGray = deflateSync(synthesize(gray));
  const small = spec(64, 64, 3, 104);
  const flateSmall = deflateSync(synthesize(small));

  const b = new PdfBuilder();
  b.push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R /Im2 5 0 R >> >> /Contents 6 0 R >>');
  b.obj(4, `<< /Type /XObject /Subtype /Image /Width 2400 /Height 1800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  b.obj(
    5,
    `<< /Type /XObject /Subtype /Image /Width 1500 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 1500 >> /Length ${flateRgb.length} >>`,
    flateRgb,
  );
  const c1 = enc.encode('q 540 0 0 405 36 360 cm /Im1 Do Q\nq 300 0 0 200 36 100 cm /Im2 Do Q\n');
  b.obj(6, `<< /Length ${c1.length} >>`, c1);
  b.obj(7, '<< /Title (pdf-squeeze browser fixture) /Producer (test/browser/fixture.ts) >>');
  b.obj(8, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im3 9 0 R /Im4 10 0 R >> >> /Contents 11 0 R >>');
  b.obj(9, `<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${flateGray.length} >>`, flateGray);
  b.obj(10, `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flateSmall.length} >>`, flateSmall);
  const c2 = enc.encode('q 450 0 0 600 36 150 cm /Im3 Do Q\nq 64 0 0 64 500 700 cm /Im4 Do Q\n');
  b.obj(11, `<< /Length ${c2.length} >>`, c2);
  return {
    bytes: b.finish(1, 7),
    pages: 2,
    images: [
      { num: 4, width: 2400, height: 1800, filter: 'DCTDecode', recompressible: true },
      { num: 5, width: 1500, height: 1000, filter: 'FlateDecode', recompressible: true },
      { num: 9, width: 1200, height: 1600, filter: 'FlateDecode', recompressible: true },
      { num: 10, width: 64, height: 64, filter: 'FlateDecode', recompressible: false },
    ],
  };
}

if (import.meta.main) {
  // `bun test/browser/fixture.ts out.pdf` writes the fixture, handy for trying the demo by hand.
  const out = process.argv[2] ?? 'fixture.pdf';
  await Bun.write(out, (await buildFixturePdf()).bytes);
  console.log(`wrote ${out}`);
}
