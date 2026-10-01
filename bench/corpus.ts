/**
 * Benchmark corpus, generated deterministically so anyone can reproduce the numbers:
 *   brochure.pdf  12 pages of photo spreads: 24 large JPEG photos, text, vector art
 *   scan.pdf      12 scanned A4 pages at 300 dpi: grayscale Flate images
 *   report.pdf    40 pages of text and vector charts with a few photos and a screenshot with alpha
 *   large.pdf     ~600 MB of distinct 4000x3000 photos (JPEG and Flate) to show the memory bound
 */
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

export const CORPUS_DIR = new URL('./.corpus/', import.meta.url).pathname;

/**
 * Photo-like image: fractal (1/f) noise, which has the power spectrum of natural photographs,
 * as a luminance layer plus two smoother chroma layers.
 */
async function fractal(width: number, height: number, seed: number, octaves: number, maxScale: number): Promise<Float32Array> {
  const out = new Float32Array(width * height);
  for (let k = 0; k < octaves; k++) {
    const scale = maxScale / 2 ** k;
    const w = Math.max(2, Math.ceil(width / scale));
    const h = Math.max(2, Math.ceil(height / scale));
    const layer = await sharp({ create: { width: w, height: h, channels: 1, background: 0, noise: { type: 'gaussian', mean: 128 + ((seed * 31 + k * 7) % 5), sigma: 60 } } } as never)
      .resize(width, height, { kernel: 'cubic' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    const amp = (scale / maxScale) ** 0.55;
    for (let i = 0; i < out.length; i++) out[i] += (layer[i] - 128) * amp;
  }
  return out;
}

export async function photo(width: number, height: number, seed: number, quality: number): Promise<Buffer> {
  const L = await fractal(width, height, seed, 8, 256);
  const A = await fractal(width, height, seed + 100, 4, 256);
  const B = await fractal(width, height, seed + 200, 4, 256);
  const px = Buffer.alloc(width * height * 3);
  const tint = ((seed * 53) % 60) - 30;
  let r = seed * 7919 + 17;
  for (let i = 0, j = 0; i < L.length; i++, j += 3) {
    r = (r * 1103515245 + 12345) >>> 0;
    const grain = ((r >>> 24) & 15) - 7.5; // sensor grain
    const l = 120 + L[i] * 0.5 + grain;
    px[j] = Math.max(0, Math.min(255, l + A[i] * 0.25 + tint));
    px[j + 1] = Math.max(0, Math.min(255, l - A[i] * 0.12 - B[i] * 0.12));
    px[j + 2] = Math.max(0, Math.min(255, l + B[i] * 0.25 - tint));
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

async function rawPixels(jpeg: Buffer, gray = false): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const img = sharp(jpeg);
  const { data, info } = await (gray ? img.toColourspace('b-w') : img).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** PNG-Up predicted Flate data, like most PDF producers write. */
function flatePng(data: Buffer, width: number, height: number, channels: number): Buffer {
  const row = width * channels;
  const out = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (row + 1)] = 2;
    for (let x = 0; x < row; x++) out[y * (row + 1) + 1 + x] = (data[y * row + x] - (y ? data[(y - 1) * row + x] : 0)) & 255;
  }
  return deflateSync(out, { level: 6 });
}

/** A scanned page: dark text-like strokes on paper with grain, gray 8-bit. */
function scanPage(width: number, height: number, seed: number): Buffer {
  const px = Buffer.alloc(width * height);
  let s = seed * 7919 + 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;
  for (let i = 0; i < px.length; i++) px[i] = 236 + ((rnd() * 18) | 0);
  const lineH = 50;
  for (let y = 300; y < height - 300; y += lineH) {
    let x = 250;
    while (x < width - 400) {
      const w = 40 + ((rnd() * 160) | 0);
      for (let yy = y; yy < y + 28; yy++) {
        for (let xx = x; xx < x + w; xx++) if (rnd() < 0.55) px[yy * width + xx] = 20 + ((rnd() * 60) | 0);
      }
      x += w + 25;
    }
  }
  return px;
}

class Writer {
  pos = 0;
  offsets: number[] = [];
  private chunks: Buffer[] = [];
  private fh: Awaited<ReturnType<typeof open>> | null = null;
  num = 3;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async start(): Promise<void> {
    this.fh = await open(this.path, 'w');
    await this.put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  }
  async put(b: string | Buffer): Promise<void> {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    await this.fh!.write(buf, 0, buf.length, this.pos);
    this.pos += buf.length;
  }
  async obj(num: number, head: string, data?: Buffer): Promise<void> {
    this.offsets[num] = this.pos;
    await this.put(`${num} 0 obj\n${head}\n`);
    if (data) {
      await this.put('stream\n');
      await this.put(data);
      await this.put('\nendstream\n');
    }
    await this.put('endobj\n');
  }
  async finish(kids: number[]): Promise<void> {
    await this.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    await this.obj(2, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`);
    const xref = this.pos;
    let t = `xref\n0 ${this.num}\n0000000000 65535 f\r\n`;
    for (let n = 1; n < this.num; n++) t += `${String(this.offsets[n]).padStart(10, '0')} 00000 n\r\n`;
    await this.put(t + `trailer\n<< /Size ${this.num} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    await this.fh!.close();
  }
}

const FONT = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >> >>';
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris';

function textBlock(x: number, y: number, lines: number, size = 10): string {
  let s = `BT /F2 ${size} Tf ${size * 1.3} TL ${x} ${y} Td `;
  for (let i = 0; i < lines; i++) s += `(${LOREM.slice((i * 17) % 60, ((i * 17) % 60) + 95)}) Tj T* `;
  return s + 'ET ';
}

function chart(x: number, y: number, seed: number): string {
  let s = `q 0.2 0.2 0.2 RG 1 w ${x} ${y} m ${x} ${y + 150} l ${x} ${y} m ${x + 250} ${y} l S `;
  for (let i = 0; i < 8; i++) {
    const h = 20 + ((i * 37 + seed * 13) % 120);
    s += `${0.2 + i * 0.08} 0.4 ${0.8 - i * 0.07} rg ${x + 10 + i * 30} ${y} 22 ${h} re f `;
  }
  return s + 'Q ';
}

async function brochure(path: string): Promise<void> {
  const w = new Writer(path);
  await w.start();
  const kids: number[] = [];
  for (let p = 0; p < 12; p++) {
    const page = w.num++;
    const content = w.num++;
    const a = w.num++;
    const b = w.num++;
    kids.push(page);
    const draw =
      `q 500 0 0 333 50 460 cm /A Do Q q 240 0 0 160 50 250 cm /B Do Q ` +
      `BT /F1 22 Tf 50 810 Td (Brochure page ${p + 1}) Tj ET ${textBlock(310, 400, 12, 9)}${textBlock(50, 220, 14)}` +
      `q 0.9 0.5 0.1 rg 300 250 250 8 re f Q`;
    await w.obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 842] /Resources ${FONT} /XObject << /A ${a} 0 R /B ${b} 0 R >> >> /Contents ${content} 0 R >>`);
    await w.obj(content, `<< /Length ${draw.length} >>`, Buffer.from(draw, 'latin1'));
    for (const [n, width, height] of [
      [a, 3600, 2400],
      [b, 2400, 1600],
    ]) {
      const jpg = await photo(width, height, p * 2 + (n === a ? 0 : 1), 92);
      await w.obj(n, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
    }
  }
  await w.finish(kids);
}

async function scan(path: string): Promise<void> {
  const w = new Writer(path);
  await w.start();
  const kids: number[] = [];
  const W = 2480;
  const H = 3508;
  for (let p = 0; p < 12; p++) {
    const page = w.num++;
    const content = w.num++;
    const img = w.num++;
    kids.push(page);
    const draw = 'q 595 0 0 842 0 0 cm /S Do Q';
    const data = flatePng(scanPage(W, H, p + 1), W, H, 1);
    await w.obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /S ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    await w.obj(content, `<< /Length ${draw.length} >>`, Buffer.from(draw));
    await w.obj(img, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /Columns ${W} >> /Length ${data.length} >>`, data);
  }
  await w.finish(kids);
}

async function report(path: string): Promise<void> {
  const w = new Writer(path);
  await w.start();
  const kids: number[] = [];
  const photos = [w.num++, w.num++, w.num++];
  const shot = w.num++;
  const mask = w.num++;
  for (let i = 0; i < 3; i++) {
    const jpg = await photo(1600, 1067, 40 + i, 88);
    await w.obj(photos[i], `<< /Type /XObject /Subtype /Image /Width 1600 /Height 1067 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  }
  // A screenshot-like RGB image with an alpha channel (SMask).
  const px = await rawPixels(await photo(1400, 900, 77, 95));
  for (let y = 0; y < 900; y += 60) px.data.fill(245, y * 1400 * 3, (y + 30) * 1400 * 3);
  const alpha = Buffer.alloc(1400 * 900, 255);
  for (let y = 0; y < 900; y++) for (let x = 0; x < 40; x++) alpha[y * 1400 + x] = alpha[y * 1400 + 1399 - x] = x * 6;
  const shotData = flatePng(px.data, 1400, 900, 3);
  const maskData = flatePng(alpha, 1400, 900, 1);
  await w.obj(mask, `<< /Type /XObject /Subtype /Image /Width 1400 /Height 900 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /Columns 1400 >> /Length ${maskData.length} >>`, maskData);
  await w.obj(shot, `<< /Type /XObject /Subtype /Image /Width 1400 /Height 900 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${mask} 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 3 /Columns 1400 >> /Length ${shotData.length} >>`, shotData);
  for (let p = 0; p < 40; p++) {
    const page = w.num++;
    const content = w.num++;
    kids.push(page);
    let draw = `BT /F1 16 Tf 50 800 Td (Quarterly report, section ${p + 1}) Tj ET ${textBlock(50, 770, 30)}`;
    let xobj = '';
    if (p % 10 === 0) {
      const i = p / 10;
      if (i < 3) {
        draw += `q 300 0 0 200 150 120 cm /P Do Q`;
        xobj = `/XObject << /P ${photos[i]} 0 R >>`;
      } else {
        draw += `q 420 0 0 270 90 100 cm /P Do Q`;
        xobj = `/XObject << /P ${shot} 0 R >>`;
      }
    } else {
      draw += chart(60, 120, p) + chart(320, 120, p + 3);
    }
    await w.obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${FONT} ${xobj} >> /Contents ${content} 0 R >>`);
    const data = deflateSync(Buffer.from(draw, 'latin1'));
    await w.obj(content, `<< /Length ${data.length} /Filter /FlateDecode >>`, data);
  }
  await w.finish(kids);
}

async function large(path: string): Promise<void> {
  const w = new Writer(path);
  await w.start();
  const kids: number[] = [];
  const target = 600 * 1048576;
  // A different photo on every page: tools that deduplicate identical images get no free win.
  for (let p = 0; w.pos < target; p++) {
    const jpg = await photo(4000, 3000, 100 + p, 97);
    const flate = p % 4 === 3 ? flatePng((await rawPixels(jpg)).data, 4000, 3000, 3) : undefined;
    const page = w.num++;
    const content = w.num++;
    const img = w.num++;
    kids.push(page);
    const draw = `q 500 0 0 375 50 300 cm /Im Do Q BT /F1 24 Tf 50 100 Td (Page ${p + 1}) Tj ET`;
    await w.obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources ${FONT} /XObject << /Im ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    await w.obj(content, `<< /Length ${draw.length} >>`, Buffer.from(draw, 'latin1'));
    if (flate) {
      await w.obj(img, `<< /Type /XObject /Subtype /Image /Width 4000 /Height 3000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 3 /Columns 4000 >> /Length ${flate.length} >>`, flate);
    } else {
      await w.obj(img, `<< /Type /XObject /Subtype /Image /Width 4000 /Height 3000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
    }
  }
  await w.finish(kids);
}

export const CORPUS: Record<string, (path: string) => Promise<void>> = {
  'brochure.pdf': brochure,
  'scan.pdf': scan,
  'report.pdf': report,
  'large.pdf': large,
};

export async function ensureCorpus(names = Object.keys(CORPUS)): Promise<string[]> {
  await mkdir(CORPUS_DIR, { recursive: true });
  const paths: string[] = [];
  for (const name of names) {
    const path = CORPUS_DIR + name;
    if (!existsSync(path)) {
      process.stderr.write(`generating ${name}...\n`);
      await CORPUS[name](path);
    }
    paths.push(path);
  }
  return paths;
}

if (import.meta.main) await ensureCorpus(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
