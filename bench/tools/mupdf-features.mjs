// MuPDF.js 1.28 (WebAssembly) for the feature benchmark: node mupdf-features.mjs <task> <out> <in>...
// The password for `decrypt` comes from BENCH_PASSWORD.
import { readFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const [task, out, ...inputs] = process.argv.slice(2);
const open = (path) => mupdf.Document.openDocument(readFileSync(path), 'application/pdf');
const save = (doc, opts = 'compress=yes') => writeFileSync(out, doc.saveToBuffer(opts).asUint8Array());

if (task === 'info') {
  const doc = open(inputs[0]);
  const meta = {};
  for (const k of ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'CreationDate', 'ModDate']) meta[k] = doc.getMetaData(`info:${k}`);
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) pages.push(doc.loadPage(i).getBounds());
  writeFileSync(out, JSON.stringify({ meta, pages }));
} else if (task === 'text') {
  const doc = open(inputs[0]);
  let text = '';
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const st = page.toStructuredText('preserve-whitespace');
    text += st.asText() + '\f';
    st.destroy();
    page.destroy();
  }
  writeFileSync(out, text);
} else if (task === 'pages') {
  const doc = open(inputs[0]).asPDF();
  const keep = [];
  for (let i = 0; i < doc.countPages(); i += 2) keep.push(i);
  doc.rearrangePages(keep);
  save(doc, 'garbage=yes,compress=yes');
} else if (task === 'rotate') {
  const doc = open(inputs[0]).asPDF();
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    page.put('Rotate', ((page.getInheritable('Rotate')?.asNumber?.() ?? 0) + 90) % 360);
  }
  save(doc);
} else if (task === 'merge') {
  const doc = new mupdf.PDFDocument();
  for (const path of inputs) {
    const src = open(path).asPDF();
    for (let i = 0; i < src.countPages(); i++) doc.graftPage(-1, src, i);
  }
  save(doc);
} else if (task === 'decrypt') {
  const doc = open(inputs[0]).asPDF();
  if (doc.needsPassword() && !doc.authenticatePassword(process.env.BENCH_PASSWORD ?? '')) throw new Error('wrong password');
  save(doc, 'decrypt=yes,compress=yes');
} else throw new Error(`MuPDF.js can't ${task}`);
