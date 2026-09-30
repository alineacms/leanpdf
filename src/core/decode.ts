import type { PdfDocument } from './document.ts';
import { inflateAll, inflateRange } from './flate.ts';
import { intOf, nameOf, PdfDict, PdfRef, type PdfObj } from './objects.ts';
import type { ObjHeader } from './objread.ts';
import { RowDecoder } from './predictor.ts';

/** Filters `readStream` can undo. Image codecs (DCT, JPX, JBIG2, CCITT) are left to the caller. */
const ALIASES: Record<string, string> = { Fl: 'FlateDecode', LZW: 'LZWDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode' };

function asciiHex(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of d) {
    if (c === 0x3e) break;
    const v = c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let n = 0;
  let v = 0;
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && n === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    v = v * 85 + (c - 33);
    if (++n === 5) {
      out.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      n = 0;
      v = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) v = v * 85 + 84;
    for (let k = 0; k < n - 1; k++) out.push((v >>> (24 - 8 * k)) & 255);
  }
  return Uint8Array.from(out);
}

function runLength(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < d.length; ) {
    const n = d[i++];
    if (n === 128) break;
    if (n < 128) for (let k = 0; k <= n && i < d.length; k++) out.push(d[i++]);
    else {
      const b = d[i++];
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

function lzw(d: Uint8Array, earlyChange: number, max: number): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let bits = 9;
  let buf = 0;
  let nbuf = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < d.length && out.length <= max; ) {
    while (nbuf < bits && i < d.length) {
      buf = ((buf << 8) | d[i++]) >>> 0;
      nbuf += 8;
    }
    if (nbuf < bits) break;
    const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
    nbuf -= bits;
    buf &= (1 << nbuf) - 1;
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const b of entry) out.push(b);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
    prev = entry;
    const next = dict.length + earlyChange;
    if (next >= 2048) bits = 12;
    else if (next >= 1024) bits = 11;
    else if (next >= 512) bits = 10;
  }
  return Uint8Array.from(out);
}

function unpredict(d: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = parms ? (intOf(parms.get('Predictor')) ?? 1) : 1;
  if (predictor === 1) return d;
  let out = new Uint8Array(0);
  const dec = new RowDecoder(predictor, intOf(parms!.get('Colors')) ?? 1, intOf(parms!.get('BitsPerComponent')) ?? 8, intOf(parms!.get('Columns')) ?? 1, (r) => {
    // PNG rows carry a filter byte, so there are at most d.length / rowBytes of them.
    if (!out.length) out = new Uint8Array(Math.ceil(d.length / r.length) * r.length);
    out.set(r, (dec.rows - 1) * r.length);
  });
  dec.push(d);
  return out.subarray(0, dec.rows * dec.rowBytes);
}

/** Image codecs: undoing filters stops at them (`codec` in the result). */
const CODECS: Record<string, string> = { DCT: 'DCTDecode', CCF: 'CCITTFaxDecode', DCTDecode: 'DCTDecode', CCITTFaxDecode: 'CCITTFaxDecode', JPXDecode: 'JPXDecode', JBIG2Decode: 'JBIG2Decode' };
const codecOf = (name: string | undefined): string | undefined => (name && Object.hasOwn(CODECS, name) ? CODECS[name] : undefined);

/** Stream data with its non-image filters undone, and the image codec that remains, if any. */
export interface Decoded {
  data: Uint8Array;
  /** DCTDecode, JPXDecode, JBIG2Decode or CCITTFaxDecode: `data` is still encoded with it. */
  codec?: string;
  /** The codec's /DecodeParms. */
  parms?: PdfDict;
}

/**
 * Undo `filters` (full or abbreviated names) on in-memory data, as for inline images. Stops at an
 * image codec. Null when a filter isn't supported or the result exceeds `max` bytes.
 */
export async function decodeFilters(data: Uint8Array, filters: (string | undefined)[], parms: (PdfDict | undefined)[], max: number): Promise<Decoded | null> {
  for (let i = 0; i < filters.length; i++) {
    const name = ALIASES[filters[i] ?? ''] ?? filters[i];
    const p = parms[i];
    const codec = codecOf(name);
    if (codec) return { data, codec, parms: p };
    if (name === 'FlateDecode') {
      const ds = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate')));
      data = unpredict(new Uint8Array(await ds.arrayBuffer()), p);
    } else if (name === 'LZWDecode') data = unpredict(lzw(data, p ? (intOf(p.get('EarlyChange')) ?? 1) : 1, max), p);
    else if (name === 'ASCIIHexDecode') data = asciiHex(data);
    else if (name === 'ASCII85Decode') data = ascii85(data);
    else if (name === 'RunLengthDecode') data = runLength(data);
    else if (name !== 'Crypt') return null;
    if (data.length > max) return null;
  }
  return { data };
}

/** A stream's header, data span and filters with their parameters (names unabbreviated). */
async function streamInfo(doc: PdfDocument, stream: PdfRef | ObjHeader) {
  const hdr = stream instanceof PdfRef ? await doc.header(stream.num) : stream;
  if (!hdr || !hdr.stream) return null;
  const d = hdr.value as PdfDict;
  const span = await doc.span(hdr, doc.reader.size);
  if (span.dataEnd < 0) return null;
  const f = await doc.resolve(d.get('Filter'));
  const filters = (Array.isArray(f) ? f : f === undefined || f === null ? [] : [f]).map((x) => {
    const name = nameOf(x as PdfObj);
    return name && Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  });
  const dp = await doc.resolve(d.get('DecodeParms'));
  const parms: (PdfDict | undefined)[] = [];
  for (let i = 0; i < filters.length; i++) {
    const p = await doc.resolve(Array.isArray(dp) ? dp[i] : i === 0 ? dp : undefined);
    parms.push(p instanceof PdfDict ? p : undefined);
  }
  return { hdr, start: span.dataStart, len: span.dataEnd - span.dataStart, filters, parms };
}

const passThrough = (e: unknown) => e instanceof Error && (e.name === 'SourceReadError' || e.name === 'AbortError');

/**
 * A stream's data with its filters undone (Flate, LZW, ASCIIHex, ASCII85, RunLength and
 * predictors), stopping at an image codec. Null if a filter isn't supported, the data exceeds `max`
 * bytes, or it can't be decoded.
 */
export async function decodeStream(doc: PdfDocument, stream: PdfRef | ObjHeader, max = 64 << 20): Promise<Decoded | null> {
  const info = await streamInfo(doc, stream);
  if (!info || info.len > max) return null;
  const { start, len, filters, parms } = info;
  try {
    // The first Flate filter streams from the file, so compressed data is never held whole.
    if (filters[0] === 'FlateDecode') {
      const r = await inflateAll(doc.reader, start, len, max);
      if (r.data.length > max) return null;
      return await decodeFilters(unpredict(r.data, parms[0]), filters.slice(1), parms.slice(1), max);
    }
    return await decodeFilters(await doc.reader.raw(start, len), filters, parms, max);
  } catch (e) {
    if (passThrough(e)) throw e;
    return null;
  }
}

/**
 * Decoded stream data handed over in pieces as it decodes. A piece may be a reused buffer, valid
 * only during the callback.
 */
export interface StreamedData {
  /** As in Decoded: an image codec the pieces are still encoded with. */
  codec?: string;
  parms?: PdfDict;
  /**
   * Hand the data to `onChunk` in order (return true to stop). Call once. Resolves false when the
   * data was cut short by damage; what decoded before it has been delivered.
   */
  read(onChunk: (chunk: Uint8Array) => boolean | void): Promise<boolean>;
}

/** Data already in memory, as StreamedData. */
export const streamed = (d: Decoded): StreamedData => ({
  codec: d.codec,
  parms: d.parms,
  read: async (onChunk) => {
    onChunk(d.data);
    return true;
  },
});

const RAW_CHUNK = 256 * 1024;

/**
 * A stream's data as it decodes, for consumers that take it in pieces, such as image rows. With
 * no filter, or a single Flate filter (and predictor), the data streams from the file and is never
 * held whole: predicted data arrives row by row. Other filter chains decode in memory first.
 * Null as for decodeStream (`max` bounds only what is decoded in memory).
 */
export async function openStream(doc: PdfDocument, stream: PdfRef | ObjHeader, max = 64 << 20): Promise<StreamedData | null> {
  const info = await streamInfo(doc, stream);
  if (!info) return null;
  const { start, len, filters, parms } = info;
  const last = filters.length - 1;
  const codec = codecOf(filters[last]);
  const plain = filters.length - (codec ? 1 : 0);
  const out = { codec, parms: codec ? parms[last] : undefined };
  if (plain === 0) {
    return {
      ...out,
      async read(onChunk) {
        for (let pos = start; pos < start + len; ) {
          const b = await doc.reader.raw(pos, Math.min(RAW_CHUNK, start + len - pos));
          if (!b.length || onChunk(b) === true) break;
          pos += b.length;
        }
        return true;
      },
    };
  }
  if (plain === 1 && filters[0] === 'FlateDecode') {
    const p = parms[0];
    const predictor = p ? (intOf(p.get('Predictor')) ?? 1) : 1;
    let onRow: (r: Uint8Array) => boolean | void = () => {};
    let dec: RowDecoder | undefined;
    try {
      if (predictor !== 1) dec = new RowDecoder(predictor, intOf(p!.get('Colors')) ?? 1, intOf(p!.get('BitsPerComponent')) ?? 8, intOf(p!.get('Columns')) ?? 1, (r) => onRow(r));
    } catch {
      return null;
    }
    return {
      ...out,
      async read(onChunk) {
        onRow = onChunk;
        try {
          return await inflateRange(doc.reader, start, len, dec ? (c) => dec.push(c) : onChunk);
        } catch (e) {
          if (passThrough(e)) throw e;
          return false;
        }
      },
    };
  }
  const d = await decodeStream(doc, info.hdr, max);
  return d && streamed(d);
}

/**
 * Read a stream's data with its filters undone (Flate, LZW, ASCIIHex, ASCII85, RunLength and
 * predictors). Returns null if a filter isn't supported (image codecs), the data exceeds `max`
 * bytes, or it can't be decoded.
 */
export async function readStream(doc: PdfDocument, stream: PdfRef | ObjHeader, max = 64 << 20): Promise<Uint8Array | null> {
  const r = await decodeStream(doc, stream, max);
  return r && !r.codec ? r.data : null;
}
