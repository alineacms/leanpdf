// MuPDF.js (WebAssembly). Its JS API has no image downsampling, so this is the best it offers:
// a lossless rewrite (garbage collection, deduplication, Flate for everything uncompressed).
import { readFileSync, writeFileSync } from 'node:fs';
import * as mupdf from 'mupdf';

const [input, output] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(readFileSync(input), 'application/pdf').asPDF();
writeFileSync(output, doc.saveToBuffer('garbage=deduplicate,compress=yes,compress-images=yes').asUint8Array());
