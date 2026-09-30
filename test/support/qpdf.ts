/** Thin wrappers around the qpdf CLI. Tests that need it should skip when `hasQpdf` is false. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function probe(): boolean {
  try {
    return spawnSync('qpdf', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

export const hasQpdf: boolean = probe();
export const QPDF_MISSING = 'qpdf is not installed; skipping qpdf-based checks';

export interface QpdfResult {
  /** 0 = clean, 3 = warnings, 2 = errors. */
  code: number;
  output: string;
}

let tmpRoot: string | undefined;
let counter = 0;
function tmpFile(ext = '.pdf'): string {
  tmpRoot ??= mkdtempSync(join(tmpdir(), 'pdfc-qpdf-'));
  return join(tmpRoot, `${process.pid}-${counter++}${ext}`);
}

export function qpdf(args: string[], timeout = 60_000): QpdfResult {
  const r = spawnSync('qpdf', args, { encoding: 'latin1', timeout, maxBuffer: 256 << 20 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

function withFile<T>(data: Uint8Array, fn: (path: string) => T): T {
  const path = tmpFile();
  writeFileSync(path, data);
  try {
    return fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

/** `qpdf --check`. */
export function qpdfCheck(data: Uint8Array): QpdfResult {
  return withFile(data, (p) => qpdf(['--check', p]));
}

/** Severity of a qpdf exit code: 0 clean, 1 warnings, 2 errors (or crash). */
export function severity(code: number): number {
  return code === 0 ? 0 : code === 3 ? 1 : 2;
}

/** Run qpdf `args` with input and output files and return the output (warnings allowed). */
export function qpdfTransform(data: Uint8Array, args: string[]): Uint8Array {
  return withFile(data, (inp) => {
    const out = tmpFile();
    try {
      const r = qpdf([...args, inp, out]);
      if (r.code !== 0 && r.code !== 3) throw new Error(`qpdf ${args.join(' ')} failed (${r.code}): ${r.output}`);
      return new Uint8Array(readFileSync(out));
    } finally {
      rmSync(out, { force: true });
    }
  });
}

export type XrefEntry =
  | { type: 'uncompressed'; offset: number; gen: number }
  | { type: 'compressed'; stream: number; index: number };

/** Parse `qpdf --show-xref`: object number -> entry (free entries omitted). */
export function qpdfShowXref(data: Uint8Array): { code: number; entries: Map<number, XrefEntry> } {
  return withFile(data, (p) => {
    const r = qpdf(['--show-xref', p]);
    const entries = new Map<number, XrefEntry>();
    for (const line of r.output.split('\n')) {
      let m = /^(\d+)\/(\d+): uncompressed; offset = (\d+)/.exec(line);
      if (m) {
        entries.set(+m[1], { type: 'uncompressed', offset: +m[3], gen: +m[2] });
        continue;
      }
      m = /^(\d+)\/(\d+): compressed; stream = (\d+), index = (\d+)/.exec(line);
      if (m) entries.set(+m[1], { type: 'compressed', stream: +m[3], index: +m[4] });
    }
    return { code: r.code, entries };
  });
}
