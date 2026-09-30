/**
 * Type 1 font programs (FontFile): a cleartext part, then the eexec-encrypted private part in
 * binary or hex, optionally PFB-segmented. Charstrings are decrypted and interpreted on demand;
 * hints are skipped and flex becomes its two curves.
 */
import { concat, latin1 } from '../../core/bytes.ts';
import { CLOSE, CUBIC, LINE, MOVE, transformOutline, type FontProgram, type Matrix, type Outline } from './program.ts';
import { standardEncoding } from './standard.ts';

/** Subroutine nesting, and bytes interpreted per glyph (subroutines and seac parts included). */
const MAX_DEPTH = 10;
const MAX_OPS = 200_000;

/** A PostScript name after its slash. */
const NAME = '([^\\s/[\\]{}()<>%]+)';

/** eexec (r = 55665) and charstring (r = 4330) decryption, dropping the first `skip` bytes. */
function decrypt(d: Uint8Array, r: number, skip: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, d.length - skip));
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (i >= skip) out[i - skip] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

const hexValue = (c: number): number => (c > 47 && c < 58 ? c - 48 : (c |= 32) > 96 && c < 103 ? c - 87 : -1);

/**
 * The decrypted private part if eexec data (hex when it starts with 4 hex digits) begins at `p`:
 * after the 4 random bytes, the start must read as text. `max` limits the bytes decrypted.
 */
function eexec(d: Uint8Array, p: number, max: number): Uint8Array | undefined {
  if (!(p > 0 && p + 4 < d.length)) return;
  let src = d.subarray(p, p + max);
  if (hexValue(d[p]) >= 0 && hexValue(d[p + 1]) >= 0 && hexValue(d[p + 2]) >= 0 && hexValue(d[p + 3]) >= 0) {
    // Hex digits, whitespace between them allowed.
    const out = new Uint8Array(Math.min(max, (d.length - p) >> 1));
    let n = 0;
    for (let i = p, hi = -1; i < d.length && n < out.length; i++) {
      const v = hexValue(d[i]);
      if (v >= 0) hi < 0 ? (hi = v) : ((out[n++] = hi * 16 + v), (hi = -1));
      else if (d[i] > 32) break;
    }
    src = out.subarray(0, n);
  }
  const plain = decrypt(src, 55665, 4);
  for (let i = 0; i < Math.min(plain.length, 32); i++) {
    const c = plain[i];
    if (c > 126 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return;
  }
  return plain;
}

/**
 * Parse a Type 1 font program (FontFile): cleartext part, eexec-encrypted part (binary or hex),
 * optionally PFB-segmented. `length1` (the stream's /Length1, the cleartext size) is tried first
 * but may be wrong: the encrypted part is also looked for after `eexec`. The encrypted part runs
 * to the end of the data, so `length2` is not needed. Throws when no glyphs are found.
 *
 * Outlines start at the left side bearing point of hsbw / sbw; `advance` is its width.
 */
export function parseType1(data: Uint8Array, length1?: number, length2?: number): FontProgram {
  let d = data;
  if (d[0] === 0x80 && d[1] === 1) {
    // PFB: 6-byte segment headers (0x80, type, 32-bit little-endian length); type 3 ends.
    const parts: Uint8Array[] = [];
    for (let p = 0; d[p] === 0x80 && d[p + 1] < 3; ) {
      const n = d[p + 2] | (d[p + 3] << 8) | (d[p + 4] << 16) | (d[p + 5] << 24);
      if (!parts.length) length1 = n;
      parts.push(d.subarray(p + 6, (p += 6 + n)));
    }
    d = concat(parts);
  }
  const text = latin1(d);
  const e = text.indexOf('eexec');
  // /Length1, else right after `eexec` and up to 3 bytes of line end.
  const at = [length1 ?? 0, e + 5, e + 6, e + 7, e + 8].find((p) => (p === length1 || e >= 0) && eexec(d, p, 36));
  const priv = at ? eexec(d, at, d.length)! : d;
  const clear = at ? text.slice(0, at) : text;
  const pt = at ? latin1(priv) : text;

  const lenIV = +(/\/lenIV\s+(-?\d+)/.exec(pt)?.[1] ?? 4);
  // Subrs: `dup i n RD <n bytes> NP`, CharStrings: `/name n RD <n bytes> ND`, with any spelling
  // of RD, NP and ND. Entries follow each other closely; a long gap means the list ended.
  const entries = (re: RegExp, start: RegExp, add: (m: RegExpExecArray, a: number, b: number) => void): void => {
    const h = start.exec(pt);
    if (!h) return;
    for (let pos = (re.lastIndex = h.index + h[0].length), m; (m = re.exec(pt)) && m.index - pos < 64; ) {
      const a = m.index + m[0].length;
      add(m, a, (pos = re.lastIndex = a + +m[2]));
    }
  };
  const subrs: [number, number][] = [];
  entries(/dup\s+(\d+)\s+(\d+)\s+\S+\s/g, /\/Subrs\s+\d+/, (m, a, b) => (subrs[+m[1]] = [a, b]));
  const names: string[] = [];
  const glyphs: [number, number][] = [];
  entries(new RegExp(`/${NAME}\\s+(\\d+)\\s+\\S+\\s`, 'g'), /\/CharStrings\s+\d+/, (m, a, b) => {
    names.push(m[1]);
    glyphs.push([a, b]);
  });
  if (!glyphs.length) throw new Error('Type 1 font without CharStrings');

  let encoding: (string | undefined)[] | undefined;
  const em = /\/Encoding\s+(StandardEncoding|\d+)/.exec(clear);
  if (em?.[1][0] === 'S') encoding = [...standardEncoding()];
  else if (em) {
    encoding = [];
    for (const m of clear.slice(em.index).matchAll(new RegExp(`dup\\s+(\\d+)\\s*/${NAME}\\s+put`, 'g'))) {
      if (+m[1] < 256) encoding[+m[1]] = m[2];
    }
  }
  const fm = /\/FontMatrix\s*[[{]([^\]}]*)/.exec(clear)?.[1].trim().split(/\s+/).map(Number);
  const matrix: Matrix = fm?.length === 6 && fm.every(Number.isFinite) ? (fm as Matrix) : [0.001, 0, 0, 0.001, 0, 0];

  let byName: Map<string, number> | undefined;
  const gidForName = (name: string): number => {
    if (!byName) {
      byName = new Map();
      for (let g = names.length; g--; ) byName.set(names[g], g);
    }
    return byName.get(name) ?? -1;
  };
  const charstring = (r: [number, number] | undefined): Uint8Array | undefined =>
    r && (lenIV < 0 ? priv.subarray(...r) : decrypt(priv.subarray(...r), 4330, lenIV));

  /** Interpret glyph `g`: its outline and advance width. */
  const run = (g: number, seac = true): [Outline, number?] => {
    const out: Outline = [];
    const st: number[] = [];
    let x = 0;
    let y = 0;
    // Side bearing point, start of the current subpath.
    let sbx = 0;
    let sx = 0;
    let sy = 0;
    let w: number | undefined;
    let open = false;
    let flex: number[] | undefined;
    let ops = MAX_OPS;
    const move = (dx: number, dy: number): void => {
      x += dx;
      y += dy;
      // During flex, movetos only collect the points.
      if (flex) flex.push(x, y);
      else {
        if (open) out.push(CLOSE);
        out.push(MOVE, (sx = x), (sy = y));
        open = true;
      }
    };
    // Drawing without a moveto starts at the side bearing point, or after closepath where the
    // closed subpath started (as FreeType does).
    const begin = (): void => {
      if (!open) out.push(MOVE, sx, sy);
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
    const exec = (cs: Uint8Array | undefined, depth: number): boolean => {
      if (!cs || depth > MAX_DEPTH) return true;
      for (let p = 0; p < cs.length; ) {
        if (--ops < 0) return true;
        const b = cs[p++];
        if (b > 31) {
          if (b < 247) st.push(b - 139);
          else if (b < 251) st.push((b - 247) * 256 + cs[p++] + 108);
          else if (b < 255) st.push(-(b - 251) * 256 - cs[p++] - 108);
          else st.push((cs[p++] << 24) | (cs[p++] << 16) | (cs[p++] << 8) | cs[p++]);
          continue;
        }
        const s = st;
        switch (b) {
          case 13: // hsbw
            x = sx = sbx = s[0];
            y = sy = 0;
            w = s[1];
            break;
          case 9: // closepath
            if (open) out.push(CLOSE);
            open = false;
            break;
          case 21: // rmoveto, hmoveto, vmoveto
            move(s[0], s[1]);
            break;
          case 22:
            move(s[0], 0);
            break;
          case 4:
            move(0, s[0]);
            break;
          case 5: // rlineto, hlineto, vlineto
            line(s[0], s[1]);
            break;
          case 6:
            line(s[0], 0);
            break;
          case 7:
            line(0, s[0]);
            break;
          case 8: // rrcurveto, vhcurveto, hvcurveto
            curve(s[0], s[1], s[2], s[3], s[4], s[5]);
            break;
          case 30:
            curve(0, s[0], s[1], s[2], s[3], 0);
            break;
          case 31:
            curve(s[0], 0, s[1], s[2], 0, s[3]);
            break;
          case 10: // callsubr
            if (exec(charstring(subrs[s.pop()!]), depth + 1)) return true;
            continue;
          case 11: // return
            return false;
          case 14: // endchar
            return true;
          case 12: {
            const e = cs[p++];
            if (e === 12) {
              // div
              const v = s.pop()!;
              s.push(v ? s.pop()! / v : 0);
              continue;
            }
            if (e === 16) {
              // callothersubr: its arguments stay on the stack for the pops that follow (flex's
              // end point for setcurrentpoint, hint replacement's subroutine for callsubr).
              const k = s.pop();
              s.pop();
              if (k === 1) flex = [];
              else if (!k && flex) {
                // End of flex: a reference point, then the control and end points of two curves.
                const f = flex.slice(-12);
                flex = undefined;
                if (f.length === 12) {
                  begin();
                  out.push(CUBIC, ...f.slice(0, 6), CUBIC, ...f.slice(6));
                }
              }
              continue;
            }
            if (e === 17) continue; // pop
            if (e === 7) {
              // sbw
              x = sx = sbx = s[0];
              y = sy = s[1];
              w = s[2];
            } else if (e === 33) {
              // setcurrentpoint: moves without drawing
              [x, y] = s.slice(-2);
            } else if (e === 6 && seac) {
              // seac: the accent's origin is offset by adx - asb from the sidebearing point.
              const [asb, adx, ady, bc, ac] = s.slice(-5);
              const enc = standardEncoding();
              const base = run(gidForName(enc[bc] ?? ''), false)[0];
              out.length = 0;
              for (const v of base) out.push(v);
              transformOutline(run(gidForName(enc[ac] ?? ''), false)[0], [1, 0, 0, 1, adx - asb + sbx, ady], out);
              open = false;
              return true;
            }
            break;
          }
        }
        s.length = 0;
      }
      return false;
    };
    if (!glyphs[g]) return [out];
    exec(charstring(glyphs[g]), 0);
    if (open) out.push(CLOSE);
    return [out, w];
  };

  return {
    kind: 'type1',
    matrix,
    glyphCount: glyphs.length,
    outline(g) {
      try {
        const o = run(g)[0];
        return o.every(Number.isFinite) ? o : [];
      } catch {
        return [];
      }
    },
    gidForName,
    encoding,
    advance(g) {
      try {
        return run(g)[1];
      } catch {
        return undefined;
      }
    },
  };
}
