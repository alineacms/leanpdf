// PDF.js (pdfjs-dist, legacy build for Node) for the feature benchmark:
// node pdfjs.mjs <task> <out> <in>. It reads documents only: info and text.
import { readFile, writeFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [task, out, input] = process.argv.slice(2);
const loading = getDocument({ data: new Uint8Array(await readFile(input)), verbosity: 0, isEvalSupported: false });
const doc = await loading.promise;

if (task === 'info') {
  const { info } = await doc.getMetadata();
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
    pages.push({ width, height });
  }
  await writeFile(out, JSON.stringify({ info, pages }));
} else if (task === 'text') {
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) text += 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '';
    text += '\n\f';
    page.cleanup();
  }
  await writeFile(out, text);
} else throw new Error(`PDF.js can't ${task}`);
await loading.destroy();
