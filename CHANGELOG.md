# Changelog

## 0.3.0

leanpdf renders pages now, and decodes JPEG 2000. Rendering loads its JPEG 2000, JPEG and fax decoders only when a page needs them, so the other features stay as small as before.

- `renderPage`: render pages to a canvas (Canvas 2D, main thread or worker). Embedded TrueType, OpenType, CFF, Type 1 and Type 3 fonts; images, streamed to about the size drawn, JPEGs decoded in parallel, and cached per document (CMYK JPEGs by leanpdf's own decoder, since browsers invert them); JPEG 2000; shadings and patterns; transparency groups and soft masks; annotations; optional content. Not yet: JBIG2 images.
- JPEG 2000: a decoder of its own (Part 1: all progression orders, tiles, precincts, layers, code-block styles, 5/3 and 9/7 wavelets, 1-16 bit components, palettes, reduced-resolution decoding), loaded on demand. compressImages now recompresses JPEG 2000 images too (except those with their own alpha).
- decryptPdf: RC4 keys shorter than 128 bits in /V 4 crypt filters (their /Length is often given in bytes) now decrypt.
- openPdf also takes the file's bytes (Uint8Array or ArrayBuffer).
- Files are read through a 4 MB cache of 64 KB blocks, and large streams in 1 MB pieces: rendering a page takes 0-5 reads instead of 6-42, which matters most where each read of a File is slow (phones).
- CLI: sharp is loaded only by the commands that use it (compress, images --extract), so the others start about 70 ms sooner.
- Website: a View tab. It reads files of up to 128 MB into memory first, re-renders only when the width changes, and shows how long reading, opening and rendering took.
- Benchmarks for every feature, not just compression: info, text, page selection, rotation, merging, decryption and rendering, against pdf-lib, PDF.js, MuPDF.js and qpdf. In the README and on the website.

## 0.2.0

leanpdf grows from an image compressor into a small, streaming PDF toolkit. Every feature is its own module, so importing only compressPdfBlob still bundles to 42.8 KB minified (16.5 KB gzipped).

### Compressing

- Transparency masks (soft masks) are now downscaled along with their images, losslessly.
- compressImages is also a rewrite plugin, so compression combines with the editing plugins in one pass.

### Reading

All take a document from `openPdf`.

- getInfo and getPages: metadata from the Info dictionary and XMP, dates, flags, page sizes, rotation and labels.
- getOutline, getLinks and getFormFields.
- listAttachments, readAttachment and attachmentStream (streamed, never loaded whole).
- listImages and extractImage.
- extractText and extractAllText: text per page for search indexing, with ToUnicode, CID fonts, Type 3 fonts and Form XObjects.

### Editing

Plugins for `rewritePdf`, combined in one pass.

- stripMetadata, removeJavaScript, removeAttachments, removeUnused.
- selectPages (keep and reorder; outline, links, destinations and fields follow), rotatePages.
- recompressStreams, repairStreams and repairPdf.
- A documented Plugin interface for your own edits.

### Whole files

- mergePdfs: streams every input once and copies only what the selected pages need; merges bookmarks, form fields and optional content.
- decryptPdf: the standard security handler, RC4 and AES-128/256 (revisions 2 to 6), with the user or owner password.

### CLI

- New commands: info, text, images, attachments, outline, links, fields, clean, pages, rotate, merge, decrypt, repair.
- compress gains --streams, --strip and --gc.

### Fixes

- A truncated encrypted file is no longer mistaken for an unencrypted one after its cross-reference table is rebuilt.
- Names in large object streams are parsed in linear time.
- File-to-file copies in Node reuse one buffer, so peak memory no longer depends on garbage-collector timing.

Benchmarks against pdf-lib, Ghostscript and MuPDF are in the README.

## 0.1.0

First release: streaming image recompression for PDFs in browsers, Node and Bun (`compressPdf`, `compressPdfBlob`, `compressPdfFile`), with a browser codec, a sharp codec and the `leanpdf compress` CLI.
