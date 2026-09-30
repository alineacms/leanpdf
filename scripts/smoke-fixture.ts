/** Writes a small PDF with a large JPEG and a Flate image, for smoke-testing the CLI. */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

const out = process.argv[2] ?? 'smoke.pdf';
const W = 1800;
const H = 1200;
const px = Buffer.alloc(W * H * 3);
for (let i = 0, y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    px[i++] = (128 + 100 * Math.sin(x / 40)) & 255;
    px[i++] = (128 + 100 * Math.cos(y / 30)) & 255;
    px[i++] = ((x ^ y) * 3) & 255;
  }
}
const jpeg = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 97 }).toBuffer();
const flate = deflateSync(px);

const parts: Buffer[] = [];
const offsets: number[] = [];
let pos = 0;
const put = (b: Buffer | string) => {
  const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
  parts.push(buf);
  pos += buf.length;
};
const obj = (num: number, head: string, data?: Buffer) => {
  offsets[num] = pos;
  put(`${num} 0 obj\n${head}\n`);
  if (data) {
    put('stream\n');
    put(data);
    put('\nendstream\n');
  }
  put('endobj\n');
};
put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
const draw = 'q 500 0 0 333 50 50 cm /A Do Q q 500 0 0 333 50 420 cm /B Do Q';
obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /A 5 0 R /B 6 0 R >> >> /Contents 4 0 R >>');
obj(4, `<< /Length ${draw.length} >>`, Buffer.from(draw));
obj(5, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
obj(6, `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>`, flate);
const xref = pos;
put('xref\n0 7\n0000000000 65535 f\r\n');
for (let n = 1; n < 7; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`);
put(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
writeFileSync(out, Buffer.concat(parts));
console.log(`wrote ${out} (${pos} bytes)`);
