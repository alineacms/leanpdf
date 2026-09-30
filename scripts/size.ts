/**
 * Bundle-size budget. Each scenario bundles a one-line entry that imports only some exports, the
 * way an app would, so this also checks that unused features tree-shake away. Fails when the
 * compression bundle (core + Blob I/O + browser codec) exceeds its budget.
 */
const KB = 1024;
const lib = new URL('../src/index.ts', import.meta.url).pathname;

const SCENARIOS: { name: string; imports: string; budget?: number }[] = [
  { name: 'compressPdfBlob (core + Blob I/O + browser codec)', imports: 'compressPdfBlob', budget: 50 * KB },
  { name: 'openPdf', imports: 'openPdf' },
  { name: 'openPdf + getInfo', imports: 'openPdf, getInfo' },
  { name: 'openPdf + outline, links, forms', imports: 'openPdf, getOutline, getLinks, getFormFields' },
  { name: 'openPdf + attachments', imports: 'openPdf, listAttachments, attachmentStream' },
  { name: 'openPdf + images', imports: 'openPdf, listImages, extractImage' },
  { name: 'openPdf + extractText', imports: 'openPdf, extractText' },
  { name: 'openPdf + renderPage', imports: 'openPdf, renderPage' },
  { name: 'rewritePdf (no plugins)', imports: 'rewritePdf' },
  { name: 'rewritePdf + all edit plugins', imports: 'rewritePdf, removeUnused, stripMetadata, removeJavaScript, removeAttachments, rotatePages, selectPages, recompressStreams, repairStreams' },
  { name: 'mergePdfs', imports: 'mergePdfs' },
  { name: 'decryptPdf', imports: 'decryptPdf' },
  { name: 'everything', imports: '*' },
];

// Outside node_modules: Bun treats entries there as dependency files.
const dir = `${(await import('node:os')).tmpdir()}/leanpdf-size/`;
let failed = false;
const rows: string[] = [];
for (const s of SCENARIOS) {
  const entry = `${dir}${s.name.replace(/\W+/g, '-')}.ts`;
  await Bun.write(entry, s.imports === '*' ? `export * from '${lib}';\n` : `export { ${s.imports} } from '${lib}';\n`);
  // Split, so code loaded on demand (import()) is counted apart from what loads up front.
  const result = await Bun.build({ entrypoints: [entry], outdir: `${dir}out`, target: 'browser', format: 'esm', minify: true, splitting: true });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const code = new Uint8Array(await result.outputs.find((o) => o.kind === 'entry-point')!.arrayBuffer());
  // Chunks the code still refers to after tree-shaking (Bun emits one per import() it sees).
  const text = new TextDecoder().decode(code);
  let lazy = 0;
  for (const o of result.outputs) if (o.kind === 'chunk' && text.includes(o.path.split('/').pop()!)) lazy += (await o.arrayBuffer()).byteLength;
  const min = code.byteLength;
  const gz = Bun.gzipSync(code).byteLength;
  const over = s.budget !== undefined && min > s.budget;
  failed ||= over;
  rows.push(
    `${s.name.padEnd(52)} ${(min / KB).toFixed(1).padStart(6)} KB min ${(gz / KB).toFixed(1).padStart(6)} KB gz` +
      (lazy ? `  (+${(lazy / KB).toFixed(1)} KB on demand)` : '') +
      (s.budget ? `  (budget ${(s.budget / KB).toFixed(0)} KB${over ? ', OVER' : ''})` : ''),
  );
}
console.log(rows.join('\n'));
if (failed) process.exit(1);
