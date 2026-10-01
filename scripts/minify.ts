/**
 * Shrink the published JavaScript after tsc: whitespace and comments out, syntax compacted, one
 * file per module as before (so apps' bundlers still drop the modules they don't use). Names are
 * kept, so stack traces stay readable. Type declarations keep their doc comments.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const dist = new URL('../dist/', import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(dist).filter((f) => f.endsWith('.js'));
const before = files.reduce((n, f) => n + statSync(f).size, 0);
await build({ entryPoints: files, outdir: dist, outbase: dist, allowOverwrite: true, format: 'esm', minifyWhitespace: true, minifySyntax: true, logLevel: 'warning' });
const after = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`dist: ${files.length} modules, ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
