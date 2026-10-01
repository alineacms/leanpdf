/** The CLI's render command (needs @napi-rs/canvas, a dev dependency). */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocBuilder } from '../support/pdfgen.ts';

const dir = mkdtempSync(join(tmpdir(), 'leanpdf-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = new URL('../../src/cli.ts', import.meta.url).pathname;

function run(...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Width and height from a PNG's IHDR. */
const pngSize = (b: Uint8Array): [number, number] => {
  const v = new DataView(b.buffer, b.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
};

describe('leanpdf render', () => {
  const b = new DocBuilder();
  b.page({ width: 200, height: 100, content: '1 0 0 rg 0 0 100 100 re f' });
  b.page({ width: 300, height: 100, content: '0 0 1 rg 0 0 300 50 re f' });
  const input = join(dir, 'in.pdf');
  writeFileSync(input, b.finish().build().bytes);

  test('one file per page, at --dpi, with --json', () => {
    const r = run('render', input, join(dir, 'p.png'), '--dpi', '144', '--json');
    expect(r.code).toBe(0);
    const pages = JSON.parse(r.out) as { page: number; file: string; width: number; height: number }[];
    expect(pages.map((p) => [p.page, p.width, p.height])).toEqual([
      [1, 400, 200],
      [2, 600, 200],
    ]);
    const png = new Uint8Array(readFileSync(join(dir, 'p-1.png')));
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(pngSize(png)).toEqual([400, 200]);
    expect(existsSync(join(dir, 'p-2.png'))).toBe(true);
  });

  test('a single page goes to the name given; JPEG by extension; --width fits', () => {
    const r = run('render', input, join(dir, 'one.jpg'), '--pages', '2', '--width', '150', '--quiet');
    expect(r.code).toBe(0);
    const jpg = readFileSync(join(dir, 'one.jpg'));
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect(existsSync(join(dir, 'one-2.jpg'))).toBe(false);
  });

  test('an unknown extension is a usage error', () => {
    const r = run('render', input, join(dir, 'x.gif'));
    expect(r.code).toBe(2);
    expect(r.err).toContain('render writes .png, .jpg or .webp files');
  });
});
