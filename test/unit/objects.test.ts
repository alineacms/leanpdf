import { describe, expect, test } from 'bun:test';
import { NeedMoreData, PdfSyntaxError } from '../../src/core/errors.ts';
import { Lexer } from '../../src/core/lexer.ts';
import { encodeName, PdfDict, PdfName, PdfRef, PdfString, Parser, type PdfObj } from '../../src/core/objects.ts';
import { parseObjectHeader } from '../../src/core/objread.ts';
import { latin1Bytes } from './util.ts';

const parse = (src: string, final = true): PdfObj => new Parser(new Lexer(latin1Bytes(src), 0, final)).parse();
const raw = (d: PdfDict, k: string) => Buffer.from(d.raw.get(k)!).toString('latin1');

describe('object parser', () => {
  test('scalars, refs and arrays', () => {
    expect(parse('[1 2 0 R 3 /N (s) true false null 4.5]')).toEqual([
      1,
      new PdfRef(2, 0),
      3,
      new PdfName('N'),
      new PdfString(latin1Bytes('(s)')),
      true,
      false,
      null,
      4.5,
    ]);
    expect(parse('[1 2]')).toEqual([1, 2]);
    expect(parse('[-1 0 R]')).toEqual([-1, 0, null]);
  });

  test('dictionaries keep raw value bytes in order', () => {
    const d = parse('<< /Type /XObject /Length 12 0 R /Arr [ 1  2 ] /Str (a b) /Sub << /K 1 >> >>') as PdfDict;
    expect([...d.map.keys()]).toEqual(['Type', 'Length', 'Arr', 'Str', 'Sub']);
    expect(d.get('Length')).toEqual(new PdfRef(12, 0));
    expect(raw(d, 'Arr')).toBe('[ 1  2 ]');
    expect(raw(d, 'Length')).toBe('12 0 R');
    expect(raw(d, 'Sub')).toBe('<< /K 1 >>');
    expect(d.dup).toBe(false);
  });

  test('tolerates missing values and stray tokens; flags duplicate keys', () => {
    const d = parse('<< /A /B 1 2 /C >>') as PdfDict;
    expect(d.get('A')).toEqual(new PdfName('B'));
    expect(d.get('C')).toBe(null);
    expect((parse('<< /K 1 /K 2 >>') as PdfDict).dup).toBe(true);
  });

  test('structural keywords inside values are errors, not silently swallowed', () => {
    expect(() => parse('<< /A 1 endobj')).toThrow(PdfSyntaxError);
    expect(() => parse('[1 2')).toThrow(PdfSyntaxError);
    expect(() => parse('<< /A [1 2 >>')).toThrow(PdfSyntaxError);
  });

  test('deep nesting is bounded', () => {
    expect(() => parse('['.repeat(5000))).toThrow(PdfSyntaxError);
  });

  test('partial windows ask for more data', () => {
    expect(() => parse('<< /Length 12 0', false)).toThrow(NeedMoreData);
    expect(() => parse('[1 2 0', false)).toThrow(NeedMoreData);
  });

  test('encodeName escapes delimiters, whitespace and #', () => {
    expect(encodeName('Type')).toBe('/Type');
    expect(encodeName('A B#(x)')).toBe('/A#20B#23#28x#29');
  });
});

describe('object headers', () => {
  test('stream header: data starts after the EOL', () => {
    for (const eol of ['\n', '\r\n']) {
      const src = `7 0 obj\n<< /Length 3 >>\nstream${eol}abc\nendstream\nendobj\n`;
      const h = parseObjectHeader(latin1Bytes(src), 100, true);
      expect(h.num).toBe(7);
      expect(h.stream).toBe(true);
      expect(h.dataStart - 100).toBe(src.indexOf('abc'));
    }
  });

  test('non-stream object reports where endobj ends, or that it is missing', () => {
    const h = parseObjectHeader(latin1Bytes('  3 1 obj [1 2] endobj\n'), 0, true);
    expect([h.num, h.gen, h.offset, h.stream]).toEqual([3, 1, 2, false]);
    expect(h.endobj).toBe('  3 1 obj [1 2] endobj'.length);
    const m = parseObjectHeader(latin1Bytes('3 0 obj 42\n4 0 obj'), 0, true);
    expect(m.value).toBe(42);
    expect(m.endobj).toBe(-1);
    expect(m.valueEnd).toBe(10);
  });

  test('empty object body is null', () => {
    expect(parseObjectHeader(latin1Bytes('5 0 obj endobj'), 0, true).value).toBe(null);
  });

  test('rejects things that are not objects', () => {
    expect(() => parseObjectHeader(latin1Bytes('xref 0 1'), 0, true)).toThrow(PdfSyntaxError);
  });
});
