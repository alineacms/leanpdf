import { ascii, isWhite, skipWhite } from './bytes.ts';
import { isFatal, PdfFormatError } from './errors.ts';
import { inflateAll, inflateRange } from './flate.ts';
import { Lexer, T_NUM } from './lexer.ts';
import { intOf, nameOf, PdfDict, Parser, PdfRef, type PdfObj } from './objects.ts';
import { checkStreamEnd, readObjectAt, searchStreamEnd, type ObjHeader } from './objread.ts';
import { RowDecoder } from './predictor.ts';
import type { SourceReader } from './reader.ts';
import { scanObjects } from './recover.ts';
import {
  E_COMPRESSED, E_FREE, E_OFFSET, findHeader, findStartXref, loadXref, MAX_OBJECTS, validateOffsets, XREF_KEYS, XrefIndex,
} from './xref.ts';

/** Where an object lives in the source. */
export interface ObjSpan {
  start: number;
  /** Exclusive end, including `endobj` and any whitespace right after it. */
  end: number;
  /** Stream data range; -1 when not a stream or the end could not be found. */
  dataStart: number;
  dataEnd: number;
  /** The source object lacks `endobj`; the writer adds one. */
  addEndobj: boolean;
  /** No whitespace follows the copied bytes; the writer adds a line break. */
  sep: boolean;
}

interface ObjStmData {
  data: Uint8Array;
  first: number;
  /** num, offset pairs. */
  pairs: number[];
}

const MAX_OBJSTM = 32 << 20;
const STM_CACHE_BYTES = 16 << 20;

export class PdfDocument {
  readonly reader: SourceReader;
  index: XrefIndex;
  trailer: PdfDict;
  version: string;
  /** Offsets of the source xref sections (object boundaries). */
  sections: number[];
  /** Largest /Size any trailer declared; object numbers below it are reserved. */
  declaredSize = 0;
  /** The xref was rebuilt, fully or in part, by scanning. */
  repaired = false;
  warnings: string[] = [];
  private stmCache = new Map<number, ObjStmData>();

  private constructor(reader: SourceReader, index: XrefIndex, trailer: PdfDict, version: string, sections: number[]) {
    this.reader = reader;
    this.index = index;
    this.trailer = trailer;
    this.version = version;
    this.sections = sections;
  }

  /** Load the cross-reference data, validating offsets and falling back to a rebuild by scanning. */
  static async open(reader: SourceReader, signal?: AbortSignal): Promise<PdfDocument> {
    const header = await findHeader(reader);
    let doc: PdfDocument | null = null;
    const startxref = await findStartXref(reader);
    if (startxref >= 0) {
      for (const delta of header.offset > 0 ? [0, header.offset] : [0]) {
        try {
          const load = await loadXref(reader, startxref, delta);
          doc = new PdfDocument(reader, load.index, load.trailer, header.version, load.sections);
          doc.declaredSize = load.declaredSize;
          break;
        } catch (e) {
          if (isFatal(e)) throw e;
        }
      }
    }
    signal?.throwIfAborted();
    if (doc && doc.trailer.get('Root') instanceof PdfRef) {
      const bad = await validateOffsets(reader, doc.index, doc.index.sortedOffsets());
      if (bad.length) {
        // Keep the xref's view of the document; relocate only the objects it got wrong.
        const scan = await scanObjects(reader, signal);
        for (const num of bad) {
          if (scan.index.get(num) === E_OFFSET) doc.index.set(num, E_OFFSET, scan.index.a[num], scan.index.b[num]);
          else doc.index.set(num, E_FREE, 0, 0);
        }
        doc.repaired = true;
        doc.warnings.push(`Repaired ${bad.length} bad cross-reference offset(s)`);
      }
      if ((await doc.resolve(doc.trailer.get('Root'))) instanceof PdfDict) return doc;
    }
    // Full rebuild.
    const scan = await scanObjects(reader, signal);
    const trailer = new PdfDict();
    let declared = 0;
    for (const t of scan.trailers.reverse()) {
      for (const [k, v] of t.map) if (!XREF_KEYS.has(k) && !trailer.map.has(k)) trailer.set(k, v, t.raw.get(k)!);
      const size = intOf(t.get('Size'));
      if (size !== undefined && size > declared && size <= MAX_OBJECTS) declared = size;
    }
    doc = new PdfDocument(reader, scan.index, trailer, header.version, []);
    doc.declaredSize = declared;
    doc.repaired = true;
    doc.warnings.push('Cross-reference data was unusable; rebuilt it by scanning the file');
    await doc.expandObjStms(scan.objStms);
    if (!((await doc.resolve(trailer.get('Root'))) instanceof PdfDict) && scan.catalog >= 0) {
      trailer.set('Root', new PdfRef(scan.catalog, doc.index.b[scan.catalog]), ascii(`${scan.catalog} ${doc.index.b[scan.catalog]} R`));
    }
    if (!((await doc.resolve(trailer.get('Root'))) instanceof PdfDict)) {
      throw new PdfFormatError(header.offset < 0 ? 'Not a PDF file' : 'No document catalog found; the file is too damaged');
    }
    doc.index.set(0, E_FREE, 0, 65535);
    return doc;
  }

  /** Register the objects inside object streams found by a scan; later definitions win. */
  private async expandObjStms(stms: number[]): Promise<void> {
    for (const stm of stms) {
      if (this.index.get(stm) !== E_OFFSET) continue;
      const s = await this.objStm(stm);
      if (!s) continue;
      const at = this.index.a[stm];
      for (let i = 0; i < s.pairs.length; i += 2) {
        const n = s.pairs[i];
        const t = this.index.get(n);
        if (n === stm || (t === E_OFFSET && this.index.a[n] > at)) continue;
        this.index.set(n, E_COMPRESSED, stm, i / 2);
      }
    }
  }

  /** Header of an uncompressed object, or null if the index does not point at one. */
  async header(num: number): Promise<ObjHeader | null> {
    if (this.index.get(num) !== E_OFFSET) return null;
    try {
      const h = await readObjectAt(this.reader, this.index.a[num]);
      return h.num === num ? h : null;
    } catch (e) {
      if (isFatal(e)) throw e;
      return null;
    }
  }

  /** Fetch an object's value (a stream's dictionary). Undefined if missing or unparseable. */
  async getObject(num: number): Promise<PdfObj | undefined> {
    const t = this.index.get(num);
    if (t === E_OFFSET) return (await this.header(num))?.value;
    if (t !== E_COMPRESSED) return undefined;
    try {
      const s = await this.objStm(this.index.a[num]);
      if (!s) return undefined;
      let i = this.index.b[num];
      if (s.pairs[2 * i] !== num) {
        i = -1;
        for (let j = 0; j < s.pairs.length; j += 2) if (s.pairs[j] === num) i = j / 2;
        if (i < 0) return undefined;
      }
      return new Parser(new Lexer(s.data, s.first + s.pairs[2 * i + 1], true)).parse();
    } catch (e) {
      if (isFatal(e)) throw e;
      return undefined;
    }
  }

  /** Follow indirect references. */
  async resolve(o: PdfObj | undefined): Promise<PdfObj | undefined> {
    for (let depth = 0; o instanceof PdfRef && depth < 16; depth++) o = await this.getObject(o.num);
    return o instanceof PdfRef ? undefined : o;
  }

  private async objStm(num: number): Promise<ObjStmData | null> {
    let s = this.stmCache.get(num);
    if (s) {
      this.stmCache.delete(num);
      this.stmCache.set(num, s);
      return s;
    }
    const hdr = await this.header(num);
    if (!hdr || !hdr.stream) return null;
    const d = hdr.value as PdfDict;
    const n = intOf(await this.resolve(d.get('N')));
    const first = intOf(await this.resolve(d.get('First')));
    if (n === undefined || first === undefined || n < 0 || first < 0) return null;
    const data = await this.streamData(hdr, MAX_OBJSTM);
    if (!data || first > data.length) return null;
    const lex = new Lexer(data.subarray(0, first), 0, true);
    const pairs: number[] = [];
    for (let i = 0; i < 2 * n; i++) {
      const t = lex.next();
      if (t.t !== T_NUM) break;
      pairs.push(t.v as number);
    }
    s = { data, first, pairs };
    // Least recently used, bounded by decoded size (random access, e.g. reachability, revisits).
    this.stmCache.set(num, s);
    let total = 0;
    for (const v of this.stmCache.values()) total += v.data.length;
    for (const [k, v] of this.stmCache) {
      if (total <= STM_CACHE_BYTES || this.stmCache.size <= 1) break;
      this.stmCache.delete(k);
      total -= v.data.length;
    }
    return s;
  }

  /** Decode a small stream (no filter, or Flate with an optional predictor) fully into memory. */
  async streamData(hdr: ObjHeader, max: number): Promise<Uint8Array | null> {
    const span = await this.span(hdr, this.reader.size);
    if (span.dataEnd < 0) return null;
    const d = hdr.value as PdfDict;
    let filter = await this.resolve(d.get('Filter'));
    if (Array.isArray(filter)) filter = filter.length === 1 ? filter[0] : filter.length ? null : undefined;
    const len = span.dataEnd - span.dataStart;
    if (filter === undefined) return len <= max ? this.reader.raw(span.dataStart, len) : null;
    const f = nameOf(filter);
    if (f !== 'FlateDecode' && f !== 'Fl') return null;
    let parms = await this.resolve(d.get('DecodeParms'));
    if (Array.isArray(parms)) parms = await this.resolve(parms[0]);
    const predictor = parms instanceof PdfDict ? (intOf(parms.get('Predictor')) ?? 1) : 1;
    if (predictor === 1) {
      const r = await inflateAll(this.reader, span.dataStart, len, max);
      return r.data.length <= max ? r.data : null;
    }
    const p = parms as PdfDict;
    const parts: Uint8Array[] = [];
    let total = 0;
    const dec = new RowDecoder(predictor, intOf(p.get('Colors')) ?? 1, intOf(p.get('BitsPerComponent')) ?? 8, intOf(p.get('Columns')) ?? 1, (row) => {
      parts.push(row.slice());
      total += row.length;
      if (total > max) return true;
    });
    await inflateRange(this.reader, span.dataStart, len, (c) => dec.push(c));
    if (total > max) return null;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return out;
  }

  /** Is the byte before `pos` whitespace (so no separator is needed after a copy ending there)? */
  async endsWithWhite(pos: number): Promise<boolean> {
    return pos > 0 && isWhite((await this.reader.read(pos - 1, 1))[0]);
  }

  /**
   * Find the full extent of an object. Stream data ends at /Length when that lands on
   * `endstream`; otherwise we search forward, but never past `boundary`.
   */
  async span(hdr: ObjHeader, boundary: number): Promise<ObjSpan> {
    const start = hdr.offset;
    let end: number;
    let dataStart = -1;
    let dataEnd = -1;
    let addEndobj = false;
    if (!hdr.stream) {
      addEndobj = hdr.endobj < 0;
      end = addEndobj ? hdr.valueEnd : hdr.endobj;
    } else {
      dataStart = hdr.dataStart;
      const len = intOf(await this.resolve((hdr.value as PdfDict).get('Length')));
      const at = len !== undefined && len >= 0 ? await checkStreamEnd(this.reader, dataStart + len) : null;
      const found =
        at && at.end <= boundary ? { ...at, dataEnd: dataStart + len! } : await searchStreamEnd(this.reader, dataStart, boundary);
      if (found) {
        dataEnd = found.dataEnd;
        end = found.end;
        addEndobj = !found.endobj;
      } else {
        // Unknown end: copy verbatim up to the next object.
        return { start, end: Math.max(boundary, start), dataStart: -1, dataEnd: -1, addEndobj: false, sep: !(await this.endsWithWhite(boundary)) };
      }
    }
    // Take the line break after `endobj` along, so neighbouring copies can merge.
    let sep = true;
    if (!addEndobj && end < boundary) {
      const tail = await this.reader.read(end, 8);
      const ws = Math.min(boundary - end, skipWhite(tail, 0));
      end += ws;
      sep = ws === 0;
    }
    return { start, end, dataStart, dataEnd, addEndobj, sep };
  }
}

