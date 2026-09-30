import { expect, test } from 'bun:test';
import { mkdtempSync, openAsBlob, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressPdf } from '../../src/core/compress.ts';
import { BlobPartsSink, BlobSource } from '../../src/io/blob.ts';
import type { ImageCodec } from '../../src/core/types.ts';
import { BASE_OBJECTS, BytesSink, BytesSource, miniPdf } from './util.ts';

const keep: ImageCodec = { recompress: async () => null };

// Bun (1.3) silently drops file-backed Blob slices when they are combined with other parts, so
// BlobPartsSink must detect that and copy instead of producing a truncated file.
test('BlobPartsSink output is complete for file-backed and in-memory Blobs', async () => {
  const { text } = miniPdf(BASE_OBJECTS, '/Root 1 0 R');
  const path = join(mkdtempSync(join(tmpdir(), 'leanpdf-')), 'in.pdf');
  writeFileSync(path, text, 'latin1');
  const ref = new BytesSink();
  await compressPdf(new BytesSource(text), ref, { codec: keep });
  const expected = ref.bytes();
  for (const blob of [Bun.file(path), await openAsBlob(path), new Blob([Buffer.from(text, 'latin1')])]) {
    const sink = new BlobPartsSink();
    await compressPdf(new BlobSource(blob), sink, { codec: keep });
    expect(Buffer.compare(new Uint8Array(await sink.blob.arrayBuffer()), expected)).toBe(0);
  }
});

test('BlobPartsSink refuses to hand out a Blob that lost bytes', async () => {
  const sink = new BlobPartsSink();
  await sink.write(new Uint8Array(10));
  (sink as unknown as { size: number }).size = 11;
  await expect(sink.close()).rejects.toThrow('expected 11');
});
