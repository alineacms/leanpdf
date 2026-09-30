#!/usr/bin/env node
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { SharpImageCodec } from './codecs/sharp.ts';
import type { PdfDocument } from './core/document.ts';
import {
  attachmentStream, compressImages, decryptPdf, extractImage, extractText, getFormFields, getInfo, getLinks, getOutline, getPages,
  listAttachments, listImages, mergePdfs, openPdf, PdfPasswordError, recompressStreams, removeAttachments, removeJavaScript,
  removeUnused, repairPdf, rewritePdf, rotatePages, selectPages, stripMetadata, type OutlineItem, type Plugin,
} from './index.ts';
import { NodeFileSink, NodeFileSource } from './io/node.ts';

const USAGE = `Usage: leanpdf <command> [options]

Commands:
  compress <in> <out>        Recompress and downscale images (the rest is copied byte for byte)
      --max <px>             Max image width and height (default 1600)
      --max-width, --max-height <px>
      -q, --quality <0-1>    JPEG quality (default 0.75)
      --min-bytes <n>        Skip image streams smaller than this (default 20000)
      --min-savings <r>      Keep a result only if new <= old * r (default 0.9)
      -j, --concurrency <n>  Images processed in parallel (default 1)
      --no-gray              Encode grayscale images as RGB
      --progressive          Write progressive JPEGs
      --streams              Also Flate-compress uncompressed streams
      --strip                Also remove metadata, and drop unused objects
      --gc                   Also drop unused objects
  info <in>                  Metadata, page count and sizes, flags
  text <in> [-o out.txt] [--pages 1-3,7]   Extract text; with --json one line per page
  images <in> [--extract <dir>]            List images, or save them (JPEG as stored, others as PNG)
  attachments <in> [--extract <dir>]       List embedded files, or save them
  outline <in>               Bookmarks with their target pages
  links <in>                 Link annotations
  fields <in>                Form fields and their values
  clean <in> <out>           Remove metadata, JavaScript and attachments, and drop unused objects
      --keep-metadata, --keep-js, --keep-attachments
  pages <in> <out> <pages>   Keep and reorder pages, e.g. 3,1-2,5-
  rotate <in> <out> <deg> [--pages 1,3]    Rotate pages clockwise by a multiple of 90
  merge <out> <in>[:pages] <in>[:pages]... Concatenate PDFs, optionally selecting pages
  decrypt <in> <out> [--password <pw>]     Remove encryption (or set LEANPDF_PASSWORD)
  repair <in> <out>          Rewrite with a rebuilt cross-reference table and fixed streams

Common options:
  --json                     Machine-readable output
  --quiet                    Print nothing on success
  -h, --help                 Show this help

Page numbers are 1-based. Output files are written next to their destination and renamed into
place when complete, so the input may also be the output.`;

class UsageError extends Error {}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${v}"`);
  return n;
}

/** "1-3,5,7-" (1-based) -> 0-based indices, in the given order. */
function parseRanges(spec: string, pageCount: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = /^\s*(\d*)\s*(-?)\s*(\d*)\s*$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new UsageError(`Invalid page range "${part}"`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to > pageCount || from > to) throw new UsageError(`Page range "${part}" is outside 1-${pageCount}`);
    for (let p = from; p <= to; p++) out.push(p - 1);
  }
  return out;
}

async function withDoc<T>(path: string, fn: (doc: PdfDocument) => Promise<T>): Promise<T> {
  const src = await NodeFileSource.open(path);
  try {
    return await fn(await openPdf(src));
  } finally {
    await src.close();
  }
}

/** Write through a temporary file that is renamed into place only when complete. */
async function toFile<T>(output: string, fn: (sink: NodeFileSink) => Promise<T>): Promise<T> {
  const tmp = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    const r = await fn(await NodeFileSink.create(tmp));
    await rename(tmp, output);
    return r;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function saveStream(path: string, stream: ReadableStream<Uint8Array>): Promise<number> {
  const fh = await open(path, 'w');
  let n = 0;
  try {
    const r = stream.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) return n;
      await fh.write(value);
      n += value.length;
    }
  } finally {
    await fh.close();
  }
}

const safeName = (s: string): string => basename(s.replace(/\\/g, '/')).replace(/[\0-\x1f<>:"|?*]/g, '_') || 'attachment';

function printOutline(items: OutlineItem[], depth = 0): void {
  for (const it of items) {
    const target = it.pageIndex !== undefined ? `  p.${it.pageIndex + 1}` : it.url ? `  ${it.url}` : '';
    console.log(`${'  '.repeat(depth)}${it.title}${target}`);
    printOutline(it.children, depth + 1);
  }
}

async function main(): Promise<number> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      max: { type: 'string' },
      'max-width': { type: 'string' },
      'max-height': { type: 'string' },
      quality: { type: 'string', short: 'q' },
      'min-bytes': { type: 'string' },
      'min-savings': { type: 'string' },
      concurrency: { type: 'string', short: 'j' },
      'no-gray': { type: 'boolean' },
      progressive: { type: 'boolean' },
      streams: { type: 'boolean' },
      strip: { type: 'boolean' },
      gc: { type: 'boolean' },
      pages: { type: 'string' },
      output: { type: 'string', short: 'o' },
      extract: { type: 'string' },
      'keep-metadata': { type: 'boolean' },
      'keep-js': { type: 'boolean' },
      'keep-attachments': { type: 'boolean' },
      password: { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (v.help || !command) {
    (v.help ? console.log : console.error)(USAGE);
    return v.help ? 0 : 2;
  }
  const need = (n: number, what: string): string[] => {
    if (args.length !== n) throw new UsageError(`${command} expects ${what}`);
    return args;
  };
  const print = (human: () => void, json: unknown): void => {
    if (v.json) console.log(JSON.stringify(json, null, 2));
    else if (!v.quiet) human();
  };
  const started = performance.now();

  switch (command) {
    case 'compress': {
      const [input, output] = need(2, '<in> <out>');
      const max = num(v.max, 'max');
      const images = compressImages({
        codec: new SharpImageCodec({ progressive: v.progressive }),
        maxWidth: num(v['max-width'], 'max-width') ?? max,
        maxHeight: num(v['max-height'], 'max-height') ?? max,
        jpegQuality: num(v.quality, 'quality'),
        minImageBytes: num(v['min-bytes'], 'min-bytes'),
        minSavingsRatio: num(v['min-savings'], 'min-savings'),
        preserveGray: !v['no-gray'],
      });
      const plugins: Plugin[] = [images];
      if (v.streams) plugins.push(recompressStreams());
      if (v.strip) plugins.push(stripMetadata());
      if (v.strip || v.gc) plugins.push(removeUnused());
      const showProgress = !v.quiet && !v.json && process.stderr.isTTY;
      const src = await NodeFileSource.open(input);
      let r;
      try {
        r = await toFile(output, (sink) =>
          rewritePdf(src, sink, plugins, {
            concurrency: num(v.concurrency, 'concurrency'),
            onProgress: showProgress
              ? (e) => process.stderr.write(`\r${e.processedObjects}/${e.totalObjects} objects, ${mb(e.bytesSaved)} saved `)
              : undefined,
          }),
        );
      } finally {
        await src.close();
      }
      if (showProgress) process.stderr.write('\n');
      const seconds = (performance.now() - started) / 1000;
      const peakRss = process.resourceUsage().maxRSS * 1024;
      const report = { ...images.report, ...r };
      print(() => {
        const pct = r.inputBytes ? (100 * (1 - r.outputBytes / r.inputBytes)).toFixed(1) : '0';
        console.log(`${input}: ${mb(r.inputBytes)} -> ${mb(r.outputBytes)} (${pct}% smaller) in ${seconds.toFixed(1)}s`);
        console.log(`images: ${report.imagesSeen} seen, ${report.imagesRecompressed} recompressed`);
        const skipped = Object.entries(report.imagesSkipped).map(([k, n]) => `${k}=${n}`);
        if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
        for (const w of r.warnings) console.log(`warning: ${w}`);
        console.log(`peak RSS: ${mb(peakRss)}`);
      }, { ...report, seconds, peakRssBytes: peakRss });
      return 0;
    }

    case 'info': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const info = await getInfo(doc);
        const pages = info.encrypted ? undefined : await getPages(doc);
        print(() => {
          const rows: [string, unknown][] = [
            ['Version', info.version], ['Pages', info.pageCount], ['Title', info.title], ['Author', info.author], ['Subject', info.subject],
            ['Keywords', info.keywords], ['Creator', info.creator], ['Producer', info.producer], ['Created', info.creationDate?.toISOString()],
            ['Modified', info.modDate?.toISOString()], ['Language', info.language], ['Encrypted', info.encrypted], ['Tagged', info.tagged],
            ['Forms', info.hasForms], ['JavaScript', info.hasJavaScript], ['Signed', info.signed], ['Attachments', info.attachments],
          ];
          for (const [k, val] of rows) if (val !== undefined && val !== '') console.log(`${`${k}:`.padEnd(13)} ${val}`);
          for (const w of info.warnings) console.log(`warning: ${w}`);
          // Page sizes, grouped: "1-12: 595 x 842 pt".
          const size = (p: NonNullable<typeof pages>[number]) => `${+p.width.toFixed(2)} x ${+p.height.toFixed(2)} pt${p.rotate ? `, rotated ${p.rotate}` : ''}`;
          for (let i = 0; pages && i < pages.length; ) {
            let j = i;
            while (j + 1 < pages.length && size(pages[j + 1]) === size(pages[i])) j++;
            console.log(`${`page${j > i ? `s ${i + 1}-${j + 1}` : ` ${i + 1}`}:`.padEnd(13)} ${size(pages[i])}`);
            i = j + 1;
          }
        }, { ...info, pages });
      });
      return 0;
    }

    case 'text': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const pages = v.pages ? parseRanges(v.pages, (await getPages(doc)).length) : undefined;
        const out = v.output ? await open(v.output, 'w') : undefined;
        try {
          let first = true;
          for await (const p of extractText(doc, { pages })) {
            const s = v.json ? `${JSON.stringify({ page: p.pageIndex + 1, text: p.text })}\n` : `${first ? '' : '\f'}${p.text}\n`;
            first = false;
            if (out) await out.write(s);
            else process.stdout.write(s);
          }
        } finally {
          await out?.close();
        }
      });
      return 0;
    }

    case 'images': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const images = await listImages(doc);
        if (!v.extract) {
          print(() => {
            for (const im of images) {
              const pages = im.pages.map((p) => p + 1).join(',');
              console.log(`${String(im.num).padStart(6)}  ${`${im.width}x${im.height}`.padEnd(11)} ${String(im.bitsPerComponent ?? '').padStart(2)}bpc  ${(im.colorSpace ?? (im.imageMask ? 'mask' : '?')).padEnd(12)} ${(im.filters.join('+') || 'raw').padEnd(22)} ${mb(im.encodedBytes).padStart(9)}  p.${pages}`);
            }
          }, images);
          return;
        }
        await mkdir(v.extract, { recursive: true });
        let saved = 0;
        let skipped = 0;
        for (const im of images) {
          const x = await extractImage(doc, im.num);
          if (!x) {
            skipped++;
            continue;
          }
          const base = join(v.extract, `image-${im.num}`);
          if (x.kind === 'pixels') {
            await sharp(x.data, { raw: { width: x.width, height: x.height, channels: x.components } }).png().toFile(`${base}.png`);
          } else {
            const fh = await open(`${base}.${x.kind === 'jpeg' ? 'jpg' : 'jp2'}`, 'w');
            await fh.write(x.data);
            await fh.close();
          }
          saved++;
        }
        print(() => console.log(`saved ${saved} image(s) to ${v.extract}${skipped ? `, skipped ${skipped} that can't be exported` : ''}`), { saved, skipped });
      });
      return 0;
    }

    case 'attachments': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const list = await listAttachments(doc);
        if (!v.extract) {
          print(() => {
            for (const a of list) {
              console.log(`${a.filename}${a.size !== undefined ? `  ${mb(a.size)}` : ''}${a.mimeType ? `  ${a.mimeType}` : ''}${a.pageIndex !== undefined ? `  (annotation on p.${a.pageIndex + 1})` : ''}${a.description ? `  ${a.description}` : ''}`);
            }
          }, list.map(({ handle: _h, ...a }) => a));
          return;
        }
        await mkdir(v.extract, { recursive: true });
        const used = new Set<string>();
        for (const a of list) {
          let name = safeName(a.filename);
          for (let i = 2; used.has(name); i++) name = `${i}-${safeName(a.filename)}`;
          used.add(name);
          const n = await saveStream(join(v.extract, name), attachmentStream(doc, a));
          if (!v.quiet && !v.json) console.log(`${name}  ${mb(n)}`);
        }
      });
      return 0;
    }

    case 'outline': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const outline = await getOutline(doc);
        print(() => (outline.length ? printOutline(outline) : console.log('(no bookmarks)')), outline);
      });
      return 0;
    }

    case 'links': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const links = await getLinks(doc);
        print(() => {
          for (const l of links) console.log(`p.${l.pageIndex + 1}  ${l.url ?? (l.targetPageIndex !== undefined ? `-> p.${l.targetPageIndex + 1}` : '?')}`);
        }, links);
      });
      return 0;
    }

    case 'fields': {
      const [input] = need(1, '<in>');
      await withDoc(input, async (doc) => {
        const fields = await getFormFields(doc);
        print(() => {
          for (const f of fields) console.log(`${f.name}  (${f.type}${f.readOnly ? ', read-only' : ''}${f.required ? ', required' : ''})  ${JSON.stringify(f.value ?? null)}`);
        }, fields);
      });
      return 0;
    }

    case 'clean': {
      const [input, output] = need(2, '<in> <out>');
      const plugins: Plugin[] = [];
      if (!v['keep-metadata']) plugins.push(stripMetadata());
      if (!v['keep-js']) plugins.push(removeJavaScript());
      if (!v['keep-attachments']) plugins.push(removeAttachments());
      plugins.push(removeUnused());
      const src = await NodeFileSource.open(input);
      try {
        const r = await toFile(output, (sink) => rewritePdf(src, sink, plugins));
        print(() => console.log(`${input}: ${mb(r.inputBytes)} -> ${mb(r.outputBytes)}`), r);
      } finally {
        await src.close();
      }
      return 0;
    }

    case 'pages':
    case 'rotate': {
      const [input, output, spec] = need(3, command === 'pages' ? '<in> <out> <pages>' : '<in> <out> <degrees>');
      const src = await NodeFileSource.open(input);
      try {
        const doc = await openPdf(src);
        const count = (await getPages(doc)).length;
        let plugin: Plugin;
        if (command === 'pages') plugin = selectPages(parseRanges(spec, count));
        else {
          const deg = Number(spec);
          if (!Number.isInteger(deg) || deg % 90) throw new UsageError('rotate expects a multiple of 90 degrees');
          const only = v.pages ? new Set(parseRanges(v.pages, count)) : undefined;
          plugin = rotatePages((i, cur) => (only && !only.has(i) ? cur : cur + deg));
        }
        const r = await toFile(output, (sink) => rewritePdf(doc, sink, [plugin]));
        print(() => console.log(`${output}: ${mb(r.outputBytes)}`), r);
      } finally {
        await src.close();
      }
      return 0;
    }

    case 'merge': {
      if (args.length < 2) throw new UsageError('merge expects <out> <in>[:pages] <in>[:pages]...');
      const [output, ...specs] = args;
      const sources: NodeFileSource[] = [];
      try {
        const docs: PdfDocument[] = [];
        const pages: (number[] | undefined)[] = [];
        for (const spec of specs) {
          // "file.pdf:1-3,5" selects pages; a colon followed by anything else is part of the path.
          const m = /^(.*):([\d,\s-]+)$/.exec(spec);
          const path = m ? m[1] : spec;
          const src = await NodeFileSource.open(path);
          sources.push(src);
          const doc = await openPdf(src);
          docs.push(doc);
          pages.push(m ? parseRanges(m[2], (await getPages(doc)).length) : undefined);
        }
        const r = await toFile(output, (sink) => mergePdfs(docs, sink, { pages }));
        print(() => {
          console.log(`${output}: ${r.pageCount} pages, ${mb(r.outputBytes)}`);
          for (const w of r.warnings) console.log(`warning: ${w}`);
        }, r);
      } finally {
        for (const s of sources) await s.close();
      }
      return 0;
    }

    case 'decrypt': {
      const [input, output] = need(2, '<in> <out>');
      const password = v.password ?? process.env.LEANPDF_PASSWORD;
      const src = await NodeFileSource.open(input);
      try {
        const r = await toFile(output, (sink) => decryptPdf(src, sink, { password }));
        print(() => console.log(r.encrypted ? `${output}: decrypted (${r.method}, ${r.password} password)` : `${input} was not encrypted; copied`), r);
      } finally {
        await src.close();
      }
      return 0;
    }

    case 'repair': {
      const [input, output] = need(2, '<in> <out>');
      const src = await NodeFileSource.open(input);
      try {
        const r = await toFile(output, (sink) => repairPdf(src, sink));
        print(() => {
          console.log(`${output}: ${mb(r.outputBytes)}${r.xrefRepaired ? ', cross-reference table rebuilt' : ''}`);
          for (const w of r.warnings) console.log(`warning: ${w}`);
        }, r);
      } finally {
        await src.close();
      }
      return 0;
    }

    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`leanpdf: ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`leanpdf: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof PdfPasswordError ? 3 : 1);
  },
);
