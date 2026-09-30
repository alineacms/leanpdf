// Baseline: the usual pdf-lib approach. Load the whole document into pdf-lib's object model,
// recompress image streams with sharp (same limits as leanpdf: 1600 px, q75, keep only if
// <= 90% of the original), then serialize the whole document with doc.save().
import { readFile, writeFile } from 'node:fs/promises';
import { decodePDFRawStream, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import sharp from 'sharp';

const [input, output] = process.argv.slice(2);
const doc = await PDFDocument.load(await readFile(input), { updateMetadata: false });
const N = (s) => PDFName.of(s);
const smasks = new Set();
for (const [, obj] of doc.context.enumerateIndirectObjects()) {
  const sm = obj instanceof PDFRawStream ? obj.dict.get(N('SMask')) : undefined;
  if (sm instanceof PDFRef) smasks.add(sm.toString());
}
for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream) || smasks.has(ref.toString())) continue;
  const d = obj.dict;
  if (d.get(N('Subtype')) !== N('Image') || obj.contents.length < 20000) continue;
  if (d.get(N('BitsPerComponent'))?.asNumber?.() !== 8 || d.get(N('ImageMask')) || d.get(N('Decode'))) continue;
  const cs = d.lookup(N('ColorSpace'));
  const channels = cs === N('DeviceRGB') ? 3 : cs === N('DeviceGray') ? 1 : 0;
  if (!channels) continue;
  const filter = d.get(N('Filter'));
  const width = d.get(N('Width')).asNumber();
  const height = d.get(N('Height')).asNumber();
  let img;
  if (filter === N('DCTDecode')) img = sharp(obj.contents);
  else if (filter === N('FlateDecode') && !d.get(N('DecodeParms'))) {
    img = sharp(Buffer.from(decodePDFRawStream(obj).decode()), { raw: { width, height, channels } });
  } else continue;
  const { data, info } = await img
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .toColourspace(channels === 1 ? 'b-w' : 'srgb')
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (data.length > obj.contents.length * 0.9) continue;
  d.set(N('Filter'), N('DCTDecode'));
  d.delete(N('DecodeParms'));
  d.set(N('Width'), PDFNumber.of(info.width));
  d.set(N('Height'), PDFNumber.of(info.height));
  d.set(N('ColorSpace'), info.channels === 1 ? N('DeviceGray') : N('DeviceRGB'));
  doc.context.assign(ref, PDFRawStream.of(d, new Uint8Array(data)));
}
await writeFile(output, await doc.save({ useObjectStreams: false }));
