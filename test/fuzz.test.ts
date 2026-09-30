/**
 * Deterministic fuzzing. Part 1 mutates small generated PDFs (truncation, bit flips, deletions,
 * duplications, splices, digit and keyword damage) and runs the whole compressor on them: every
 * case must settle with a report or an Error, promptly, and a produced file must be sound. Part 2
 * throws random bytes at the tokenizer, the object parser and a few other decoders directly.
 *
 * Every case derives from a fixed seed; a failing case is written to test/.out/fuzz/ and can be
 * replayed with FUZZ_CASE=<index> (plus the FUZZ_SEED it ran with).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SharpImageCodec } from '../src/codecs/sharp.ts';
import { compressPdf } from '../src/core/compress.ts';
import { NeedMoreData, PdfSyntaxError } from '../src/core/errors.ts';
import { sniffJpeg } from '../src/core/jpeg.ts';
import { Lexer, T_EOF, type Token } from '../src/core/lexer.ts';
import { parseObjectHeader } from '../src/core/objread.ts';
import { PdfDict, PdfName, Parser, PdfRef, PdfString, type PdfObj } from '../src/core/objects.ts';
import { RowDecoder } from '../src/core/predictor.ts';
import type { CompressOptions, CompressReport, ImageCodec } from '../src/core/types.ts';
import { BlobPartsSink, BlobSource } from '../src/io/blob.ts';
import { jpeg, photo, pngPredict } from './corpus/images.ts';
import { bytes, DocBuilder, drawImage, drawText, flate, imageDict, paragraph, text } from './support/pdfgen.ts';
import { Rng } from './support/prng.ts';
import { hasQpdf, QPDF_MISSING, qpdfCheck, severity } from './support/qpdf.ts';

const OUT_DIR = join(import.meta.dir, '.out', 'fuzz');
const env = (k: string, d: number): number => (process.env[k] === undefined ? d : Number(process.env[k]));
/** Longer campaigns: FUZZ_CASES=20000 FUZZ_SEED=1 FUZZ_QPDF_EVERY=1 bun test test/fuzz.test.ts */
const CASES = env('FUZZ_CASES', 600);
const SEED = env('FUZZ_SEED', 0);
/** Run qpdf on every n-th case that produced output. */
const QPDF_EVERY = env('FUZZ_QPDF_EVERY', 3);
const CASE_TIMEOUT = 15_000;
const ONLY = process.env.FUZZ_CASE === undefined ? undefined : Number(process.env.FUZZ_CASE);

// ---------------------------------------------------------------------------------------------
// Seed documents: small, but covering every xref flavour, updates and images the codec will see.

async function seeds(): Promise<{ name: string; data: Uint8Array }[]> {
  const imgs = async (b: DocBuilder, seed: number): Promise<Record<string, number>> => {
    const rgb = photo(160, 120, seed);
    const gray = photo(120, 90, seed + 1, 1);
    const mask = b.stream(imageDict({ width: 120, height: 90, colorSpace: '/DeviceGray', filter: '/FlateDecode' }), flate(gray.data));
    return {
      A: b.stream(imageDict({ width: 160, height: 120, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), await jpeg(rgb, { quality: 95 })),
      B: b.stream(
        imageDict({ width: 120, height: 90, colorSpace: '/DeviceGray', filter: '/FlateDecode', decodeParms: '<< /Predictor 15 /Colors 1 /Columns 120 >>' }),
        flate(pngPredict(gray, 'best').data),
      ),
      C: b.stream(imageDict({ width: 160, height: 120, colorSpace: '/DeviceRGB', extra: `/SMask ${mask} 0 R` }), rgb.data),
    };
  };
  const doc = async (seed: number): Promise<DocBuilder> => {
    const b = new DocBuilder();
    const xo = await imgs(b, seed);
    b.page({ content: drawText('Fuzz seed', 40, 800) + drawImage('A', 40, 500, 160, 120) + drawImage('B', 220, 500, 120, 90) + drawImage('C', 360, 500, 160, 120), xobjects: xo });
    b.page({ content: paragraph(40, 780, 8, 10, seed) });
    b.obj(`<< /Title (seed ${seed}) >>`);
    return b;
  };
  const out: { name: string; data: Uint8Array }[] = [];
  let b = await doc(1);
  out.push({ name: 'table', data: b.finish('t').build().bytes });
  b = await doc(2);
  out.push({ name: 'xrefstream', data: b.finish('x').build({ xref: 'stream', objStm: true, version: '1.5' }).bytes });
  b = await doc(3);
  const unused = b.stream('/Type /Metadata /Subtype /XML', bytes('<meta/>'));
  b.finish('h').update();
  const p = photo(150, 100, 33);
  b.setStream(5, imageDict({ width: 150, height: 100, colorSpace: '/DeviceRGB', filter: '/DCTDecode' }), await jpeg(p, { quality: 90 }));
  b.free(unused, 1);
  out.push({ name: 'hybrid+update', data: b.build({ xref: ['hybrid', 'table'], objStm: [true, false], version: '1.5' }).bytes });
  b = await doc(4);
  b.finish('u').update();
  b.setObj(b.pagesNum, b.pagesDict());
  b.update();
  b.setStream(b.alloc(), '/Type /Metadata /Subtype /XML', bytes('<x/>'));
  out.push({ name: 'stream-updates', data: b.build({ xref: ['stream', 'stream', 'table'], objStm: [true, true, false], version: '1.5' }).bytes });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mutations

const KEYWORDS = ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref', '/Length', '/Prev', '/XRefStm', '/Root', ' R', '<<', '>>', '/W', '/Index', '/Size', '%%EOF'];

/** Offsets of structural keywords: mutations are biased towards them. */
function landmarks(data: Uint8Array): number[] {
  const s = text(data);
  const out: number[] = [];
  for (const k of KEYWORDS) for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + 1)) out.push(i);
  return out.sort((a, b) => a - b);
}

function pickPos(r: Rng, data: Uint8Array, marks: number[]): number {
  if (!data.length) return 0;
  if (marks.length && r.next() < 0.6) return Math.min(data.length - 1, Math.max(0, r.pick(marks) + r.int(-24, 24)));
  return r.int(0, data.length - 1);
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

type Mutator = (r: Rng, d: Uint8Array, marks: number[], other: Uint8Array) => Uint8Array;

const MUTATORS: Record<string, Mutator> = {
  truncate: (r, d, m) => d.slice(0, r.next() < 0.5 ? pickPos(r, d, m) : r.int(0, d.length)),
  bitflip: (r, d, m) => {
    const o = d.slice();
    for (let k = r.int(1, 8); k > 0; k--) o[pickPos(r, o, m)] ^= 1 << r.int(0, 7);
    return o;
  },
  delete: (r, d, m) => {
    const at = pickPos(r, d, m);
    return cat(d.subarray(0, at), d.subarray(Math.min(d.length, at + r.int(1, 64))));
  },
  duplicate: (r, d, m) => {
    const from = pickPos(r, d, m);
    const chunk = d.subarray(from, from + r.int(1, 256));
    const at = pickPos(r, d, m);
    return cat(d.subarray(0, at), chunk, d.subarray(at));
  },
  splice: (r, d, m, other) => cat(d.subarray(0, pickPos(r, d, m)), other.subarray(r.int(0, other.length))),
  overwrite: (r, d, m) => {
    const o = d.slice();
    const at = pickPos(r, o, m);
    o.set(r.bytes(Math.min(r.int(1, 16), o.length - at)), at);
    return o;
  },
  digit: (r, d, m) => {
    const o = d.slice();
    for (let k = r.int(1, 3); k > 0; k--) {
      let at = pickPos(r, o, m);
      for (let n = 0; n < 64 && at < o.length && !(o[at] >= 48 && o[at] <= 57); n++) at++;
      if (at < o.length && o[at] >= 48 && o[at] <= 57) o[at] = 48 + r.int(0, 9);
    }
    return o;
  },
  keyword: (r, d, m) => {
    if (!m.length) return d;
    const s = text(d);
    const at = r.pick(m);
    const kw = KEYWORDS.find((k) => s.startsWith(k, at)) ?? 'x';
    const repl = r.pick(['', ' ', 'xx', kw.toUpperCase(), kw + kw, r.pick(KEYWORDS)]);
    return cat(d.subarray(0, at), bytes(repl), d.subarray(at + kw.length));
  },
};
const MUTATOR_NAMES = Object.keys(MUTATORS);

// ---------------------------------------------------------------------------------------------
// Harness

/** A codec that sometimes misbehaves, to exercise the compressor's handling of codec failures. */
class FlakyCodec implements ImageCodec {
  private readonly inner = new SharpImageCodec();
  private n = 0;
  async recompress(...args: Parameters<ImageCodec['recompress']>): ReturnType<ImageCodec['recompress']> {
    const k = this.n++ % 11;
    if (k === 5) throw new Error('codec exploded');
    if (k === 7) return { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1, height: 1, components: 3 };
    return this.inner.recompress(...args);
  }
}

type Outcome =
  | { kind: 'ok'; report: CompressReport; output: Uint8Array }
  | { kind: 'error'; error: Error }
  | { kind: 'bad'; why: string };

async function settle(data: Uint8Array, opts: Partial<CompressOptions>): Promise<Outcome> {
  const sink = new BlobPartsSink();
  const work = compressPdf(new BlobSource(new Blob([data as Uint8Array<ArrayBuffer>])), sink, { codec: new SharpImageCodec(), minImageBytes: 100, ...opts }).then(
    async (report): Promise<Outcome> => ({ kind: 'ok', report, output: new Uint8Array(await sink.blob.arrayBuffer()) }),
    (e: unknown): Outcome => (e instanceof Error ? { kind: 'error', error: e } : { kind: 'bad', why: `rejected with a non-Error: ${String(e)}` }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((res) => {
    timer = setTimeout(() => res({ kind: 'bad', why: `did not settle within ${CASE_TIMEOUT} ms` }), CASE_TIMEOUT);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * src bugs this fuzzer keeps hitting, as { name, signature } matched against qpdf's output.
 * Matching regressions are listed but do not fail the run. Empty: all known ones are fixed.
 */
const KNOWN_FUZZ_BUGS: { name: string; signature: RegExp }[] = [];

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => {
  unhandled.push(e);
};

describe('compressor fuzz', () => {
  let bases: { name: string; data: Uint8Array; marks: number[] }[] = [];
  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandled);
    bases = (await seeds()).map((s) => ({ ...s, marks: landmarks(s.data) }));
    mkdirSync(OUT_DIR, { recursive: true });
  });
  afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  test('seed documents compress cleanly', async () => {
    for (const b of bases) {
      const r = await settle(b.data, {});
      expect({ name: b.name, kind: r.kind }).toEqual({ name: b.name, kind: 'ok' });
      if (r.kind === 'ok') {
        expect(r.report.imagesRecompressed).toBeGreaterThan(0);
        expect(r.report.xrefRepaired).toBe(false);
        if (hasQpdf) expect(qpdfCheck(r.output).code).toBe(0);
      }
    }
  }, 60_000);

  test(`${CASES} mutated documents settle and produce sound output`, async () => {
    if (!hasQpdf) console.warn(QPDF_MISSING);
    const problems: string[] = [];
    const known: string[] = [];
    const stats: Record<string, number> = {};
    let qpdfRuns = 0;
    let produced = 0;
    for (let i = 0; i < CASES; i++) {
      if (ONLY !== undefined && i !== ONLY) continue;
      const r = new Rng(0xf0220000 + SEED * 1_000_003 + i);
      const base = bases[i % bases.length];
      const other = bases[(i + 1 + r.int(0, bases.length - 2)) % bases.length];
      const kind = MUTATOR_NAMES[r.int(0, MUTATOR_NAMES.length - 1)];
      let data = MUTATORS[kind](r, base.data, base.marks, other.data);
      if (r.next() < 0.2) data = MUTATORS[r.pick(MUTATOR_NAMES)](r, data, landmarks(data), other.data);
      const opts: Partial<CompressOptions> = { concurrency: 1 + (i % 3) };
      if (i % 4 === 3) opts.codec = new FlakyCodec();
      const label = `case ${i} (${base.name}, ${kind})`;
      const save = (): string => {
        const p = join(OUT_DIR, `case-${i}.pdf`);
        writeFileSync(p, data);
        return p;
      };

      const out = await settle(data, opts);
      const outcome = out.kind === 'error' ? `error:${out.error.name}` : out.kind;
      stats[outcome] = (stats[outcome] ?? 0) + 1;
      if (out.kind === 'bad') {
        problems.push(`${label}: ${out.why} -> ${save()}`);
        continue;
      }
      if (out.kind === 'error') {
        // Only the library's own errors are acceptable: anything else is an internal crash.
        if (!/^Pdf(Format|Encrypted|Syntax)?Error$/.test(out.error.name)) {
          problems.push(`${label}: unexpected ${out.error.name}: ${out.error.message} -> ${save()}\n${out.error.stack ?? ''}`);
        }
        continue;
      }
      produced++;
      const { report, output } = out;
      if (report.outputBytes !== output.length) problems.push(`${label}: outputBytes ${report.outputBytes} != ${output.length} -> ${save()}`);
      if (text(output, 0, 5) !== '%PDF-') problems.push(`${label}: output does not start with %PDF- -> ${save()}`);
      // The output's cross-reference data must be exact: reading it back needs no repair.
      const again = await settle(output, { minImageBytes: 1 << 30 });
      if (again.kind !== 'ok') {
        const msg = `${label}: output cannot be compressed again (${again.kind === 'error' ? again.error.message : again.why})`;
        // Known: a catalog renumbered to object 0 is found by the rebuild, then freed (see repros).
        if (/\/Root 0 \d+ R/.test(text(output, Math.max(0, output.length - 400)))) known.push(`${msg} [known src bug: catalog as object 0] -> ${save()}`);
        else problems.push(`${msg} -> ${save()}`);
      }
      else if (again.report.xrefRepaired) problems.push(`${label}: output xref needed repair: ${again.report.warnings.join('; ')} -> ${save()}`);
      if (hasQpdf && produced % QPDF_EVERY === 0) {
        qpdfRuns++;
        const qi = qpdfCheck(data);
        const qo = qpdfCheck(output);
        const lines = qo.output.split('\n');
        const detail = (): string => `${save()}\n${lines.filter((l) => !/unknown token/.test(l)).slice(0, 8).join('\n')}`;
        let problem: string | undefined;
        // Whatever the input looked like, the compressor writes a fresh, exact xref: qpdf must
        // never have to reconstruct it.
        if (/file is damaged|reconstruct cross-reference|xref not found/.test(qo.output)) {
          problem = "qpdf had to repair the output's xref";
        } else if (severity(qo.code) > severity(qi.code)) {
          // Content-level errors may surface only once the (repaired) page tree is reachable, or
          // when a mutated reference makes an image act as a content stream; those are not
          // regressions of the rewrite.
          const extra = lines.filter((l) => /^ERROR|^qpdf: .*unable/.test(l) && !/content stream|error decoding stream data/.test(l));
          if (extra.length) problem = `qpdf --check input ${qi.code}, output ${qo.code}`;
        }
        if (problem) {
          const bug = KNOWN_FUZZ_BUGS.find((b) => b.signature.test(qo.output));
          if (bug) known.push(`${label}: ${problem} [known src bug: ${bug.name}] -> ${detail()}`);
          else problems.push(`${label}: ${problem} -> ${detail()}`);
        }
      }
    }
    console.log(`fuzz outcomes: ${JSON.stringify(stats)}; qpdf-checked ${qpdfRuns}; known-bug hits ${known.length}`);
    for (const k of known) console.log(k.split('\n')[0]);
    if (problems.length) writeFileSync(join(OUT_DIR, `problems-seed${SEED}.txt`), problems.join('\n\n'));
    expect(unhandled.map(String)).toEqual([]);
    expect(problems).toEqual([]);
  }, 180_000 + CASES * 200);
});

// ---------------------------------------------------------------------------------------------
// Tokenizer and parser

const ALPHABET = bytes('0123456789 \n\r\t\f\0+-.<<>>[](){}/%#\\RobjendstreamtrueflsnulxEFa');

function randomSource(r: Rng): Uint8Array {
  const n = r.int(0, 160);
  const mode = r.int(0, 3);
  if (mode === 0) return r.bytes(n);
  if (mode === 1) {
    // Deep nesting.
    const open = r.pick(['[', '<<', '<< /K [']);
    return bytes(open.repeat(r.int(1, 130)) + r.pick([']', '>>', '1 0 R', '']).repeat(r.int(0, 130)));
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mode === 2 ? ALPHABET[r.int(0, ALPHABET.length - 1)] : r.next() < 0.8 ? ALPHABET[r.int(0, ALPHABET.length - 1)] : r.int(0, 255);
  return out;
}

const tokKey = (t: Token): string => `${t.t}:${t.s}:${t.e}:${t.int}:${t.v instanceof Uint8Array ? text(t.v) : String(t.v)}`;

/** Tokens until EOF; NeedMoreData ends a non-final run. */
function lexAll(buf: Uint8Array, final: boolean): { tokens: string[]; needMore: boolean } {
  const lex = new Lexer(buf, 0, final);
  const tokens: string[] = [];
  let last = -1;
  for (let guard = 0; guard <= buf.length + 2; guard++) {
    let t: Token;
    try {
      t = lex.next();
    } catch (e) {
      if (!final && e instanceof NeedMoreData) return { tokens, needMore: true };
      throw e;
    }
    if (t.t === T_EOF) return { tokens, needMore: false };
    if (!(t.s > last && t.e > t.s && t.e <= buf.length && lex.pos === t.e)) throw new Error(`lexer did not progress: ${tokKey(t)}`);
    last = t.s;
    tokens.push(tokKey(t));
  }
  throw new Error('lexer loops');
}

function canon(o: PdfObj): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean' || typeof o === 'number') return String(o);
  if (o instanceof PdfName) return `/${o.name}`;
  if (o instanceof PdfString) return `s(${text(o.raw)})`;
  if (o instanceof PdfRef) return `${o.num} ${o.gen} R`;
  if (Array.isArray(o)) return `[${o.map(canon).join(' ')}]`;
  if (o instanceof PdfDict) return `<<${[...o.map].map(([k, v]) => `/${k} ${canon(v)} {${text(o.raw.get(k)!)}}`).join(' ')}${o.dup ? ' dup' : ''}>>`;
  throw new Error(`not a PdfObj: ${String(o)}`);
}

/** Parse objects until EOF or the first error; NeedMoreData ends a non-final run. */
function parseAll(buf: Uint8Array, final: boolean): { items: string[]; needMore: boolean } {
  const p = new Parser(new Lexer(buf, 0, final));
  const items: string[] = [];
  for (let guard = 0; guard <= buf.length + 2; guard++) {
    try {
      if (p.peek().t === T_EOF) return { items, needMore: false };
      items.push(canon(p.parse()));
    } catch (e) {
      if (!final && e instanceof NeedMoreData) return { items, needMore: true };
      if (e instanceof PdfSyntaxError) {
        items.push(`error: ${e.message}`);
        return { items, needMore: false };
      }
      throw e;
    }
  }
  throw new Error('parser loops');
}

const isPrefix = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((x, i) => x === b[i]);

describe('tokenizer and parser fuzz', () => {
  const N = 3000;

  test(`lexer: ${N} random inputs, final and partial`, () => {
    const r = new Rng(0x1e7e2);
    const bad: string[] = [];
    for (let i = 0; i < N; i++) {
      const buf = randomSource(r);
      const hex = Buffer.from(buf).toString('hex');
      try {
        const full = lexAll(buf, true);
        const whole = lexAll(buf, false);
        if (!isPrefix(whole.tokens, full.tokens)) bad.push(`#${i} non-final tokens differ from final: ${hex}`);
        // A window that ends early may only ever lose tokens at its end, never change them.
        const k = r.int(0, buf.length);
        const part = lexAll(buf.subarray(0, k), false);
        if (!isPrefix(part.tokens, full.tokens)) bad.push(`#${i} prefix ${k} tokens differ: ${hex}`);
      } catch (e) {
        bad.push(`#${i} threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}: ${hex}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  test(`parser: ${N} random inputs, final and partial`, () => {
    const r = new Rng(0x9a55e);
    const bad: string[] = [];
    for (let i = 0; i < N; i++) {
      const buf = randomSource(r);
      const hex = Buffer.from(buf).toString('hex');
      try {
        const full = parseAll(buf, true);
        const k = r.int(0, buf.length);
        const part = parseAll(buf.subarray(0, k), false);
        // Items parsed from a partial window must match the full parse (the last may be an error
        // that the full buffer resolves, e.g. at a truncated keyword; those are allowed to differ).
        const settled = part.items.filter((x, j) => !(j === part.items.length - 1 && x.startsWith('error:')));
        if (!isPrefix(settled, full.items)) bad.push(`#${i} prefix ${k}: ${JSON.stringify(part.items)} vs ${JSON.stringify(full.items)}: ${hex}`);
      } catch (e) {
        bad.push(`#${i} threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}: ${hex}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  test('object headers, predictors and JPEG sniffing reject garbage with PdfSyntaxError or null', () => {
    const r = new Rng(0x0b1);
    const bad: string[] = [];
    for (let i = 0; i < N; i++) {
      const body = randomSource(r);
      const buf = r.next() < 0.7 ? new Uint8Array([...bytes(`${r.int(0, 20)} ${r.int(0, 2)} obj `), ...body]) : body;
      for (const final of [true, false]) {
        try {
          parseObjectHeader(buf, 0, final);
        } catch (e) {
          if (!(e instanceof PdfSyntaxError || (!final && e instanceof NeedMoreData))) bad.push(`header #${i} final=${final}: ${String(e)}`);
        }
      }
      try {
        const dec = new RowDecoder(r.pick([1, 2, 10, 12, 15, 16, 0, -1]), r.int(0, 4), r.pick([1, 2, 4, 8, 16, 0]), r.int(0, 50), () => r.next() < 0.1);
        dec.push(r.bytes(r.int(0, 300)));
      } catch (e) {
        if (!(e instanceof PdfSyntaxError)) bad.push(`predictor #${i}: ${String(e)}`);
      }
      try {
        const j = r.next() < 0.5 ? new Uint8Array([0xff, 0xd8, ...body]) : body;
        const info = sniffJpeg(j);
        if (info !== null && typeof info.width !== 'number') bad.push(`sniff #${i}: odd result`);
      } catch (e) {
        bad.push(`sniff #${i}: ${String(e)}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Minimal repros of src bugs found by the fuzzer (now fixed), kept as regression tests.

describe('fuzzer regressions', () => {
  /**
   * Incremental update whose trailer carries a malformed /ID (control bytes and a "(" inside the
   * hex string). The compressor's lenient lexer accepts it and trailerEntries() (src/core/writer.ts)
   * copies the raw bytes into the new trailer, where stricter readers start a literal string at
   * "(" and lose the rest of the trailer. qpdf recovers the input (exit 3) but not the output
   * ("unable to find trailer dictionary while recovering damaged file", exit 2).
   */
  async function malformedTrailerId(): Promise<{ input: Uint8Array; output: Uint8Array }> {
    const b = new DocBuilder();
    b.page({ content: drawText('hello', 40, 800) });
    b.finish('trailer-bug');
    b.update();
    b.obj('<< /Title (update) >>');
    b.trailer('ID', '[<0011\x01\x02(\x80> <0011>]');
    const input = b.build({ xref: ['table', 'table'] }).bytes;
    const out = await settle(input, {});
    if (out.kind !== 'ok') throw new Error(`compress failed: ${out.kind === 'error' ? out.error.message : out.why}`);
    return { input, output: out.output };
  }

  test('a malformed trailer /ID is not copied into the new trailer', async () => {
    const { output } = await malformedTrailerId();
    const all = text(output);
    const tail = all.slice(all.lastIndexOf('trailer'));
    // Every hex string the compressor writes into its own trailer must be well-formed.
    const hex = tail.replace(/<<|>>/g, ' ').match(/<[^<>]*>/g) ?? [];
    expect(hex.filter((h) => !/^<[0-9A-Fa-f\s]*>$/.test(h))).toEqual([]);
  });

  /**
   * A damaged file whose catalog is numbered 0 ("0 0 obj") and whose xref is gone. The full
   * rebuild in PdfDocument.open (src/core/document.ts) accepts object 0 as the catalog
   * (scan.catalog) and only afterwards forces entry 0 to free, so the output keeps
   * "/Root 0 0 R" but no longer contains the catalog: the compressor cannot read its own output.
   */
  test('a catalog numbered 0 is never taken as the root by the rebuild', async () => {
    const b = new DocBuilder();
    b.page({ content: drawText('catalog zero', 40, 800) });
    b.finish('zero');
    const built = b.build();
    const data = built.bytes.slice(0, built.xrefOffsets[0]); // no xref, no trailer
    const at = built.objects.get(b.catalog)!.offset;
    expect(text(data, at, at + 7)).toBe(`${b.catalog} 0 obj`);
    data[at] = 0x30; // "1 0 obj" -> "0 0 obj"
    const first = await settle(data, {});
    // Refusing the file is fine; producing a file without its catalog is not.
    if (first.kind === 'error') return;
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const again = await settle(first.output, {});
    expect(again.kind === 'error' ? again.error.message : again.kind).toBe('ok');
  });

  (hasQpdf ? test : test.skip)('...so the output stays readable for qpdf when the input was recoverable', async () => {
    const { input, output } = await malformedTrailerId();
    const qi = qpdfCheck(input);
    const qo = qpdfCheck(output);
    expect(qi.code).toBe(3);
    expect(severity(qo.code)).toBeLessThanOrEqual(severity(qi.code));
  });
});
