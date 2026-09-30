# Changelog

## Unreleased

- `renderPage`: render pages to a canvas (Canvas 2D, main thread or worker). Embedded TrueType, OpenType, CFF, Type 1 and Type 3 fonts; images, streamed to about the size drawn, JPEGs decoded in parallel, and cached per document (CMYK JPEGs by leanpdf's own decoder, since browsers invert them); shadings and patterns; transparency groups and soft masks; annotations; optional content. Not yet: JPEG 2000 and JBIG2 images.
- Website: a View tab.

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
