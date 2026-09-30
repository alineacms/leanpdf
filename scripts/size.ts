/**
 * Bundle-size budget for the browser entry (core + browser I/O + browser codec).
 * Fails when the minified bundle exceeds the budget.
 */
const BUDGET = 50 * 1024;

const result = await Bun.build({
  entrypoints: [new URL('../src/index.ts', import.meta.url).pathname],
  target: 'browser',
  format: 'esm',
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const code = await result.outputs[0].arrayBuffer();
const min = code.byteLength;
const gz = Bun.gzipSync(new Uint8Array(code)).byteLength;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`browser entry: ${kb(min)} minified, ${kb(gz)} gzipped (budget ${kb(BUDGET)})`);
if (min > BUDGET) {
  console.error(`Over budget by ${kb(min - BUDGET)}`);
  process.exit(1);
}
