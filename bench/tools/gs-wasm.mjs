// Ghostscript compiled to WebAssembly, as used by in-browser compressors: the input is copied
// into the in-memory file system and rewritten with pdfwrite's /ebook preset (150 dpi images).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import createGs from '@jspawn/ghostscript-wasm/gs.mjs';

const [input, output] = process.argv.slice(2);
const wasm = readFileSync(createRequire(import.meta.url).resolve('@jspawn/ghostscript-wasm/gs.wasm'));
const gs = await createGs({
  instantiateWasm: (imports, done) => {
    WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance));
    return {};
  },
  print: () => {},
  printErr: () => {},
});
gs.FS.writeFile('/in.pdf', readFileSync(input));
const code = gs.callMain(['-sDEVICE=pdfwrite', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-sOutputFile=/out.pdf', '/in.pdf']);
if (code) process.exit(code);
writeFileSync(output, gs.FS.readFile('/out.pdf'));
