#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { SharpImageCodec } from './codecs/sharp.ts';
import { compressPdfFile } from './io/node.ts';

const USAGE = `Usage: pdf-squeeze <in.pdf> <out.pdf> [options]

Recompresses and downscales the raster images in a PDF.

Options:
  --max <px>           Max image width and height (default 1600)
  --max-width <px>     Max image width
  --max-height <px>    Max image height
  -q, --quality <0-1>  JPEG quality (default 0.75)
  --min-bytes <n>      Skip image streams smaller than this (default 20000)
  --min-savings <r>    Keep a result only if new <= old * r (default 0.9)
  -j, --concurrency <n> Images processed in parallel (default 1)
  --no-gray            Encode grayscale images as RGB
  --progressive        Write progressive JPEGs
  --json               Print the report as JSON
  --quiet              Print nothing on success
  -h, --help           Show this help`;

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got "${v}"`);
  return n;
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
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
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 2) {
    (values.help ? console.log : console.error)(USAGE);
    return values.help ? 0 : 2;
  }
  const [input, output] = positionals;
  const max = num(values.max, 'max');
  const showProgress = !values.quiet && !values.json && process.stderr.isTTY;
  const started = performance.now();
  const report = await compressPdfFile(input, output, {
    codec: new SharpImageCodec({ progressive: values.progressive }),
    maxWidth: num(values['max-width'], 'max-width') ?? max,
    maxHeight: num(values['max-height'], 'max-height') ?? max,
    jpegQuality: num(values.quality, 'quality'),
    minImageBytes: num(values['min-bytes'], 'min-bytes'),
    minSavingsRatio: num(values['min-savings'], 'min-savings'),
    concurrency: num(values.concurrency, 'concurrency'),
    preserveGray: !values['no-gray'],
    onProgress: showProgress
      ? (e) => process.stderr.write(`\r${e.processedObjects}/${e.totalObjects} objects, ${mb(e.bytesSaved)} saved `)
      : undefined,
  });
  if (showProgress) process.stderr.write('\n');
  const seconds = (performance.now() - started) / 1000;
  const peakRss = process.resourceUsage().maxRSS * 1024;
  if (values.json) {
    console.log(JSON.stringify({ ...report, seconds, peakRssBytes: peakRss }, null, 2));
  } else if (!values.quiet) {
    const pct = report.inputBytes ? (100 * (1 - report.outputBytes / report.inputBytes)).toFixed(1) : '0';
    console.log(`${input}: ${mb(report.inputBytes)} -> ${mb(report.outputBytes)} (${pct}% smaller) in ${seconds.toFixed(1)}s`);
    console.log(`images: ${report.imagesSeen} seen, ${report.imagesRecompressed} recompressed`);
    const skipped = Object.entries(report.imagesSkipped).map(([k, v]) => `${k}=${v}`);
    if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
    for (const w of report.warnings) console.log(`warning: ${w}`);
    console.log(`peak RSS: ${mb(peakRss)}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`pdf-squeeze: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
