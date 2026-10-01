import { expect, test } from 'bun:test';
import { openPdf } from '../../src/core/open.ts';
import { extractAllText } from '../../src/features/text.ts';
import { getPages } from '../../src/features/info.ts';
import { DocBuilder, drawText } from '../support/pdfgen.ts';

test('openPdf takes a Blob, a Uint8Array or an ArrayBuffer', async () => {
  const b = new DocBuilder();
  b.page({ content: drawText('From memory', 72, 700) });
  b.page({ content: drawText('Second page', 72, 700) });
  const bytes = b.finish().build().bytes;
  const copy = bytes.slice();
  for (const input of [new Blob([bytes as Uint8Array<ArrayBuffer>]), bytes, copy.buffer.slice(0)]) {
    const doc = await openPdf(input);
    expect((await getPages(doc)).length).toBe(2);
    expect(await extractAllText(doc)).toContain('From memory');
  }
  // A view into a larger buffer reads only its own bytes.
  const padded = new Uint8Array(bytes.length + 100);
  padded.set(bytes, 50);
  expect((await getPages(await openPdf(padded.subarray(50, 50 + bytes.length)))).length).toBe(2);
});
