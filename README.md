# leanpdf

A small, low-memory, streaming PDF library for browsers, Node and Bun. It currently does one job:
it makes PDFs smaller by **recompressing and downscaling their embedded raster images**, and
copies everything else byte for byte.

- **Streams.** The input is read with bounded random access, and the output is written in one
  forward pass. Peak memory is roughly one decoded image plus the cross-reference index, whatever
  the file size. A 600 MB PDF compresses in about 270 MB of RSS, most of which is the runtime and
  libvips.
- **Small.** The browser entry (core, Blob I/O and the browser codec) is **40 KB minified, 15 KB
  gzipped**, with zero runtime dependencies. It uses no bundled JPEG, PNG or zlib code; it relies on
  `createImageBitmap`, `OffscreenCanvas`, `CompressionStream` and `DecompressionStream`.
- **Safe.** Unchanged objects are copied verbatim. Anything unusual is left alone. An image is only
  replaced when the new stream is at least 10% smaller.
- **Pluggable codecs.** Image decoding, resizing and encoding go through an `ImageCodec`. The
  package ships one built on browser primitives (works in Web Workers) and one built on
  [sharp](https://sharp.pixelplumbing.com/) for servers.

<!-- BENCHMARK-SUMMARY -->

## Install

```sh
npm install leanpdf          # or: bun add leanpdf
npm install sharp                 # only for the server codec / CLI
```

ESM only. The core runs on any modern browser, Node 18.17+ and Bun. The sharp codec follows
sharp's own requirements (sharp 0.35 needs Node 20.9+).

## Usage

### Browser

```ts
import { compressPdfBlob } from 'leanpdf';

const { blob, report } = await compressPdfBlob(file, { maxWidth: 1600, maxHeight: 1600, jpegQuality: 0.75 });
```

`compressPdfBlob` reads the `File` with `blob.slice()` and returns a `Blob` whose unchanged parts
are slices of the input, so passthrough bytes never enter JS memory. It defaults to
`BrowserImageCodec` and works the same inside a Web Worker, which is where it should run for large
files.

To stream straight to disk (for example with the File System Access API), use `compressPdf` with a
`WritableStreamSink`:

```ts
import { compressPdf, BlobSource, WritableStreamSink, BrowserImageCodec } from 'leanpdf';

const handle = await showSaveFilePicker({ suggestedName: 'compressed.pdf' });
const report = await compressPdf(new BlobSource(file), new WritableStreamSink(await handle.createWritable()), {
  codec: new BrowserImageCodec(),
  onProgress: ({ processedObjects, totalObjects }) => console.log(processedObjects / totalObjects),
});
```

### Node and Bun

```ts
import { compressPdfFile } from 'leanpdf/node';
import { SharpImageCodec } from 'leanpdf/sharp';

const report = await compressPdfFile('in.pdf', 'out.pdf', { codec: new SharpImageCodec(), maxWidth: 2000, maxHeight: 2000 });
```

`compressPdfFile` writes to a temporary file next to the output and renames it into place, so
`out.pdf` only ever holds a complete file (and the input may equal the output). For other
destinations, combine `NodeFileSource` with any `OutputSink`, for example
`new WritableStreamSink(Writable.toWeb(stream))`.

### CLI

```sh
leanpdf compress in.pdf out.pdf --max 1600 --quality 0.75
```

| Option | Default | |
|---|---|---|
| `--max <px>` | 1600 | Max image width and height |
| `--max-width`, `--max-height` | | Set them separately |
| `-q, --quality <0-1>` | 0.75 | JPEG quality |
| `--min-bytes <n>` | 20000 | Skip image streams smaller than this |
| `--min-savings <r>` | 0.9 | Keep a result only if new ≤ old × r |
| `-j, --concurrency <n>` | 1 | Images processed in parallel |
| `--no-gray` | | Encode grayscale images as RGB |
| `--progressive` | | Write progressive JPEGs |
| `--json` | | Print the report (plus time and peak RSS) as JSON |

The CLI uses sharp. In this repository you can run it with `bun src/cli.ts compress …`; the built
`dist/cli.js` runs on Node.

## API

### `compressPdf(source, sink, options): Promise<CompressReport>`

Reads `source`, writes a complete new PDF to `sink`, then calls `sink.close()`. On failure it
calls `sink.abort?.(error)` and rethrows.

| Option | Default | |
|---|---|---|
| `codec` | required | An `ImageCodec` |
| `maxWidth`, `maxHeight` | 1600 | Images are downscaled to fit, never enlarged |
| `jpegQuality` | 0.75 | 0..1 |
| `preserveGray` | `true` | Ask the codec to keep grayscale images grayscale |
| `minImageBytes` | 20 000 | Skip image streams smaller than this |
| `minSavingsRatio` | 0.9 | Keep a replacement only if `newSize <= oldSize * ratio` |
| `concurrency` | 1 | Images in flight at once. Memory grows with it. |
| `signal` | | `AbortSignal` |
| `onProgress` | | `({ processedObjects, totalObjects, bytesSaved }) => void` |

```ts
interface CompressReport {
  imagesSeen: number;
  imagesRecompressed: number;
  imagesSkipped: Record<string, number>; // reason -> count, see below
  inputBytes: number;
  outputBytes: number;
  signaturesInvalidated: boolean;        // the input was digitally signed
  xrefRepaired: boolean;                 // damaged cross-reference data was rebuilt
  warnings: string[];
}
```

Errors: `PdfEncryptedError` (the trailer has `/Encrypt`), `PdfFormatError` (not a PDF, or too
damaged to rebuild), `SourceReadError` (the source failed), `RangeError` (bad options), and the
signal's reason when aborted. All extend `PdfError` except the last two.

### Entry points

| Import | Contents |
|---|---|
| `leanpdf` | `compressPdf`, `compressPdfBlob`, `BlobSource`, `BlobPartsSink`, `WritableStreamSink`, `BrowserImageCodec`, types, errors |
| `leanpdf/node` | `NodeFileSource`, `NodeFileSink`, `compressPdfFile` |
| `leanpdf/sharp` | `SharpImageCodec` (the only module that imports `sharp`) |

### I/O

```ts
interface RandomAccessSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
interface OutputSink {
  write(chunk: Uint8Array): Promise<void>;
  copyRange(source: RandomAccessSource, offset: number, length: number): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
```

- `BlobSource(blob)` reads through `blob.slice().arrayBuffer()`.
- `BlobPartsSink()` collects `Uint8Array`s and blob slices. `copyRange` from a `BlobSource`
  pushes `blob.slice(...)`, so passthrough bytes are never copied. Read `.blob` after close.
  (Bun 1.3 can't combine slices of file-backed Blobs such as `Bun.file()` with other parts; the
  sink detects this and copies those bytes instead. On Bun, prefer `NodeFileSource` and
  `NodeFileSink` for large files.)
- `WritableStreamSink(stream)` writes to any `WritableStream<Uint8Array>` with backpressure.
- `NodeFileSource.open(path)` / `NodeFileSink.create(path)` wrap `fs.promises.FileHandle`.

The compressor merges adjacent passthrough copies and batches small writes, so a sink sees a
handful of large operations rather than one per object.

### Codecs

```ts
interface ImageCodec {
  recompress(input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null>;
}
```

The input is either `{ kind: 'jpeg', data }` (the original DCT bytes) or `{ kind: 'pixels', data }`
(8-bit gray or RGB samples). Return a JPEG with its dimensions and component count, or `null` to
keep the original. The core checks the returned JPEG's own headers, and uses them to write
`/Width`, `/Height` and `/ColorSpace`, so a codec can't produce a mismatched image dictionary.

- **`BrowserImageCodec`** decodes and resizes with
  `createImageBitmap(blob, { colorSpaceConversion: 'none', resizeQuality: 'high', ... })`, draws to
  an `OffscreenCanvas` and encodes with `convertToBlob({ type: 'image/jpeg' })`. Browsers only
  encode 3-component JPEGs, so grayscale images come back as RGB (`preserveGray` can't be honored).
  Every `ImageBitmap` is closed.
- **`SharpImageCodec`** uses `sharp(...).resize({ fit: 'inside', withoutEnlargement: true }).jpeg({ mozjpeg: true })`,
  keeps grayscale as grayscale, ignores embedded ICC profiles and EXIF orientation (as PDF
  renderers do) and writes baseline JPEGs unless `{ progressive: true }`.

## What gets recompressed

An image XObject is a candidate when **all** of these hold:

| | |
|---|---|
| Filters | none, `/DCTDecode`, `/FlateDecode`, or `[/FlateDecode /DCTDecode]` |
| Color space | `/DeviceGray`, `/DeviceRGB`, or `/ICCBased` with `/N` 1 or 3 |
| Bits per component | 8 |
| `/Decode` | absent or the identity |
| Flate predictors | none, TIFF 2, or PNG 10–15 (with `/Colors` and `/Columns` matching the image) |
| JPEG data | baseline, extended or progressive Huffman, 8-bit, 1 or 3 components, frame size matching the dictionary, YCbCr for color |
| Size | at least `minImageBytes` of encoded data |

Indirect `/Length`, `/ColorSpace`, ICC `/N` and friends are resolved, including through object
streams.

The rewritten image keeps all its original dictionary entries verbatim (`/SMask`, `/Interpolate`,
`/Intent`, `/Metadata`, `/OC`, `/StructParent`, …), except `/Filter`, `/Width`, `/Height`,
`/BitsPerComponent`, `/Length` and `/ColorSpace`, which are replaced, and `/DecodeParms`, `/Decode`
and `/DL`, which are removed. An `/ICCBased` color space is kept when the component count doesn't
change; otherwise it becomes `/DeviceRGB` or `/DeviceGray` and the profile is dropped.

**Soft masks** (the transparency of an image, referenced by its `/SMask`) shrink to the same box
as images, but stay gray and lossless: they are area-averaged down and written back as Flate with
a PNG predictor, in one streaming pass that holds only a few rows in memory. This works whether
or not the image itself could be recompressed, since a soft mask may have other dimensions than
its image. Masks that already fit are left alone unless they were stored uncompressed, and masks
with `/Matte` (pre-blended images) are never resized, together with their image.

Everything else is skipped and counted in `report.imagesSkipped`:

| Reason | Meaning |
|---|---|
| `small` | below `minImageBytes` |
| `cmyk`, `indexed`, `separation`, `deviceN`, `lab`, `colorSpace`, `noColorSpace` | unsupported color space (CMYK includes 4-component JPEGs) |
| `jpx`, `jbig2`, `ccitt`, `filter` | unsupported filter or filter chain |
| `bitsPerComponent`, `decode`, `predictor` | not 8-bit, non-identity `/Decode`, unsupported predictor |
| `imageMask`, `colorKeyMask` | stencil masks and images with a `/Mask` color-key array |
| `softMask` | a soft mask that already fits the box, or isn't gray Flate/uncompressed data (e.g. a JPEG mask) |
| `matte` | a pre-blended image or its `/Matte` soft mask (their dimensions must stay equal) |
| `jpegTransform`, `jpegUnsupported`, `jpegMismatch`, `jpegInvalid` | Adobe/RGB-transform JPEGs, arithmetic, lossless or 12-bit JPEGs, header disagreements |
| `external`, `malformed`, `tooLarge` | `/F` external streams, broken dictionaries, over 2²⁹ samples |
| `decodeError` | the stream data couldn't be decoded completely |
| `codecDeclined`, `codecError`, `codecOutputInvalid` | the codec returned null, threw, or returned something that isn't a usable JPEG |
| `noGain` | the result wasn't at least `1 - minSavingsRatio` smaller |

## How it works

1. **Cross-reference index.** It reads the tail of the file for `startxref` and follows the
   chain: classic `xref` tables (streamed in bounded chunks), xref streams (`/W`, `/Index`, Flate
   and PNG predictors, decoded as a stream), hybrid files (`/XRefStm`) and every `/Prev` of an
   incrementally updated file, with later entries winning. The index is stored in typed arrays
   (13 bytes per object) and is the only structure whose size grows with the document.
2. **Validation and repair.** Every offset must point at `N G obj`. Offsets that point at
   whitespace just before the object are corrected. Wrong offsets are relocated by scanning the
   file in 1 MB chunks for `N G obj`, skipping stream bodies. If the xref chain is unusable, the
   whole index is rebuilt that way, together with the objects inside object streams and a trailer
   recovered from the last `trailer` or `/Type /XRef` dictionary (or the catalog, as a last
   resort). Junk before `%PDF-` is handled by retrying with shifted offsets.
3. **Header pass.** It reads only each object's header, meaning its dictionary up to `stream` or
   `endobj`, through a small read cache. This finds soft masks, signatures (`/ByteRange` or
   AcroForm `/SigFlags`), old xref streams and a stale linearization dictionary.
4. **Write pass.** Objects are written in ascending source-offset order. Each object's extent is
   found from `/Length`; if that doesn't land on `endstream`, it searches forward, never past the
   next object. Unchanged objects are passed to `sink.copyRange` from `N G obj` through `endobj`,
   and adjacent copies merge. A missing `endobj` is added. Image candidates are decoded (JPEG
   bytes as-is; Flate streams inflated through `DecompressionStream` and un-predicted row by row
   into one buffer), passed to the codec and written back with their original object and
   generation numbers. With `concurrency > 1`, images are processed ahead while earlier objects
   are written.
5. **New cross-reference section.** Old xref tables and streams are dropped, and incremental
   updates collapse into one revision without `/Prev`. When the source had compressed objects, the
   output gets an xref stream (PNG-Up predicted, deflated with `CompressionStream`); otherwise it
   gets a classic table. Object streams are copied verbatim, so their members keep their entries.
   `/Root`, `/Info`, `/ID` and any other document-level trailer keys carry over.

## Known limitations

- **Encrypted PDFs** are refused (`PdfEncryptedError`).
- **Signed PDFs** are processed, but any rewrite invalidates the signatures
  (`report.signaturesInvalidated`).
- **Linearization** is lost. The output is a regular PDF, and the old linearization dictionary is
  dropped.
- **Not recompressed:** CMYK, Indexed, Separation, DeviceN, Lab and calibrated images; JPEG 2000,
  JBIG2 and CCITT; 1, 2, 4 and 16-bit images; and inline images (`BI … ID … EI`). No browser
  decodes JPEG 2000, and sharp's prebuilt binaries leave it out, so print-oriented PDFs that store
  their photos as JPEG 2000 won't shrink much (their soft masks still do).
- **Color:** changing an ICCBased image's component count (only the browser codec does this,
  gray→RGB) drops its ICC profile. Grayscale images grow into RGB in the browser, which usually
  only pays off together with downscaling; `minSavingsRatio` guards the rest.
- **Deduplication and font subsetting** are out of scope. Only images change.
- **Object numbering** is preserved, including gaps.

## Development

This repository uses [Bun](https://bun.sh) for everything (install, test, build, scripts).

```sh
bun install
bun run typecheck
bun test                     # unit, corpus/e2e (qpdf + MuPDF rendering), fuzz, codec contract, browser
bun run size                 # fails if the minified browser entry exceeds 50 KB
bun run build                # tsc -> dist/ (ESM + .d.ts)
bun run test:large           # > 500 MB memory-bound check
bun run demo                 # browser demo at http://localhost:3000
bun bench/run.ts             # benchmarks (bun install --cwd bench first)
```

The browser tests drive headless Chromium through `playwright-core`; set `CHROMIUM_PATH` or run
`bunx playwright-core install chromium`. `qpdf` must be on the `PATH` for the validation tests.

### Releasing

`.github/workflows/publish.yml` publishes to npm (with provenance) when a GitHub release is
published. The tag must be `v` + the `package.json` version. It runs the full test suite and the
size budget first. It needs an `NPM_TOKEN` repository secret. It can also be run by hand, as a
dry run by default.
