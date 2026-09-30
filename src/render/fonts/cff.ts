/**
 * CFF fonts: bare FontFile3 programs (/Type1C, /CIDFontType0C) and the 'CFF ' table of OpenType
 * fonts, name-keyed or CID-keyed, with Type 2 charstrings. Glyphs are interpreted on demand; hints
 * are skipped (only counted, to step over hintmask bytes).
 */
import { CLOSE, CUBIC, LINE, MOVE, transformOutline, type FontProgram, type Matrix, type Outline } from './program.ts';
import { cffStrings, expertEncoding, predefinedCharset, standardEncoding } from './standard.ts';

/** Subroutine nesting, and bytes interpreted per glyph (subroutines and seac parts included). */
const MAX_DEPTH = 10;
const MAX_OPS = 200_000;
/** Bit e set: escape operator 12 e is arithmetic or storage (and, or, not, abs, add, ...). */
const ARITH = 0x7df4de38;

interface Index {
  n: number;
  /** Byte range of item `i`; undefined when out of range or damaged. */
  at(i: number): [number, number] | undefined;
  /** Offset just past the INDEX. */
  end: number;
}

/** DICT operands by operator (two-byte operators 12 x as 1200 + x). */
type Dict = Map<number, number[]>;

/** Private data of the font, or of one FD of a CID-keyed font. */
interface Private {
  subrs: Index;
  bias: number;
  /** defaultWidthX, nominalWidthX. */
  dw: number;
  nw: number;
  /** An FD FontMatrix folded into glyph units of the top-level matrix. */
  m?: Matrix;
}

function readIndex(d: Uint8Array, p: number): Index {
  const n = p + 3 <= d.length ? (d[p] << 8) | d[p + 1] : 0;
  const size = d[p + 2];
  // Offsets are 1-based from the byte before the data.
  const base = p + 2 + (n + 1) * size;
  const off = (i: number): number => {
    let v = 0;
    for (let k = 0, q = p + 3 + i * size; k < size; k++) v = v * 256 + d[q + k];
    return base + v;
  };
  const ok = size > 0 && size < 5;
  return {
    n: ok ? n : 0,
    at(i) {
      if (!ok || !(i >= 0 && i < n)) return;
      const a = off(i);
      const b = off(i + 1);
      return a <= b && b <= d.length ? [a, b] : undefined;
    },
    end: n && ok ? off(n) : p + 2,
  };
}

const NO_SUBRS = /* @__PURE__ */ readIndex(new Uint8Array(0), 0);

/** Subroutine numbers are biased by the subroutine count. */
const bias = (n: number): number => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

function readDict(d: Uint8Array, p: number, end: number): Dict {
  const m: Dict = new Map();
  let ops: number[] = [];
  for (end = Math.min(end, d.length); p < end; ) {
    const b = d[p++];
    if (b < 22) {
      m.set(b === 12 ? 1200 + d[p++] : b, ops);
      ops = [];
    } else if (b === 28 || b === 29) {
      ops.push(b === 28 ? ((d[p] << 24) | (d[p + 1] << 16)) >> 16 : (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
      p += b === 28 ? 2 : 4;
    } else if (b === 30) {
      // Real number: nibbles 0-9 . E E- (reserved) - (end).
      let s = '';
      for (let k = 0, v = 0; p < end; k++) {
        const nib = k & 1 ? v & 15 : (v = d[p++]) >> 4;
        if (nib === 15) break;
        s += nib === 12 ? 'E-' : '0123456789.E -'[nib];
      }
      ops.push(parseFloat(s) || 0);
    } else if (b > 31 && b < 255) {
      ops.push(b < 247 ? b - 139 : b < 251 ? (b - 247) * 256 + d[p++] + 108 : -(b - 251) * 256 - d[p++] - 108);
    }
  }
  return m;
}

const get = (m: Dict, op: number, def = 0): number => m.get(op)?.[0] ?? def;

/** Six finite numbers with a non-zero determinant, or undefined. */
const matrixOf = (a: number[] | undefined): Matrix | undefined =>
  a?.length === 6 && a.every(Number.isFinite) && a[0] * a[3] - a[1] * a[2] ? (a as Matrix) : undefined;

/**
 * Parse a bare CFF font (FontFile3 /Type1C or /CIDFontType0C), name-keyed or CID-keyed; given
 * OpenType data, its 'CFF ' table. Only the first font of the FontSet is used. Throws when there
 * is no usable font (CFF2 and Type 1 charstrings are not supported).
 *
 * `matrix` is the Top DICT FontMatrix. In CID-keyed fonts, an FD's own FontMatrix is folded into
 * the outlines (and advances) of its glyphs, so every glyph is in units of `matrix`.
 */
export function parseCFF(data: Uint8Array): FontProgram {
  let d = data;
  const u32 = (p: number): number => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
  // OpenType labeled as bare CFF: use its 'CFF ' table.
  if (u32(0) === 0x4f54544f) {
    for (let i = 0, r = 12; i < ((d[4] << 8) | d[5]); i++, r += 16) {
      if (u32(r) === 0x43464620) d = d.subarray(u32(r + 8), u32(r + 8) + u32(r + 12));
    }
  }
  if (d.length < 4 || d[0] !== 1) throw new Error('Not a CFF font');
  const names = readIndex(d, d[2]);
  const tops = readIndex(d, names.end);
  const strings = readIndex(d, tops.end);
  const gsubrs = readIndex(d, strings.end);
  const gbias = bias(gsubrs.n);
  const tr = tops.at(0);
  if (!tr) throw new Error('CFF font without a Top DICT');
  const top = readDict(d, tr[0], tr[1]);
  if (get(top, 1206, 2) !== 2) throw new Error('CFF fonts with Type 1 charstrings are not supported');
  const cs = readIndex(d, get(top, 17) || d.length);
  const count = cs.n;
  if (!count) throw new Error('CFF font without glyphs');
  const cid = top.has(1230);
  const topMatrix = matrixOf(top.get(1207));
  const std = cffStrings();
  const u16 = (p: number): number => (d[p] << 8) | d[p + 1];
  const sidName = (sid: number): string | undefined => {
    const r = sid < 391 ? undefined : strings.at(sid - 391);
    return r ? String.fromCharCode(...d.subarray(r[0], r[1])) : std[sid];
  };

  // charset: SIDs (name-keyed) or CIDs (CID-keyed) by glyph index.
  let charset: Uint16Array | undefined;
  const sids = (): Uint16Array => {
    if (charset) return charset;
    const out = new Uint16Array(count);
    const off = get(top, 15);
    if (off > 2) {
      const f = d[off];
      for (let g = 1, p = off + 1; g < count && p < d.length && f < 3; ) {
        if (!f) out[g++] = u16((p += 2) - 2);
        else {
          // Ranges: first SID, then the count of the ones that follow (1 or 2 bytes).
          for (let first = u16(p), e = first + (f === 1 ? d[p + 2] : u16(p + 2)); first <= e && g < count; ) out[g++] = first++;
          p += f + 2;
        }
      }
    } else if (cid) for (let g = 0; g < count; g++) out[g] = g;
    else out.set(predefinedCharset(off).slice(0, count));
    return (charset = out);
  };

  let byName: Map<string, number> | undefined;
  const gidForName = (name: string): number => {
    if (!byName) {
      byName = new Map([['.notdef', 0]]);
      const s = cid ? [] : sids();
      // Backwards, so the first glyph of a name wins.
      for (let g = s.length; g--; ) byName.set(sidName(s[g]) ?? '', g);
    }
    return byName.get(name) ?? -1;
  };

  let byCid: Map<number, number> | undefined;
  const gidForCid = (c: number): number => {
    if (!byCid) {
      byCid = new Map();
      const s = sids();
      for (let g = count; g--; ) byCid.set(s[g], g);
    }
    return byCid.get(c) ?? -1;
  };

  // Private DICTs, per FD for CID-keyed fonts.
  const fdArray = cid ? readIndex(d, get(top, 1236) || d.length) : NO_SUBRS;
  const fdSelect = get(top, 1237);
  const privates: Private[] = [];
  const privateOf = (g: number): Private => {
    let fd = 0;
    if (cid) {
      const f = d[fdSelect];
      if (f === 0) fd = d[fdSelect + 1 + g] | 0;
      else if (f === 3) for (let p = fdSelect + 3, k = u16(fdSelect + 1); k-- && u16(p) <= g; p += 3) fd = d[p + 2];
    }
    let pr = privates[fd];
    if (!pr) {
      const r = cid ? fdArray.at(fd) : tr;
      const font = r ? readDict(d, r[0], r[1]) : top;
      const [size = 0, off = 0] = font.get(18) ?? [];
      const pd = readDict(d, off, off + size);
      const so = get(pd, 19);
      const subrs = so ? readIndex(d, off + so) : NO_SUBRS;
      pr = privates[fd] = { subrs, bias: bias(subrs.n), dw: get(pd, 20), nw: get(pd, 21) };
      // Glyph space of an FD is its FontMatrix times the top one (as in FreeType), or its
      // FontMatrix alone when the Top DICT has none; `matrix` stays the top-level (or default) one.
      const fm = cid && r ? matrixOf(font.get(1207)) : undefined;
      const m = fm && (topMatrix ? fm : (fm.map((v) => v * 1000) as Matrix));
      if (m && m.some((v, i) => Math.abs(v - +(i === 0 || i === 3)) > 1e-9)) pr.m = m;
    }
    return pr;
  };

  // Name-keyed fonts only: glyph names by code.
  let encoding: (string | undefined)[] | undefined;
  const eo = get(top, 16);
  if (!cid && eo < 2) encoding = [...(eo ? expertEncoding() : standardEncoding())];
  else if (!cid) {
    encoding = [];
    const s = sids();
    const f = d[eo];
    const name = (g: number): string | undefined => (g < count ? sidName(s[g]) : undefined);
    let p = eo + 2;
    let g = 1;
    if (!(f & 0x7f)) for (let k = d[eo + 1]; k--; ) encoding[d[p++]] = name(g++);
    else for (let k = d[eo + 1]; k--; p += 2) for (let c = d[p], e = c + d[p + 1]; c <= e && c < 256; c++) encoding[c] = name(g++);
    // Supplements: extra codes for glyphs by SID.
    if (f & 0x80) for (let k = d[p++]; k-- > 0; p += 3) encoding[d[p]] = sidName(u16(p + 1));
  }

  /** Interpret glyph `g`: its outline (without the FD matrix) and advance width. */
  const run = (g: number, seac = true): [Outline, number?] => {
    const r = cs.at(g);
    const out: Outline = [];
    if (!r) return [out];
    const pr = privateOf(g);
    const st: number[] = [];
    const ts: number[] = [];
    let x = 0;
    let y = 0;
    let stems = 0;
    let open = false;
    let w: number | undefined;
    let ops = MAX_OPS;
    const move = (dx: number, dy: number): void => {
      if (open) out.push(CLOSE);
      out.push(MOVE, (x += dx), (y += dy));
      open = true;
    };
    // Drawing without a moveto starts at the current point.
    const begin = (): void => {
      if (!open) out.push(MOVE, x, y);
      open = true;
    };
    const line = (dx: number, dy: number): void => {
      begin();
      out.push(LINE, (x += dx), (y += dy));
    };
    const curve = (a: number, b: number, c: number, e: number, f: number, h: number): void => {
      begin();
      const x1 = x + a;
      const y1 = y + b;
      out.push(CUBIC, x1, y1, x1 + c, y1 + e, (x = x1 + c + f), (y = y1 + e + h));
    };
    // The first stack-clearing operator may carry the width before its arguments, which shows
    // as an argument count of the wrong parity.
    const width = (parity: number): void => {
      if (w === undefined) w = st.length % 2 !== parity ? pr.nw + st.shift()! : pr.dw;
    };
    const exec = (p: number, end: number, depth: number): boolean => {
      while (p < end) {
        if (--ops < 0) return true;
        const b = d[p++];
        if (b > 31 || b === 28) {
          if (b === 28) st.push(((d[p++] << 24) | (d[p++] << 16)) >> 16);
          else if (b < 247) st.push(b - 139);
          else if (b < 251) st.push((b - 247) * 256 + d[p++] + 108);
          else if (b < 255) st.push(-(b - 251) * 256 - d[p++] - 108);
          else st.push(((d[p++] << 24) | (d[p++] << 16) | (d[p++] << 8) | d[p++]) / 65536);
          continue;
        }
        const s = st;
        const n = s.length;
        switch (b) {
          case 1: // hstem, vstem, hstemhm, vstemhm, hintmask, cntrmask
          case 3:
          case 18:
          case 23:
          case 19:
          case 20:
            width(0);
            stems += s.length >> 1;
            if (b === 19 || b === 20) p += (stems + 7) >> 3;
            break;
          case 21: // rmoveto, hmoveto, vmoveto
            width(0);
            move(s[0], s[1]);
            break;
          case 22:
          case 4:
            width(1);
            b === 4 ? move(0, s[0]) : move(s[0], 0);
            break;
          case 5: // rlineto
            for (let k = 0; k + 1 < n; k += 2) line(s[k], s[k + 1]);
            break;
          case 6: // hlineto, vlineto: alternating
          case 7:
            for (let k = 0; k < n; k++) (k + b) & 1 ? line(0, s[k]) : line(s[k], 0);
            break;
          case 8: // rrcurveto
            for (let k = 0; k + 5 < n; k += 6) curve(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5]);
            break;
          case 24: // rcurveline
          case 25: {
            // rlinecurve
            let k = 0;
            if (b === 24) for (; k + 7 < n; k += 6) curve(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5]);
            else for (; k + 7 < n; k += 2) line(s[k], s[k + 1]);
            b === 24 ? line(s[k], s[k + 1]) : curve(s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5]);
            break;
          }
          case 26: // vvcurveto, hhcurveto: an odd count starts with the other coordinate
          case 27:
            for (let k = n & 1, e = k ? s[0] : 0; k + 3 < n; k += 4, e = 0) {
              b === 26 ? curve(e, s[k], s[k + 1], s[k + 2], 0, s[k + 3]) : curve(s[k], e, s[k + 1], s[k + 2], s[k + 3], 0);
            }
            break;
          case 30: // vhcurveto, hvcurveto: alternating, the last may end off-axis
          case 31:
            for (let k = 0, h = b === 31; k + 3 < n; k += 4, h = !h) {
              const f = n - k === 5 ? s[k + 4] : 0;
              h ? curve(s[k], 0, s[k + 1], s[k + 2], f, s[k + 3]) : curve(0, s[k], s[k + 1], s[k + 2], s[k + 3], f);
            }
            break;
          case 10: // callsubr, callgsubr
          case 29: {
            const sr = b === 10 ? pr.subrs.at(s.pop()! + pr.bias) : gsubrs.at(s.pop()! + gbias);
            if (!sr || depth >= MAX_DEPTH || exec(sr[0], sr[1], depth + 1)) return true;
            continue;
          }
          case 11: // return
            return false;
          case 14: // endchar, optionally with the deprecated seac arguments
            width(0);
            if (s.length > 3 && seac) {
              const [adx, ady, bc, ac] = s.slice(-4);
              const enc = standardEncoding();
              const base = run(gidForName(enc[bc] ?? ''), false)[0];
              out.length = 0;
              for (const v of base) out.push(v);
              transformOutline(run(gidForName(enc[ac] ?? ''), false)[0], [1, 0, 0, 1, adx, ady], out);
              open = false;
            }
            return true;
          case 12: {
            const e = d[p++];
            if (e > 33 && e < 38) {
              // hflex, flex, hflex1, flex1: two curves (the flex depth is ignored)
              if (e === 34) {
                curve(s[0], 0, s[1], s[2], s[3], 0);
                curve(s[4], 0, s[5], -s[2], s[6], 0);
              } else if (e === 36) {
                curve(s[0], s[1], s[2], s[3], s[4], 0);
                curve(s[5], 0, s[6], s[7], s[8], -(s[1] + s[3] + s[7]));
              } else {
                const dx = s[0] + s[2] + s[4] + s[6] + s[8];
                const dy = s[1] + s[3] + s[5] + s[7] + s[9];
                curve(s[0], s[1], s[2], s[3], s[4], s[5]);
                if (e === 35) curve(s[6], s[7], s[8], s[9], s[10], s[11]);
                else Math.abs(dx) > Math.abs(dy) ? curve(s[6], s[7], s[8], s[9], s[10], -dy) : curve(s[6], s[7], s[8], s[9], -dx, s[10]);
              }
              break;
            }
            // Arithmetic and storage keep the stack; dotsection and reserved operators clear it.
            if (e > 30 || !((ARITH >> e) & 1)) break;
            if (e === 23) s.push(Math.random() || 1);
            else if (n) {
              const v = s.pop()!;
              if (e === 5 || e === 9 || e === 14 || e === 26) s.push(e === 5 ? +!v : e === 9 ? Math.abs(v) : e === 14 ? -v : Math.sqrt(v));
              else if (e === 21) s.push(ts[v] ?? 0);
              else if (e === 27) s.push(v, v);
              else if (e === 29) s.push(s[n - 2 - (v > 0 ? v : 0)] ?? 0);
              else if (e !== 18 && n > 1) {
                const u = s.pop()!;
                if (e === 20) ts[v & 31] = u;
                else if (e === 28) s.push(v, u);
                else if (e === 30) {
                  const a = s.splice(Math.max(0, n - 2 - u), u);
                  const j = ((v % u) + u) % u || 0;
                  s.push(...a.slice(a.length - j), ...a.slice(0, a.length - j));
                } else if (e === 22) {
                  const s2 = s.pop()!;
                  s.push(u <= v ? s.pop()! : (s.pop(), s2));
                } else {
                  // and, or, add, sub, div, eq, mul
                  s.push(
                    e === 3 ? +(u && v)
                    : e === 4 ? +(u || v)
                    : e === 10 ? u + v
                    : e === 11 ? u - v
                    : e === 12 ? (v ? u / v : 0)
                    : e === 15 ? +(u === v)
                    : u * v,
                  );
                }
              }
            }
            continue;
          }
        }
        s.length = 0;
      }
      return false;
    };
    exec(r[0], r[1], 0);
    if (open) out.push(CLOSE);
    return [out, w ?? pr.dw];
  };

  return {
    kind: 'cff',
    matrix: topMatrix ?? [0.001, 0, 0, 0.001, 0, 0],
    glyphCount: count,
    outline(g) {
      try {
        const o = run(g)[0];
        const m = o.length ? privateOf(g).m : undefined;
        return o.every(Number.isFinite) ? (m ? transformOutline(o, m) : o) : [];
      } catch {
        return [];
      }
    },
    gidForName,
    encoding,
    gidForCid: cid ? gidForCid : undefined,
    advance(g) {
      try {
        const w = run(g)[1];
        return w === undefined ? w : w * (privateOf(g).m?.[0] ?? 1);
      } catch {
        return undefined;
      }
    },
  };
}
