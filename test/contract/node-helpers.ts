/** Node/Bun-side helpers for the codec contract: JPEG fixtures and a sharp-based decoder. */
import sharp from 'sharp';
import { JPEG_SPECS, synthesize, type DecodedImage, type JpegSpec } from './contract.ts';

export async function encodeJpegFixture(spec: JpegSpec): Promise<Uint8Array> {
  let img = sharp(synthesize(spec), { raw: { width: spec.width, height: spec.height, channels: spec.components } });
  if (spec.components === 1) img = img.toColourspace('b-w');
  img = img.jpeg({
    quality: spec.quality,
    progressive: spec.progressive ?? false,
    chromaSubsampling: spec.subsampling ?? '4:2:0',
  });
  if (spec.exifOrientation) img = img.withMetadata({ orientation: spec.exifOrientation });
  const buf = await img.toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

let cache: Promise<Record<string, Uint8Array>> | undefined;

/** All `JPEG_SPECS`, encoded once per process. */
export function makeJpegFixtures(): Promise<Record<string, Uint8Array>> {
  cache ??= (async () => {
    const out: Record<string, Uint8Array> = {};
    for (const s of JPEG_SPECS) out[s.name] = await encodeJpegFixture(s);
    return out;
  })();
  return cache;
}

/** Decode a JPEG with sharp, ignoring EXIF orientation and ICC profiles (as PDF renderers do). */
export async function sharpDecode(jpeg: Uint8Array): Promise<DecodedImage> {
  const { data, info } = await sharp(jpeg, { ignoreIcc: true, autoOrient: false }).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
