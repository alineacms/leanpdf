// pdf-lib 1.17 for the feature benchmark: node pdflib.mjs <task> <out> <in>...
// It loads every input into its object model and serializes the whole result. It can't extract
// text or decrypt.
import { readFile, writeFile } from 'node:fs/promises';
import { degrees, PDFDocument } from 'pdf-lib';

const [task, out, ...inputs] = process.argv.slice(2);
const load = async (path) => PDFDocument.load(await readFile(path), { updateMetadata: false });
const save = async (doc) => writeFile(out, await doc.save({ useObjectStreams: false }));

if (task === 'info') {
  const doc = await load(inputs[0]);
  const info = {
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    created: doc.getCreationDate(),
    modified: doc.getModificationDate(),
    pages: doc.getPages().map((p) => p.getSize()),
  };
  await writeFile(out, JSON.stringify(info));
} else if (task === 'pages') {
  const src = await load(inputs[0]);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const keep = src.getPageIndices().filter((i) => i % 2 === 0);
  for (const p of await doc.copyPages(src, keep)) doc.addPage(p);
  await save(doc);
} else if (task === 'rotate') {
  const doc = await load(inputs[0]);
  for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + 90) % 360));
  await save(doc);
} else if (task === 'merge') {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const path of inputs) {
    const src = await load(path);
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
  }
  await save(doc);
} else throw new Error(`pdf-lib can't ${task}`);
