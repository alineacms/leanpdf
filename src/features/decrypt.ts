/**
 * Decryption of password-protected PDFs (standard security handler, RC4 and AES, R2-R6) as a
 * rewrite plugin: every string and stream is decrypted in one forward pass and the /Encrypt
 * dictionary is dropped.
 */
import { ascii, concat, EMPTY, latin1 } from '../core/bytes.ts';
import { PdfDocument } from '../core/document.ts';
import { PdfError, PdfFormatError } from '../core/errors.ts';
import { inflateAll } from '../core/flate.ts';
import { Lexer, T_ACLOSE, T_AOPEN, T_DCLOSE, T_DOPEN, T_EOF, T_NAME, T_STR, type Token } from '../core/lexer.ts';
import { intOf, nameOf, PdfDict, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import type { ObjHeader } from '../core/objread.ts';
import { RowDecoder } from '../core/predictor.ts';
import { SourceReader } from '../core/reader.ts';
import { rewritePdf, type Plugin, type RewriteOptions, type RewriteReport } from '../core/rewrite.ts';
import { dictString, serialize } from '../core/serialize.ts';
import { stringBytes } from '../core/strings.ts';
import type { OutputSink, RandomAccessSource } from '../core/types.ts';
import { BlobSource } from '../io/blob.ts';
import { AESV2, AESV3, authenticate, NONE, type Decrypt, type Security } from './crypto-handler.ts';

/** The password matches neither the user password nor the owner password. */
export class PdfPasswordError extends PdfError {
  override name = 'PdfPasswordError';
  constructor() {
    super('Incorrect password: it matches neither the user nor the owner password');
  }
}

export interface DecryptOptions {
  /** User or owner password. Default: the empty user password, which most files use. */
  password?: string;
}

export interface DecryptReport {
  /** The input was encrypted (and the output is not). */
  encrypted: boolean;
  /** How the input was encrypted, e.g. "AES-256 (R6)". */
  method?: string;
  /** Which password matched. */
  password?: 'user' | 'owner';
}

/** Read size for stream data; a multiple of the AES block size. */
const CHUNK = 256 << 10;
/** Streams up to this size are decrypted right away; larger ones are streamed when written. */
const INLINE = 64 << 10;

/** Does the document have an /Encrypt entry (so it needs decrypting before anything else)? */
export const isEncrypted = (doc: PdfDocument): boolean => doc.trailer.get('Encrypt') !== undefined;

/**
 * Which password `password` is for the encrypted `doc`: 'user', 'owner', or null for neither.
 * Throws PdfFormatError if the document is not encrypted or its /Encrypt dictionary is malformed,
 * and PdfEncryptedError if it uses a security handler or cipher that cannot be decrypted.
 */
export async function checkPassword(doc: PdfDocument, password: string): Promise<'user' | 'owner' | null> {
  return (await authenticate(doc, password))?.password ?? null;
}

const handlers = /* @__PURE__ */ new WeakMap<PdfDocument, { pw: string; sec: Security }>();

/**
 * Authenticate once per document and password, and let the document read encrypted object
 * streams (their members are not encrypted individually), so compressed objects resolve.
 */
async function security(doc: PdfDocument, password: string): Promise<Security> {
  const c = handlers.get(doc);
  if (c?.pw === password) return c.sec;
  const sec = await authenticate(doc, password);
  if (!sec) {
    // R2-R4 keys depend on the first /ID string; a rebuilt file may have lost it with the trailer.
    const e = await doc.resolve(doc.trailer.get('Encrypt'));
    if (doc.repaired && doc.trailer.get('ID') === undefined && e instanceof PdfDict && (intOf(e.get('R')) ?? 0) < 5) {
      throw new PdfFormatError('The file is damaged: its trailer, whose /ID is needed to decrypt it, is lost');
    }
    throw new PdfPasswordError();
  }
  handlers.set(doc, { pw: password, sec });
  doc.streamData = (hdr, max) => plainStreamData(doc, sec, hdr, max);
  return sec;
}

interface StreamPlan {
  cipher: number;
  filters: PdfObj[];
  parms: (PdfObj | undefined)[];
  /** Index of a /Crypt filter in `filters`, or -1. */
  crypt: number;
}

/** How a stream is encrypted: a /Crypt filter, or the default for its type (7.6.5). */
async function streamPlan(doc: PdfDocument, sec: Security, d: PdfDict, warn?: (m: string) => void): Promise<StreamPlan> {
  const f = await doc.resolve(d.get('Filter'));
  const p = await doc.resolve(d.get('DecodeParms'));
  const filters = Array.isArray(f) ? f : f === undefined || f === null ? [] : [f];
  const parms = Array.isArray(p) ? p : [p];
  const crypt = filters.findIndex((x) => nameOf(x) === 'Crypt');
  let cipher: number;
  if (crypt >= 0) {
    const cp = await doc.resolve(parms[crypt]);
    const name = (cp instanceof PdfDict ? nameOf(await doc.resolve(cp.get('Name'))) : undefined) ?? 'Identity';
    const c = sec.filter(name);
    if (c === undefined) warn?.(`Unknown or unsupported crypt filter /${name}; stream data left as is`);
    cipher = c ?? NONE;
  } else {
    const type = nameOf(await doc.resolve(d.get('Type')));
    cipher = type === 'XRef' || (type === 'Metadata' && !sec.meta) ? NONE : type === 'EmbeddedFile' ? sec.eff : sec.stm;
  }
  return { cipher, filters, parms, crypt };
}

/** Decrypt [start, start+len) of the source, reading it in bounded chunks. */
async function* decrypted(reader: SourceReader, start: number, len: number, dec: Decrypt): AsyncGenerator<Uint8Array> {
  for (let pos = start, end = start + len; ; ) {
    const n = Math.min(CHUNK, end - pos);
    const c = n > 0 ? await reader.raw(pos, n) : EMPTY;
    pos += c.length;
    const last = pos >= end || c.length < n;
    const out = await dec(c, last);
    if (out.length) yield out;
    if (last) return;
  }
}

/** The decrypted length of `len` bytes at `start`, without decrypting them: AES reads the last two blocks. */
async function plainLength(reader: SourceReader, start: number, len: number, dec: Decrypt, cipher: number): Promise<number> {
  if (cipher !== AESV2 && cipher !== AESV3) return len;
  const n = len < 16 ? 0 : len - 16 - ((len - 16) % 16);
  if (!n) return 0;
  // The block before the last (or the IV) and the last block: the padding is in there.
  return n - 16 + (await dec(await reader.raw(start + n - 16, 32), true)).length;
}

/** `PdfDocument.streamData` for an encrypted document: decrypt, then undo Flate (+ predictor). */
async function plainStreamData(doc: PdfDocument, sec: Security, hdr: ObjHeader, max: number): Promise<Uint8Array | null> {
  const span = await doc.span(hdr, doc.reader.size);
  const len = span.dataEnd - span.dataStart;
  if (span.dataEnd < 0 || len > max) return null;
  const plan = await streamPlan(doc, sec, hdr.value as PdfDict);
  const parts: Uint8Array[] = [];
  for await (const c of decrypted(doc.reader, span.dataStart, len, sec.decryptor(plan.cipher, hdr.num, hdr.gen))) parts.push(c);
  const data = concat(parts);
  const filters = plan.filters.filter((_, i) => i !== plan.crypt);
  const parms = plan.parms.filter((_, i) => i !== plan.crypt);
  if (!filters.length) return data.length <= max ? data : null;
  const f = nameOf(filters[0]);
  if (filters.length > 1 || (f !== 'FlateDecode' && f !== 'Fl')) return null;
  const mem = new SourceReader({ size: data.length, read: async (o, l) => data.subarray(o, o + l) });
  const pp = await doc.resolve(parms[0]);
  const predictor = pp instanceof PdfDict ? (intOf(pp.get('Predictor')) ?? 1) : 1;
  if (predictor === 1) {
    const r = await inflateAll(mem, 0, data.length, max);
    return r.data.length <= max ? r.data : null;
  }
  const q = pp as PdfDict;
  const rows: Uint8Array[] = [];
  let total = 0;
  const dec = new RowDecoder(predictor, intOf(q.get('Colors')) ?? 1, intOf(q.get('BitsPerComponent')) ?? 8, intOf(q.get('Columns')) ?? 1, (row) => {
    rows.push(row.slice());
    return (total += row.length) > max;
  });
  dec.push((await inflateAll(mem, 0, data.length, max)).data);
  return total > max ? null : concat(rows);
}

const hasString = (o: PdfObj | undefined): boolean =>
  o instanceof PdfString || (Array.isArray(o) ? o.some(hasString) : o instanceof PdfDict && [...o.map.values()].some(hasString));

/** A string token for decrypted bytes: a literal when printable ASCII, else hex. */
function stringToken(b: Uint8Array): Uint8Array {
  if (b.every((c) => c >= 32 && c < 127)) return ascii(`(${latin1(b).replace(/[\\()]/g, '\\$&')})`);
  const out = new Uint8Array(2 * b.length + 2);
  out[0] = 60;
  out[out.length - 1] = 62;
  for (let i = 0; i < b.length; i++) {
    const h = b[i] >> 4;
    const l = b[i] & 15;
    out[2 * i + 1] = h < 10 ? 48 + h : 87 + h;
    out[2 * i + 2] = l < 10 ? 48 + l : 87 + l;
  }
  return out;
}

interface Frame {
  dict: boolean;
  key: string | null;
  /** Has /ByteRange: a signature dictionary, whose /Contents string is not encrypted. */
  sig: boolean;
  contents: Token | null;
}

/**
 * Re-emit PDF value text with every string token replaced by its decryption; everything else is
 * copied byte for byte. Returns null when no string needed decrypting.
 */
async function reencode(src: Uint8Array, dec: (b: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array[] | null> {
  const lex = new Lexer(src, 0, true);
  const strs: Token[] = [];
  const keep = new Set<Token>();
  const stack: Frame[] = [];
  for (let t = lex.next(); t.t !== T_EOF; t = lex.next()) {
    const f = stack[stack.length - 1];
    let key: string | null = null;
    if (f?.dict) {
      if (f.key === null && t.t === T_NAME) {
        f.key = t.v as string;
        if (f.key === 'ByteRange') f.sig = true;
        continue;
      }
      key = f.key;
      f.key = null;
    }
    if (t.t === T_STR) {
      strs.push(t);
      if (key === 'Contents') f!.contents = t;
    } else if (t.t === T_AOPEN || t.t === T_DOPEN) {
      stack.push({ dict: t.t === T_DOPEN, key: null, sig: false, contents: null });
    } else if (t.t === T_ACLOSE || t.t === T_DCLOSE) {
      const g = stack.pop();
      if (g?.sig && g.contents) keep.add(g.contents);
    }
  }
  const out: Uint8Array[] = [];
  let at = 0;
  for (const t of strs) {
    if (keep.has(t)) continue;
    out.push(src.subarray(at, t.s), stringToken(await dec(stringBytes(new PdfString(t.v as Uint8Array)))));
    at = t.e;
  }
  if (!out.length) return null;
  out.push(src.subarray(at));
  return out;
}

/** The source text of an object's value (after `N G obj`). */
async function valueBytes(doc: PdfDocument, hdr: ObjHeader): Promise<Uint8Array> {
  const b = await doc.reader.read(hdr.offset, hdr.valueEnd - hdr.offset);
  const lex = new Lexer(b, 0, true);
  for (let i = 0; i < 3; i++) lex.next();
  return b.subarray(lex.pos);
}

/**
 * Rewrite plugin that decrypts an encrypted document: strings everywhere (except in the
 * /Encrypt dictionary and signature /Contents), stream data (object streams included, whose
 * members are then plain), and drops /Encrypt. The output keeps /ID. Unencrypted input passes
 * through unchanged. Put it first in the plugin list: other plugins see encrypted data.
 * Stream data is read, decrypted and written in bounded chunks, never held whole.
 *
 * Throws PdfPasswordError when the password matches neither the user nor the owner password,
 * PdfFormatError for a malformed /Encrypt dictionary, and PdfEncryptedError for unsupported
 * handlers (public-key) or ciphers. Its `report` fills in during setup.
 */
export function decrypt(opts: DecryptOptions = {}): Plugin & { report: DecryptReport } {
  const report: DecryptReport = { encrypted: false };
  let sec: Security | undefined;
  let encNum = -1;
  return {
    decrypts: true,
    report,
    async setup(ctx) {
      const doc = ctx.doc;
      if (!isEncrypted(doc)) return;
      sec = await security(doc, opts.password ?? '');
      const e = doc.trailer.get('Encrypt');
      if (e instanceof PdfRef) encNum = e.num;
      report.encrypted = true;
      report.method = sec.method;
      report.password = sec.password;
    },
    async transform(num, hdr, span, ctx) {
      const s = sec;
      if (!s) return;
      if (num === encNum) return { drop: true };
      const doc = ctx.doc;
      const v = hdr.value;
      const str = (b: Uint8Array): Promise<Uint8Array> => s.decryptor(s.str, num, hdr.gen)(b, true);
      if (!hdr.stream) {
        if (!hasString(v)) return;
        const out = await reencode(v instanceof PdfDict ? ascii(serialize(v)) : await valueBytes(doc, hdr), str);
        return out ? { body: out } : undefined;
      }
      const warn = (m: string): void => ctx.warn(`Object ${num}: ${m}`);
      const plan = await streamPlan(doc, s, v as PdfDict, warn);
      if (plan.cipher === NONE && plan.crypt < 0 && !hasString(v)) return;
      let { dataStart: start, dataEnd: end } = span;
      if (end < 0) {
        warn('could not find the end of its stream; decrypted everything up to the next object');
        start = hdr.dataStart;
        end = span.end;
      }
      const decryptor = (): Decrypt => s.decryptor(plan.cipher, num, hdr.gen);
      const small = end - start <= INLINE;
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (small) {
        for await (const c of decrypted(doc.reader, start, end - start, decryptor())) {
          chunks.push(c);
          length += c.length;
        }
      } else {
        length = await plainLength(doc.reader, start, end - start, decryptor(), plan.cipher);
      }
      const updates = new Map<string, string | null>([['Length', String(length)]]);
      if (plan.crypt >= 0) {
        const f = plan.filters.filter((_, i) => i !== plan.crypt);
        const p = plan.parms.filter((_, i) => i !== plan.crypt);
        updates.set('Filter', f.length ? `[${f.map(serialize).join(' ')}]` : null);
        updates.set('DecodeParms', p.some((x) => x !== undefined && x !== null) ? `[${p.map(serialize).join(' ')}]` : null);
      }
      const dict = ascii(dictString(v as PdfDict, updates));
      const head = (await reencode(dict, str)) ?? [dict];
      if (small) return { body: [...head, ascii('\nstream\n'), ...chunks, ascii('\nendstream')] };
      return {
        stream: {
          dict: latin1(concat(head)),
          // Read, decrypted and written chunk by chunk when the object's turn comes; yields
          // exactly `length` bytes whatever the data turns out to be.
          async *data() {
            let left = length;
            for await (const c of decrypted(doc.reader, start, end - start, decryptor())) {
              yield c.length > left ? c.subarray(0, left) : c;
              left -= Math.min(left, c.length);
            }
            if (left > 0) yield new Uint8Array(left);
          },
        },
      };
    },
  };
}

/**
 * Open a PDF that may be encrypted, authenticating `password` (default: empty). Encrypted object
 * streams become readable, so objects inside them (the catalog, say) resolve. Pass the result
 * to `rewritePdf` with the `decrypt` plugin, or to `decryptPdf`.
 */
export async function openEncryptedPdf(input: RandomAccessSource | Blob, opts: DecryptOptions & { signal?: AbortSignal } = {}): Promise<PdfDocument> {
  const source = typeof Blob !== 'undefined' && input instanceof Blob ? new BlobSource(input) : (input as RandomAccessSource);
  const doc = await PdfDocument.open(new SourceReader(source), opts.signal);
  if (isEncrypted(doc)) await security(doc, opts.password ?? '');
  return doc;
}

/**
 * Decrypt a PDF: writes an unencrypted copy of `source` to `sink` in one forward pass (unchanged
 * objects are copied byte for byte). Unencrypted input is copied as is. The sink is closed on
 * success and aborted (if it can be) on failure. Equivalent to `rewritePdf(source, sink,
 * [decrypt(opts)], opts)`.
 */
export async function decryptPdf(
  source: RandomAccessSource | PdfDocument,
  sink: OutputSink,
  opts: DecryptOptions & RewriteOptions = {},
): Promise<DecryptReport & RewriteReport> {
  const plugin = decrypt(opts);
  const r = await rewritePdf(source, sink, [plugin], opts);
  return { ...plugin.report, ...r };
}
