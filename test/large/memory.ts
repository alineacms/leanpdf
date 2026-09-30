/**
 * Memory-bound check on a large (> 500 MB) PDF. Not part of `bun test`; run with
 * `bun run test:large`. Generates the file once (streamed to disk), then compresses it
 *   1. with the CLI (NodeFileSource + NodeFileSink + SharpImageCodec) under Bun and Node, and
 *   2. through the Blob I/O path (BlobSource over a file-backed Blob -> WritableStreamSink),
 * recording peak RSS for each, and validates the outputs with `qpdf --check`.
 *
 * Env: LARGE_PDF_MB (default 600), LARGE_PDF_DIR (default test/.corpus), MAX_RSS_MB (default 400).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

const TARGET_MB = Number(process.env.LARGE_PDF_MB ?? 600);
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB ?? 400);
const dir = process.env.LARGE_PDF_DIR ?? new URL('../.corpus/', import.meta.url).pathname;
const input = `${dir}/large-${TARGET_MB}mb.pdf`;
const root = new URL('../../', import.meta.url).pathname;

async function noisyPhoto(width: number, height: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  let s = 12345;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const n = (s >>> 24) & 63;
      px[i++] = (128 + 100 * Math.sin(x / 90) + n) & 255;
      px[i++] = (128 + 100 * Math.cos(y / 70) + n) & 255;
      px[i++] = (128 + 80 * Math.sin((x + y) / 130) + n) & 255;
    }
  }
  return px;
}

async function generate(): Promise<void> {
  await mkdir(dir, { recursive: true });
  console.log(`generating ${input} (~${TARGET_MB} MB)...`);
  const W = 4000;
  const H = 3000;
  const raw = await noisyPhoto(W, H);
  const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
  // A Flate image with PNG Up predictor, to exercise the pixel path (36 MB decoded).
  const rowLen = W * 3 + 1;
  const filtered = Buffer.alloc(rowLen * H);
  for (let y = 0; y < H; y++) {
    filtered[y * rowLen] = 2;
    for (let x = 0; x < W * 3; x++) filtered[y * rowLen + 1 + x] = (raw[y * W * 3 + x] - (y ? raw[(y - 1) * W * 3 + x] : 0)) & 255;
  }
  const flate = deflateSync(filtered, { level: 1 });

  const fh = await open(input, 'w');
  let pos = 0;
  const offsets: number[] = [];
  const write = async (s: string | Uint8Array) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    await fh.write(b, 0, b.length, pos);
    pos += b.length;
  };
  const obj = async (num: number, head: string, data?: Uint8Array) => {
    offsets[num] = pos;
    await write(`${num} 0 obj\n${head}\n`);
    if (data) {
      await write('stream\n');
      await write(data);
      await write('\nendstream\n');
    }
    await write('endobj\n');
  };
  await write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pages = Math.ceil((TARGET_MB * 1048576) / ((jpeg.length * 9 + flate.length) / 10));
  const kids: string[] = [];
  let num = 3;
  for (let p = 0; p < pages; p++) {
    const page = num++;
    const content = num++;
    const img = num++;
    kids.push(`${page} 0 R`);
    const isFlate = p % 10 === 9;
    const draw = `q 500 0 0 375 50 200 cm /Im Do Q BT /F1 24 Tf 50 100 Td (Page ${p + 1}) Tj ET`;
    await obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im ${img} 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${content} 0 R >>`);
    await obj(content, `<< /Length ${draw.length} >>`, Buffer.from(draw, 'latin1'));
    if (isFlate) {
      await obj(img, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${W} >> /Length ${flate.length} >>`, flate);
    } else {
      await obj(img, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    }
  }
  await obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  await obj(2, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`);
  const xref = pos;
  let table = `xref\n0 ${num}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < num; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  await write(table + `trailer\n<< /Size ${num} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  await fh.close();
  console.log(`  ${pages} pages, ${(pos / 1048576).toFixed(0)} MB (jpeg ${(jpeg.length / 1048576).toFixed(1)} MB, flate ${(flate.length / 1048576).toFixed(1)} MB each)`);
}

function qpdfCheck(file: string): string {
  const r = spawnSync('qpdf', ['--check', file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) return 'qpdf not available';
  if (r.status !== 0) throw new Error(`qpdf --check failed (${r.status}) on ${file}:\n${r.stdout}\n${r.stderr}`);
  return 'qpdf --check ok';
}

interface Result {
  label: string;
  seconds: number;
  peakMb: number;
  outMb: number;
}

function runCli(runtime: 'bun' | 'node'): Result {
  const out = `${dir}/large-out-${runtime}.pdf`;
  const r = spawnSync(runtime, [`${root}src/cli.ts`, input, out, '--json'], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`${runtime} CLI failed:\n${r.stderr}`);
  const rep = JSON.parse(r.stdout);
  console.log(`  ${runtime}: ${qpdfCheck(out)}; ${rep.imagesRecompressed}/${rep.imagesSeen} images recompressed`);
  return { label: `CLI (${runtime}, NodeFileSource/NodeFileSink)`, seconds: rep.seconds, peakMb: rep.peakRssBytes / 1048576, outMb: rep.outputBytes / 1048576 };
}

/** The Blob I/O path, in a child process so its peak RSS is measured in isolation. */
function runBlobPath(): Result {
  const out = `${dir}/large-out-blob.pdf`;
  const script = `
    import { compressPdf, BlobSource, WritableStreamSink } from '${root}src/index.ts';
    import { SharpImageCodec } from '${root}src/sharp.ts';
    import { createWriteStream } from 'node:fs';
    import { Writable } from 'node:stream';
    const t = performance.now();
    const sink = new WritableStreamSink(Writable.toWeb(createWriteStream(${JSON.stringify(out)})));
    const rep = await compressPdf(new BlobSource(Bun.file(${JSON.stringify(input)})), sink, { codec: new SharpImageCodec() });
    console.log(JSON.stringify({ ...rep, seconds: (performance.now() - t) / 1000, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
  `;
  const r = spawnSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 16 << 20, cwd: root });
  if (r.status !== 0) throw new Error(`blob path failed:\n${r.stderr}`);
  const rep = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
  console.log(`  blob: ${qpdfCheck(out)}`);
  return { label: 'Blob I/O (bun, BlobSource/WritableStreamSink)', seconds: rep.seconds, peakMb: rep.peakRssBytes / 1048576, outMb: rep.outputBytes / 1048576 };
}

if (!existsSync(input)) await generate();
const inMb = statSync(input).size / 1048576;
console.log(`input: ${inMb.toFixed(0)} MB`);
const results = [runCli('bun'), runCli('node'), runBlobPath()];
console.log('\n| path | time | peak RSS | output |\n|---|---|---|---|');
for (const r of results) console.log(`| ${r.label} | ${r.seconds.toFixed(1)} s | ${r.peakMb.toFixed(0)} MB | ${r.outMb.toFixed(1)} MB |`);
const worst = Math.max(...results.map((r) => r.peakMb));
if (worst > MAX_RSS_MB) {
  console.error(`\npeak RSS ${worst.toFixed(0)} MB exceeds ${MAX_RSS_MB} MB`);
  process.exit(1);
}
console.log(`\nOK: peak RSS stayed under ${MAX_RSS_MB} MB for a ${inMb.toFixed(0)} MB input`);
void Writable;
void createWriteStream;
