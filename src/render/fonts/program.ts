/**
 * Embedded font programs as the renderer uses them: glyph outlines and the tables that map
 * character codes, glyph names and CIDs to glyphs. Parsers: ./truetype.ts (TrueType and OpenType,
 * whose CFF outlines go through ./cff.ts), ./cff.ts (bare CFF, name-keyed and CID-keyed) and
 * ./type1.ts (Type 1). Hinting is ignored; the browser rasterizes the outlines.
 */

/** Outline commands, followed by their coordinates in glyph units (before the font matrix). */
export const MOVE = 0; // x y
export const LINE = 1; // x y
export const QUAD = 2; // cx cy x y
export const CUBIC = 3; // c1x c1y c2x c2y x y
export const CLOSE = 4;

/**
 * A glyph outline: a flat list of commands and their coordinates. Empty for blank glyphs. The
 * parsers start every subpath with MOVE and end it with CLOSE; fill with the nonzero rule.
 */
export type Outline = number[];

export type Matrix = [number, number, number, number, number, number];

export interface CMapTable {
  platform: number;
  encoding: number;
  /** Glyph index for a character code, or -1. */
  lookup(code: number): number;
}

export interface FontProgram {
  kind: 'truetype' | 'cff' | 'type1';
  /** Maps glyph units to text space (1 unit = the font size), e.g. [0.001, 0, 0, 0.001, 0, 0]. */
  matrix: Matrix;
  glyphCount: number;
  /** A glyph's outline in glyph units; [] for blank, missing or broken glyphs. Never throws. */
  outline(gid: number): Outline;
  /** Glyph index for a PostScript glyph name (CharStrings, CFF charset, TrueType post table), or -1. */
  gidForName(name: string): number;
  /** The font's built-in encoding: glyph names by character code (Type 1 /Encoding, CFF encoding). */
  encoding?: (string | undefined)[];
  /** TrueType and OpenType cmap subtables. */
  cmaps?: CMapTable[];
  /** CID-keyed CFF: glyph index for a CID, or -1. Absent for name-keyed fonts. */
  gidForCid?(cid: number): number;
  /** Advance width in glyph units, when the program says. */
  advance?(gid: number): number | undefined;
}

/** Append `o` to `out` transformed by `m` (x' = a x + c y + e, y' = b x + d y + f); returns `out`. */
export function transformOutline(o: Outline, m: Matrix, out: Outline = []): Outline {
  for (let i = 0; i < o.length; ) {
    const op = o[i++];
    out.push(op);
    // Points per command: MOVE and LINE 1, QUAD 2, CUBIC 3, CLOSE 0.
    for (let n = op > 3 ? 0 : op || 1; n--; i += 2) out.push(m[0] * o[i] + m[2] * o[i + 1] + m[4], m[1] * o[i] + m[3] * o[i + 1] + m[5]);
  }
  return out;
}
