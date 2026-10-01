/**
 * Generate the sample PDF the website offers (site/src/static/sample.pdf): four A4 pages with
 * photos (JPEG, so compressing has something to do), text to search, a vector chart, metadata and
 * bookmarks. Deterministic; run it again after changing it and commit the result:
 *
 *   bun site/sample.ts
 */
import { writeFileSync } from 'node:fs';
import { photo } from '../bench/corpus.ts';
import { DocBuilder, drawImage, drawText, imageDict } from '../test/support/pdfgen.ts';

const out = new URL('./src/static/sample.pdf', import.meta.url).pathname;
const b = new DocBuilder();
const W = 595;
const H = 842;

async function jpeg(width: number, height: number, seed: number): Promise<number> {
  const data = new Uint8Array(await photo(width, height, seed, 88));
  return b.stream(imageDict({ width, height, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), data);
}

/** Lines of text wrapped to `chars` characters, from (x, y) down. */
function wrapped(text: string, x: number, y: number, size: number, chars: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > chars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => drawText(l, x, y - i * size * 1.45, size, '0.15 0.17 0.2')).join('');
}

const cover = await jpeg(1500, 1000, 3);
const left = await jpeg(1000, 750, 11);
const right = await jpeg(1000, 750, 17);

// 1. Cover
b.page({
  width: W,
  height: H,
  xobjects: { Im1: cover },
  content:
    `0.12 0.33 0.82 rg 0 ${H - 8} ${W} 8 re f\n` +
    drawText('leanpdf sample', 50, 770, 34, '0.08 0.1 0.13') +
    drawText('A small document to try the tools with', 50, 742, 15, '0.35 0.38 0.43') +
    drawImage('Im1', 50, 330, 495, 330) +
    wrapped(
      'This file was made for the leanpdf website. It has photos that can be made smaller, a page of text to search, a chart drawn with vector graphics, metadata and bookmarks. Open it in the viewer and try the tools on the right.',
      50,
      290,
      12,
      78,
    ),
});

// 2. Text
const PARAGRAPHS = [
  'leanpdf reads a PDF in small slices and writes the result in one pass, so memory use stays flat whatever the size of the file. Anything it does not change is copied byte for byte.',
  'Compressing scales images down to fit a maximum size and encodes them as JPEG again. A new image is kept only when it is at least ten percent smaller than the one it replaces.',
  'The same reader extracts text, metadata, bookmarks, form fields and attachments, and renders pages to a canvas. Editing selects, reorders and rotates pages, removes metadata, scripts and attachments, merges files and removes encryption.',
  'Everything on this website runs in your browser, in a background worker. The file you open never leaves your device.',
];
let y = 760;
let text = drawText('How it works', 50, 780, 22, '0.08 0.1 0.13');
for (const p of PARAGRAPHS) {
  text += wrapped(p, 50, y - 18, 12, 82);
  y -= 18 + Math.ceil(p.length / 82) * 12 * 1.45 + 22;
}
b.page({ width: W, height: H, content: text });

// 3. Chart
const bars = [
  ['brochure', 41, 3.2],
  ['scan', 28, 3.4],
  ['report', 2, 0.5],
] as const;
let chart = drawText('Before and after compressing', 50, 780, 22, '0.08 0.1 0.13') + drawText('Megabytes, at the default settings', 50, 755, 12, '0.35 0.38 0.43');
chart += '0.85 0.87 0.9 RG 1 w\n';
for (let i = 0; i <= 4; i++) chart += `80 ${300 + i * 90} m 545 ${300 + i * 90} l S\n`;
bars.forEach(([name, before, after], i) => {
  const x = 110 + i * 150;
  chart += `0.75 0.78 0.84 rg ${x} 300 50 ${(before / 45) * 360} re f\n`;
  chart += `0.12 0.33 0.82 rg ${x + 55} 300 50 ${Math.max(2, (after / 45) * 360)} re f\n`;
  chart += drawText(name, x + 20, 280, 12, '0.2 0.22 0.26');
});
chart += `0.75 0.78 0.84 rg 80 220 12 12 re f\n${drawText('Before', 98, 221, 11)}0.12 0.33 0.82 rg 160 220 12 12 re f\n${drawText('After', 178, 221, 11)}`;
b.page({ width: W, height: H, content: chart });

// 4. Photos
b.page({
  width: W,
  height: H,
  xobjects: { Im1: left, Im2: right },
  content:
    drawText('Photos', 50, 780, 22, '0.08 0.1 0.13') +
    drawImage('Im1', 50, 520, 240, 180) +
    drawImage('Im2', 305, 520, 240, 180) +
    wrapped('Two more photos. Compressing scales them to the size set in the toolbox and keeps the result only when it is smaller.', 50, 490, 12, 82),
});

// Metadata and bookmarks.
const info = b.obj('<< /Title (leanpdf sample) /Author (leanpdf) /Subject (A document to try the tools with) /Creator (site/sample.ts) >>');
const titles = ['Cover', 'How it works', 'Before and after compressing', 'Photos'];
const outlines = b.alloc();
const items = titles.map(() => b.alloc());
items.forEach((num, i) => {
  const links = `${i ? ` /Prev ${items[i - 1]} 0 R` : ''}${i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : ''}`;
  b.setObj(num, `<< /Title (${titles[i]}) /Parent ${outlines} 0 R /Dest [${b.pages[i]} 0 R /Fit]${links} >>`);
});
b.setObj(outlines, `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`);
b.catalogExtra = ` /Outlines ${outlines} 0 R /PageMode /UseOutlines`;
b.trailer('Info', `${info} 0 R`);
const pdf = b.finish('leanpdf-sample').build().bytes;
writeFileSync(out, pdf);
console.log(`${out}: ${(pdf.length / 1024).toFixed(0)} KB`);
