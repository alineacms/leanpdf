/**
 * Glyph name tables shared by the font parsers: the 391 CFF standard strings (the first 149 after
 * .notdef are also the names of StandardEncoding), the predefined CFF charsets and encodings, and
 * the 258 standard Macintosh glyph names of TrueType post tables. Packed strings decoded on first
 * use; the Type 1 parser only pulls in the Latin part.
 */

/**
 * Packing: a digit stands for a common suffix (SUFFIX), `#x` for zerox .. ninex and `@Ax` / `@ax`
 * for Ax .. Zx / ax .. zx.
 */
const SUFFIX = /* @__PURE__ */ ' acute circumflex dieresis grave tilde small superior oldstyle inferior'.split(' ');
const DIGITS = /* @__PURE__ */ 'zero one two three four five six seven eight nine'.split(' ');

/** SIDs 0-228: the ISOAdobe charset. */
const LATIN =
  '.notdef space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma ' +
  'hyphen period slash # colon semicolon less equal greater question at @A bracketleft backslash bracketright asciicircum ' +
  'underscore quoteleft @a braceleft bar braceright ascii5 exclamdown cent sterling fraction yen florin section currency ' +
  'quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger daggerdbl periodcentered ' +
  'paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand questiondown 4 1 2 5 ' +
  'macron breve dotaccent 3 ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine ' +
  'ae dotlessi lslash oslash oe germandbls one7 logicalnot mu trademark Eth onehalf plusminus Thorn onequarter divide ' +
  'brokenbar degree thorn threequarters two7 registered minus eth multiply three7 copyright A1 A2 A3 A4 Aring A5 ' +
  'Ccedilla E1 E2 E3 E4 I1 I2 I3 I4 N5 O1 O2 O3 O4 O5 Scaron U1 U2 U3 U4 Y1 Y3 Zcaron a1 a2 a3 a4 aring a5 ccedilla ' +
  'e1 e2 e3 e4 i1 i2 i3 i4 n5 o1 o2 o3 o4 o5 scaron u1 u2 u3 u4 y1 y3 zcaron';

/** SIDs 229-378: the expert glyphs (then 379-390, spelled out in cffStrings). */
const EXPERT =
  'exclam6 Hungarumlaut6 dollar8 dollar7 ampersand6 Acute6 parenleft7 parenright7 twodotenleader onedotenleader #8 ' +
  'comma7 threequartersemdash period7 question6 a7 b7 cent7 d7 e7 i7 l7 m7 n7 o7 r7 s7 t7 ff ffi ffl parenleft9 ' +
  'parenright9 Circumflex6 hyphen7 Grave6 @A6 colonmonetary onefitted rupiah Tilde6 exclamdown6 cent8 Lslash6 Scaron6 ' +
  'Zcaron6 Dieresis6 Breve6 Caron6 Dotaccent6 Macron6 figuredash hyphen9 Ogonek6 Ring6 Cedilla6 questiondown6 oneeighth ' +
  'threeeighths fiveeighths seveneighths onethird twothirds zero7 four7 five7 six7 seven7 eight7 nine7 #9 cent9 dollar9 ' +
  'period9 comma9 A46 A16 A26 A56 A36 Aring6 AE6 Ccedilla6 E46 E16 E26 E36 I46 I16 I26 I36 Eth6 N56 O46 O16 O26 O56 ' +
  'O36 OE6 Oslash6 U46 U16 U26 U36 Y16 Thorn6 Y36';

/** Character codes of StandardEncoding, assigned SIDs 1, 2, 3, ... in order. */
const STANDARD_CODES = '32-126 161-175 177-180 182-189 191 193-200 202-203 205-208 225 227 232-235 241 245 248-251';
/** Character codes of the CFF expert encoding, assigned the expert charset's glyphs in order. */
const EXPERT_CODES = '32-34 36-63 65-69 73 76-79 82-84 86-91 93-126 161-163 166-170 172 175 178-179 182-184 188-197 200-255';
/** The predefined Expert and ExpertSubset charsets as SIDs, .notdef left out. */
const EXPERT_CHARSET = '1 229-238 13-15 99 239-248 27-28 249-266 109-110 267-318 158 155 163 319-326 150 164 169 327-378';
const EXPERT_SUBSET =
  '1 231-232 235-238 13-15 99 239-248 27-28 249-251 253-266 109-110 267-270 272 300-302 305 314-315 158 155 163 320-326 ' +
  '150 164 169 327-346';

function unpack(s: string): string[] {
  return s
    .replace(/\d/g, (c) => SUFFIX[+c])
    .split(' ')
    .flatMap((t) =>
      t[0] === '#'
        ? DIGITS.map((d) => d + t.slice(1))
        : t[0] === '@'
          ? Array.from({ length: 26 }, (_, i) => String.fromCharCode(t.charCodeAt(1) + i) + t.slice(2))
          : t,
    );
}

/** "a-b c": the numbers a to b, then c. Other tokens are kept as strings. */
export const runs = (s: string): (number | string)[] =>
  s.split(' ').flatMap((t): (number | string)[] | string => {
    const [a, b = a] = t.split('-').map(Number);
    return a === a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : t;
  });

let latin: string[] | undefined;
let all: string[] | undefined;
let standard: string[] | undefined;

/** Glyph names of SIDs 0-228 (the ISOAdobe charset). */
export const latinNames = (): string[] => (latin ??= unpack(LATIN));

/** The 391 CFF standard strings, by SID. */
export const cffStrings = (): string[] =>
  (all ??= [
    ...latinNames(),
    ...unpack(EXPERT),
    ...'001.000 001.001 001.002 001.003 Black Bold Book Light Medium Regular Roman Semibold'.split(' '),
  ]);

/** Glyph names by code of `codes`, given the SIDs they get in order. */
function encoding(codes: string, sids: (number | string)[], names: string[]): string[] {
  const out: string[] = [];
  runs(codes).forEach((c, i) => (out[c as number] = names[sids[i] as number]));
  return out;
}

/** StandardEncoding: glyph names by character code (undefined where unassigned). */
export const standardEncoding = (): string[] =>
  (standard ??= encoding(STANDARD_CODES, Array.from({ length: 149 }, (_, i) => i + 1), latinNames()));

/** The CFF expert encoding (predefined encoding 1). */
export const expertEncoding = (): string[] => encoding(EXPERT_CODES, runs(EXPERT_CHARSET), cffStrings());

/** SIDs of a predefined CFF charset (0 ISOAdobe, 1 Expert, 2 ExpertSubset), .notdef included. */
export const predefinedCharset = (id: number): number[] =>
  id ? [0, ...(runs(id === 1 ? EXPERT_CHARSET : EXPERT_SUBSET) as number[])] : Array.from({ length: 229 }, (_, i) => i);
