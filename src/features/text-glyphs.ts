/**
 * Glyph names and simple-font encodings for text extraction: a compact subset of the Adobe Glyph
 * List (Latin, Latin Extended through accent composition, Greek, Cyrillic, punctuation), the
 * standard base encodings, and base-14 glyph widths for fonts without /Widths. Tables are packed
 * strings decoded on first use.
 */

/** Names that cannot be derived: one non-alphanumeric character followed by its glyph name. */
const PACKED =
  ' space!exclam"quotedbl#numbersign$dollar%percent&ampersand\'quotesingle’quoteright(parenleft)parenright*asterisk+plus' +
  ',comma-hyphen.period/slash:colon;semicolon<less=equal>greater?question@at[bracketleft\\backslash]bracketright^asciicircum' +
  '_underscore`grave‘quoteleft{braceleft|bar}braceright~asciitilde¡exclamdown¢cent£sterling⁄fraction¥yenƒflorin§section' +
  '¤currency“quotedblleft«guillemotleft‹guilsinglleft›guilsinglright–endash†dagger‡daggerdbl·periodcentered·middot¶paragraph' +
  '•bullet‚quotesinglbase„quotedblbase”quotedblright»guillemotright…ellipsis‰perthousand¿questiondown´acuteˆcircumflex˜tilde' +
  '¯macron˘breve˙dotaccent¨dieresis˚ring¸cedilla˝hungarumlaut˛ogonekˇcaron—emdashÆAEªordfeminineŁLslashØOslashŒOEºordmasculine' +
  'æaeıdotlessiłlslashøoslashœoeßgermandbls€Euro™trademark©copyright®registered°degree±plusminus×multiply÷divide−minus' +
  '¦brokenbar¬logicalnot¹onesuperior²twosuperior³threesuperior¼onequarter½onehalf¾threequartersÐEthðethÞThornþthorn' +
  'ȷdotlessjĐDcroatđdcroatĦHbarħhbarŦTbarŧtbarĲIJĳijĿLdotŀldotŊEngŋengĸkgreenlandicŉnapostropheſlongs nbspace-sfthyphen' +
  'ҐGheupturncyrillicґgheupturncyrillic';

const DIGITS = 'zero one two three four five six seven eight nine';
const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma1 sigma tau upsilon phi chi psi omega';
/** Cyrillic "...cyrillic" stems for U+0430..U+044F, then U+0450..U+045F (uppercase: -0x20 / -0x50). */
const CYRILLIC =
  'a be ve ge de ie zhe ze ii iishort ka el em en o pe er es te u ef kha tse che sha shcha hardsign yeri softsign ereversed iu ia' +
  ' - io dje gje e dze i yi je lje nje tshe kje - ushort dzhe';
/** Accent suffix, then the combining mark(s) to compose with the base glyph. */
const ACCENTS =
  'acutégravècircumflex̂tildẽmacron̄brevĕdotaccenṫdieresis̈ring̊' +
  'hungarumlaut̋caroňcedilla̧ogonek̨commaaccenţ̦tonośdotbeloẉhookabovẻ' +
  'horn̛doṫ';

let names: Map<string, string> | undefined;
let accents: [string, string][] | undefined;
let greek: string[] | undefined;
let cyrillic: string[] | undefined;

function table(): Map<string, string> {
  if (!names) {
    names = new Map();
    for (const m of PACKED.matchAll(/([^A-Za-z0-9])([A-Za-z0-9]+)/g)) names.set(m[2], m[1]);
    DIGITS.split(' ').forEach((n, i) => names!.set(n, String(i)));
    accents = [...ACCENTS.matchAll(/([a-z]+)([^a-z]+)/g)].map((m) => [m[1], m[2]]);
    greek = GREEK.split(' ');
    cyrillic = CYRILLIC.split(' ');
  }
  return names;
}

const hex = (s: string): number[] => s.match(/.{4}/g)!.map((h) => parseInt(h, 16));

/**
 * Unicode text for a glyph name, or undefined when the name means nothing we know. Handles
 * AGL-style suffixes (`.sc`), ligature components (`f_i`), `uniXXXX`, `uXXXX[XX]`, accented Latin
 * and Greek letters by composition, Greek, Cyrillic (`afii100NN` and `...cyrillic`), and small-cap
 * and old-style variants.
 */
export function glyphText(name: string): string | undefined {
  const map = table();
  let n = name;
  const dot = n.indexOf('.');
  if (dot >= 0) n = n.slice(0, dot);
  if (!n) return undefined;
  if (n.includes('_')) {
    const parts = n.split('_').map((p) => glyphText(p) ?? '');
    const s = parts.join('');
    return s || undefined;
  }
  if (/^[A-Za-z]$/.test(n) || /^f(f?[il]|f)$/.test(n)) return n; // letters and fi/fl/ff/ffi/ffl ligatures, expanded
  const v = map.get(n);
  if (v !== undefined) return v;
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(n);
  if (m) return String.fromCharCode(...hex(m[1]));
  m = /^u([0-9A-F]{4,6})$/.exec(n);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
  }
  // Greek: alpha..omega (U+03B1) and Alpha..Omega (U+0391).
  const lower = n[0].toLowerCase() + n.slice(1);
  let i = greek!.indexOf(lower);
  if (i >= 0 && (n === lower || i !== 17)) return String.fromCharCode((n === lower ? 0x3b1 : 0x391) + i);
  m = /^afii(\d{5})$/.exec(n);
  if (m) return afii(+m[1]);
  if (n.endsWith('cyrillic') && n.length > 8) {
    const stem = n.slice(0, -8);
    const up = stem[0] !== stem[0].toLowerCase();
    i = cyrillic!.indexOf(stem.toLowerCase());
    if (i >= 0) return String.fromCharCode((up ? (i < 32 ? 0x410 : 0x3e0) : 0x430) + i);
  }
  for (const [suffix, marks] of accents!) {
    if (n.length > suffix.length && n.endsWith(suffix)) {
      const base = glyphText(n.slice(0, -suffix.length));
      if (base?.length !== 1) continue;
      for (const mark of marks) {
        const c = (base + mark).normalize('NFC');
        if (c.length === 1) return c;
      }
    }
  }
  m = /^(.+?)(small|oldstyle|superior|inferior|greek)$/.exec(n);
  if (m) {
    const t = glyphText(m[1]);
    return m[2] === 'small' ? t?.toLowerCase() : t;
  }
  return undefined;
}

/** Cyrillic afii names (afii10017..afii10110, afii10145, afii10193). */
function afii(n: number): string | undefined {
  if (n === 10145 || n === 10193) return n === 10145 ? 'Џ' : 'џ';
  if (n < 10017 || n > 10110) return undefined;
  const up = n < 10065;
  const k = n - (up ? 10017 : 10065);
  const base = up ? 0x410 : 0x430;
  const ext = up ? 0x400 : 0x450;
  const cp = k < 6 ? base + k : k === 6 ? ext + 1 : k < 33 ? base + k - 1 : k === 33 ? (up ? 0x490 : 0x491) : k < 45 ? ext + k - 32 : k === 45 ? ext + 14 : 0;
  return cp ? String.fromCharCode(cp) : undefined;
}

/**
 * A glyph name like g65, G65, c65, cid65 or a65 that just spells out a number: the caller uses
 * the base encoding when it equals the character code.
 */
export const numericGlyph = (name: string): number | undefined => {
  const m = /^(?:[gGcCa]|cid)(\d{1,5})$/.exec(name);
  return m ? +m[1] : undefined;
};

// ---------------------------------------------------------------------------------------------
// Base encodings, as Unicode for each code. '_' marks an unused code in the high halves.

const STD_HIGH =
  "_¡¢£⁄¥ƒ§¤'“«‹›ﬁﬂ_–†‡·_¶•‚„”»…‰_¿_`´ˆ˜¯˘˙¨_˚¸_˝˛ˇ—________________Æ_ª____ŁØŒº_____æ___ı__łøœß____";
const WIN_HIGH = '€_‚ƒ„…†‡ˆ‰Š‹Œ_Ž__‘’“”•–—˜™š›œ_žŸ';
const MAC_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ_ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const SYM_LOW =
  ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';
/** Symbol 0xA0..0xBC; the rest (arrows, set theory, bracket pieces) is not searchable text. */
const SYM_HIGH = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…';

/**
 * Unicode text for each of the 256 codes of a base encoding ('' when undefined): StandardEncoding,
 * WinAnsiEncoding, MacRomanEncoding (MacExpertEncoding is read as StandardEncoding), or the
 * built-in encodings of Symbol and ZapfDingbats (dingbats are not text: only the space is kept).
 */
export function baseEncoding(enc: string): string[] {
  const sym = enc === 'Symbol';
  const win = enc === 'WinAnsiEncoding';
  const mac = enc === 'MacRomanEncoding';
  const high = win ? WIN_HIGH : mac ? MAC_HIGH : sym ? SYM_HIGH : STD_HIGH;
  return Array.from({ length: 256 }, (_, c) => {
    if (enc === 'ZapfDingbats' || c < 32) return c === 32 ? ' ' : '';
    if (c < 127) return sym ? SYM_LOW[c - 32] : !win && !mac && (c === 39 || c === 96) ? (c === 39 ? '’' : '‘') : String.fromCharCode(c);
    const t = win && c >= 160 ? String.fromCharCode(c) : high[c - (win || mac ? 128 : 160)];
    return t && t !== '_' ? t : '';
  });
}

// ---------------------------------------------------------------------------------------------
// Base-14 widths for fonts that lack /Widths: printable ASCII, (width / 10 + 22) per character, for
// Helvetica, Helvetica-Bold, Times-Roman and Times-Bold.

const WIDTHS = [
  '229NNoY)77=P2722NNNNNNNNNN22PPPN{YY^^YSd^2HYNi^dYd^YS^YtYYS222EN7NNHNN2NN,,H,iNNNN7H2NH^HHH707P',
  '27ENNo^.77=P2722NNNNNNNNNN77PPPSx^^^^YSd^2N^Si^dYd^YS^YtYYS727PN7NSNSN7SS22N2oSSSS=N7SNdNNH=2=P',
  '/7?HHid(77HN/7/2HHHHHHHHHH22NNNBr^YY^SN^^7=^So^^N^YNS^^t^^S727EH7BHBHB7HH22H2dHHHH7=2HH^HHBF*FL',
  '/7NHHzi277HO/7/2HHHHHHHHHH77OOOHs^Y^^YSdd=HdYt^dSd^NY^^z^^Y727PH7HNBNB7HN27N2iNHNNB=7NH^HHB=,=J',
];

/**
 * Glyph width (in 1/1000 em) by Unicode text for a non-embedded base-14 font (or a metric
 * compatible one such as Arial or Times New Roman), picked by font name. Italics use the upright
 * metrics (close enough to find word gaps).
 */
export function standardWidths(fontName: string): (text: string) => number {
  const n = fontName.toLowerCase();
  if (/courier|mono/.test(n)) return () => 600;
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const times = /times|roman|serif|georgia|garamond|book/.test(n) && !/sans/.test(n);
  const w = WIDTHS[(times ? 2 : 0) + (bold ? 1 : 0)];
  return (text) => {
    const c = text ? text.normalize('NFD').charCodeAt(0) : 32;
    return c >= 32 && c < 127 ? (w.charCodeAt(c - 32) - 22) * 10 : 556;
  };
}
