/**
 * TrueType and OpenType fonts (FontFile2, FontFile3 /OpenType): glyf outlines as quadratic curves,
 * or the 'CFF ' table's cubic ones through ./cff.ts. Glyphs are decoded on demand; instructions are
 * ignored. Embedded subsets are often damaged: missing tables, bad offsets and glyphs running past
 * their table degrade to empty glyphs instead of errors.
 */
import { parseCFF } from './cff.ts';
import { CLOSE, LINE, MOVE, QUAD, transformOutline, type CMapTable, type FontProgram, type Outline } from './program.ts';
import { latinNames, runs } from './standard.ts';

/** The 258 standard Macintosh glyph names (post format 1, and names 0-257 of format 2): SIDs and extra names. */
const MAC_NAMES =
  '0 .null nonmarkingreturn 1-7 104 9-64 124 66-95 173 175 177-178 186 189 195 200 203 201-202 205 204 206-207 210 208-209 ' +
  '211 214 212-213 215-216 219 217-218 220 222 225 223-224 112 161 97-98 102 116 115 149 165 170 153 125 131 notequal 138 141 ' +
  'infinity 156 lessequal greaterequal 100 152 partialdiff summation product pi integral 139 143 Omega 144 147 123 96 151 ' +
  'radical 101 approxequal Delta 106 120-121 nonbreakingspace 174 176 191 142 148 111 137 105 119 65 8 159 lozenge 227 198 ' +
  '99 103 107-110 113-114 117-118 122 172 179 171 180-185 187-188 apple 190 193-194 196 145 126-130 132-136 140 146 192 221 ' +
  '199 228 160 154 167 197 226 157 162 166 168 150 164 169 155 158 163 franc Gbreve gbreve Idotaccent Scedilla scedilla ' +
  'Cacute cacute Ccaron ccaron dcroat';

/** Composite glyph nesting, and components and points per glyph (bounding damaged composites). */
const MAX_DEPTH = 8;
const MAX_PARTS = 256;
const MAX_POINTS = 1 << 18;

let mac: string[] | undefined;
const macNames = (): string[] =>
  (mac ??= runs(MAC_NAMES).map((t) => (typeof t === 'number' ? latinNames()[t] : t)));

/**
 * Parse a TrueType font, an OpenType font or the first font of a TrueType collection (or bare CFF,
 * handed to ./cff.ts). Throws only when there are no outlines at all.
 *
 * glyf fonts get `kind` 'truetype' and a matrix of 1 / unitsPerEm. OpenType fonts with a 'CFF '
 * table are the CFF program (`kind` 'cff', its matrix, charset names, advances) plus the cmaps.
 */
export function parseTrueType(data: Uint8Array): FontProgram {
  const d = data;
  // Bare CFF labeled as OpenType.
  if (d[0] === 1 && d[1] === 0) return parseCFF(d);
  if (d.length < 12) throw new Error('Not a TrueType font');
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (p: number): number => dv.getUint16(p);
  const i16 = (p: number): number => dv.getInt16(p);
  const u32 = (p: number): number => dv.getUint32(p);
  const dir = u32(0) === 0x74746366 ? u32(12) : 0; // 'ttcf'
  const tables = new Map<string, [number, number]>();
  for (let i = 0, k = u16(dir + 4); i < k && dir + 28 + 16 * i <= d.length; i++) {
    const r = dir + 12 + 16 * i;
    const off = u32(r + 8);
    if (off < d.length) tables.set(String.fromCharCode(d[r], d[r + 1], d[r + 2], d[r + 3]), [off, Math.min(u32(r + 12), d.length - off)]);
  }
  const [head, maxp, loca, glyf, hhea, hmtx, post, cmap, cff] = 'head maxp loca glyf hhea hmtx post cmap CFF'
    .split(' ')
    .map((t) => tables.get(t.padEnd(4)));

  const cmaps: CMapTable[] = [];
  for (let i = 0, k = cmap && cmap[1] >= 4 ? u16(cmap[0] + 2) : 0; i < k && 8 * i + 12 <= cmap![1]; i++) {
    const r = cmap![0] + 4 + 8 * i;
    const p = cmap![0] + u32(r + 4);
    const f = p + 2 <= d.length ? u16(p) : -1;
    let lookup: ((c: number) => number) | undefined;
    if (f === 0) lookup = (c) => (c < 256 ? d[p + 6 + c] : 0);
    else if (f === 2) {
      // High-byte mapping: a subHeader per lead byte, subHeader 0 for single bytes.
      lookup = (c) => {
        const k = u16(p + 6 + 2 * (c < 256 ? c : c >> 8));
        if (c < 256 ? k : !k || c > 0xffff) return 0;
        const sh = p + 518 + k;
        const i = (c & 255) - u16(sh);
        const g = i >= 0 && i < u16(sh + 2) ? u16(sh + 6 + u16(sh + 6) + 2 * i) : 0;
        return g && (g + i16(sh + 4)) & 0xffff;
      };
    } else if (f === 4) {
      const segs = u16(p + 6) >> 1;
      const ends = p + 14;
      const starts = ends + 2 * segs + 2;
      const deltas = starts + 2 * segs;
      const offs = deltas + 2 * segs;
      lookup = (c) => {
        let lo = 0;
        for (let hi = segs; lo < hi; ) {
          const m = (lo + hi) >> 1;
          if (u16(ends + 2 * m) < c) lo = m + 1;
          else hi = m;
        }
        const s = 2 * lo;
        if (lo >= segs || u16(starts + s) > c) return 0;
        const ro = u16(offs + s);
        const g = ro ? u16(offs + s + ro + 2 * (c - u16(starts + s))) : c;
        return (ro && !g) || c > 0xffff ? 0 : (g + i16(deltas + s)) & 0xffff;
      };
    } else if (f === 6 || f === 10) {
      // Trimmed arrays, 16 or 32-bit fields.
      const w = f === 6;
      const first = w ? u16(p + 6) : u32(p + 12);
      const n = w ? u16(p + 8) : u32(p + 16);
      lookup = (c) => (c >= first && c - first < n ? u16(p + (w ? 10 : 20) + 2 * (c - first)) : 0);
    } else if (f === 12 || f === 13) {
      // Sorted groups of [start, end, glyph]: consecutive glyphs (12) or one glyph (13).
      const n = Math.min(u32(p + 12), (d.length - p) / 12);
      lookup = (c) => {
        let lo = 0;
        for (let hi = n; lo < hi; ) {
          const m = (lo + hi) >>> 1;
          if (u32(p + 16 + 12 * m + 4) < c) lo = m + 1;
          else hi = m;
        }
        const q = p + 16 + 12 * lo;
        return lo < n && u32(q) <= c ? u32(q + 8) + (f === 12 ? c - u32(q) : 0) : 0;
      };
    }
    if (lookup) {
      const fn = lookup;
      cmaps.push({
        platform: u16(r),
        encoding: u16(r + 2),
        lookup(c) {
          try {
            return fn(c) || -1;
          } catch {
            return -1;
          }
        },
      });
    }
  }

  const upem = head && head[1] > 19 ? u16(head[0] + 18) : 0;
  const nh = hhea && hhea[1] > 35 ? u16(hhea[0] + 34) : 0;
  const hAdvance = (g: number, n: number): number | undefined => {
    const q = hmtx![0] + 4 * Math.min(g, nh - 1);
    return g >= 0 && g < n && q + 2 <= hmtx![0] + hmtx![1] ? u16(q) : undefined;
  };
  if (cff) {
    try {
      const p = parseCFF(d.subarray(cff[0], cff[0] + cff[1]));
      // Advances from hmtx as other OpenType consumers do (CFF widths may disagree), in CFF units
      // (FontMatrix entries are often rounded decimals of 1 / unitsPerEm).
      const k = Math.round(1e4 / (upem * p.matrix[0])) / 1e4;
      const advance = (g: number): number | undefined => {
        const a = hAdvance(g, p.glyphCount);
        return a === undefined ? a : a * k;
      };
      return { ...p, cmaps, advance: hmtx && nh && Number.isFinite(k) ? advance : p.advance };
    } catch (e) {
      if (!glyf) throw e;
    }
  }
  if (!glyf || !loca) throw new Error('TrueType font without glyph outlines');

  const nLoca = loca[1];
  let count = maxp && maxp[1] > 5 ? u16(maxp[0] + 4) : 0;
  // indexToLocFormat, or a guess from the loca size when head is missing.
  const long = head && head[1] > 51 ? i16(head[0] + 50) === 1 : nLoca >= 4 * (count + 1) && count > 0;
  count = Math.min(count || Infinity, (nLoca >> (long ? 2 : 1)) - 1);
  if (count < 1) throw new Error('TrueType font without glyphs');
  let parts = 0;
  let points = 0;

  const glyph = (g: number, depth: number): Outline => {
    const out: Outline = [];
    if (!(g >= 0 && g < count) || g % 1) return out;
    const at = (i: number): number => (long ? u32(loca[0] + 4 * i) : 2 * u16(loca[0] + 2 * i));
    const start = at(g);
    let end = at(g + 1);
    // A glyph may run past the declared end of glyf (not start there); a bad end is the file's.
    if (end > d.length - glyf[0] || end < start) end = d.length - glyf[0];
    if (start >= glyf[1] || end - start < 10) return out;
    let p = glyf[0] + start;
    end += glyf[0];
    const nc = i16(p);
    p += 10;
    if (nc < 0) {
      // Composite: transformed components, offsets from ARGS_ARE_XY_VALUES (point matching is
      // approximated by no offset).
      for (let f = 32; f & 32 && parts++ < MAX_PARTS; ) {
        f = u16(p);
        const cg = u16(p + 2);
        const words = f & 1;
        let dx = f & 2 ? (words ? i16(p + 4) : (d[p + 4] << 24) >> 24) : 0;
        let dy = f & 2 ? (words ? i16(p + 6) : (d[p + 5] << 24) >> 24) : 0;
        p += words ? 8 : 6;
        const n = f & 8 ? 1 : f & 0x40 ? 2 : f & 0x80 ? 4 : 0;
        const v = [1, 0, 0, 1];
        for (let k = 0; k < n; k++, p += 2) v[n === 4 ? k : n === 2 ? 3 * k : 0] = i16(p) / 16384;
        if (n === 1) v[3] = v[0];
        // SCALED_COMPONENT_OFFSET: the offset is transformed too.
        if (f & 0x800) [dx, dy] = [v[0] * dx + v[2] * dy, v[1] * dx + v[3] * dy];
        if (depth < MAX_DEPTH) transformOutline(glyph(cg, depth + 1), [v[0], v[1], v[2], v[3], dx, dy], out);
      }
      return p > end ? [] : out;
    }
    const ends: number[] = [];
    for (let i = 0; i < nc; i++, p += 2) ends.push(u16(p));
    const np = nc ? ends[nc - 1] + 1 : 0;
    if ((points -= np) < 0) return [];
    p += 2 + u16(p);
    const flags = new Uint8Array(np);
    for (let i = 0; i < np; ) {
      const f = d[p++];
      flags[i++] = f;
      if (f & 8) for (let k = d[p++]; k-- > 0 && i < np; ) flags[i++] = f;
    }
    // x then y: short (1 byte, sign in `same`), same as before, or a 16-bit delta.
    const xy = [new Int32Array(np), new Int32Array(np)];
    for (let a = 0; a < 2; a++) {
      for (let i = 0, v = 0, short = 2 << a, same = 16 << a; i < np; i++) {
        const f = flags[i];
        xy[a][i] = v += f & short ? (f & same ? d[p++] : -d[p++]) : f & same ? 0 : i16((p += 2) - 2);
      }
    }
    if (p > end) return [];
    const [xs, ys] = xy;
    for (let c = 0, s = 0; c < nc; s = ends[c++] + 1) {
      const e = ends[c];
      // Contour ends must increase (as FreeType requires): overlapping contours could repeat
      // most points many times over.
      if (e < s) return [];
      // Start at an on-curve point: the first, else the last, else between the two.
      let i0 = s;
      let i1 = e;
      let sx = (xs[s] + xs[e]) / 2;
      let sy = (ys[s] + ys[e]) / 2;
      if (flags[s] & 1) (sx = xs[s]), (sy = ys[s]), i0++;
      else if (flags[e] & 1) (sx = xs[e]), (sy = ys[e]), i1--;
      out.push(MOVE, sx, sy);
      let off = false;
      let cx = 0;
      let cy = 0;
      for (let i = i0; i <= i1; i++) {
        const x = xs[i];
        const y = ys[i];
        if (flags[i] & 1) off ? out.push(QUAD, cx, cy, x, y) : out.push(LINE, x, y);
        else if (off) out.push(QUAD, cx, cy, (cx + x) / 2, (cy + y) / 2);
        off = !(flags[i] & 1);
        cx = x;
        cy = y;
      }
      if (off) out.push(QUAD, cx, cy, sx, sy);
      out.push(CLOSE);
    }
    return out;
  };

  let names: Map<string, number> | undefined;
  const scale = 1 / (upem > 15 && upem < 16385 ? upem : 1000);
  return {
    kind: 'truetype',
    matrix: [scale, 0, 0, scale, 0, 0],
    glyphCount: count,
    outline(g) {
      parts = 0;
      points = MAX_POINTS;
      try {
        return glyph(g, 0);
      } catch {
        return [];
      }
    },
    gidForName(name) {
      if (!names) {
        names = new Map();
        try {
          const v = post ? u32(post[0]) : 0;
          const std = macNames();
          if (v === 0x10000) for (let g = Math.min(258, count); g--; ) names.set(std[g], g);
          else if (v === 0x20000) {
            const n = u16(post![0] + 32);
            const idx = post![0] + 34;
            const extra: string[] = [];
            // Pascal strings after the index.
            for (let q = idx + 2 * n, e = post![0] + post![1]; q < e; q += d[q] + 1) {
              extra.push(String.fromCharCode(...d.subarray(q + 1, q + 1 + d[q])));
            }
            // Backwards, so the first glyph of a name wins.
            for (let g = Math.min(n, count); g--; ) {
              const i = u16(idx + 2 * g);
              const nm = i < 258 ? std[i] : extra[i - 258];
              if (nm) names.set(nm, g);
            }
          }
        } catch {
          // A damaged post table gives no (or fewer) names.
        }
      }
      return names.get(name) ?? -1;
    },
    cmaps,
    advance: hmtx && nh ? (g) => hAdvance(g, count) : undefined,
  };
}
