import { describe, expect, test } from 'bun:test';
import { NeedMoreData } from '../../src/core/errors.ts';
import { Lexer, T_ACLOSE, T_AOPEN, T_DCLOSE, T_DOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR, type Token } from '../../src/core/lexer.ts';
import { latin1Bytes } from './util.ts';

function tokens(src: string, final = true): Token[] {
  const lex = new Lexer(latin1Bytes(src), 0, final);
  const out: Token[] = [];
  for (;;) {
    const t = lex.next();
    if (t.t === T_EOF) return out;
    out.push(t);
  }
}

const text = (t: Token) => (t.v instanceof Uint8Array ? Buffer.from(t.v).toString('latin1') : t.v);

describe('lexer', () => {
  test('numbers', () => {
    const t = tokens('0 42 -17 +3 3.25 -.5 4. 007 --5 1.2.3');
    expect(t.map((x) => [x.t, x.v, x.int])).toEqual([
      [T_NUM, 0, true],
      [T_NUM, 42, true],
      [T_NUM, -17, true],
      [T_NUM, 3, true],
      [T_NUM, 3.25, false],
      [T_NUM, -0.5, false],
      [T_NUM, 4, false],
      [T_NUM, 7, true],
      [T_NUM, -5, true],
      [T_KW, '1.2.3', false],
    ]);
  });

  test('names with # escapes and delimiters', () => {
    const t = tokens('/Type/XObject /A#20B /#2Fslash / /x#zz');
    expect(t.map((x) => [x.t, x.v])).toEqual([
      [T_NAME, 'Type'],
      [T_NAME, 'XObject'],
      [T_NAME, 'A B'],
      [T_NAME, '/slash'],
      [T_NAME, ''],
      [T_NAME, 'x#zz'],
    ]);
  });

  test('literal strings keep raw bytes, balance parens and honour escapes', () => {
    const t = tokens('(a(b)c) (esc \\) \\( \\\\) (multi\nline) ()');
    expect(t.map(text)).toEqual(['(a(b)c)', '(esc \\) \\( \\\\)', '(multi\nline)', '()']);
    expect(t.every((x) => x.t === T_STR)).toBe(true);
  });

  test('hex strings versus dictionaries', () => {
    const t = tokens('<48 65> <<>> <</A<ff>>>');
    expect(t.map((x) => x.t)).toEqual([T_STR, T_DOPEN, T_DCLOSE, T_DOPEN, T_NAME, T_STR, T_DCLOSE]);
    expect(text(t[0])).toBe('<48 65>');
  });

  test('comments and whitespace (NUL, FF) are skipped', () => {
    const t = tokens('%comment\n1\x00\x0c2 % trailing\r3');
    expect(t.map((x) => x.v)).toEqual([1, 2, 3]);
  });

  test('arrays, keywords and token offsets', () => {
    const t = tokens('[1 0 R] true null endobj');
    expect(t.map((x) => x.t)).toEqual([T_AOPEN, T_NUM, T_NUM, T_KW, T_ACLOSE, T_KW, T_KW, T_KW]);
    expect(t.map((x) => [x.s, x.e])[3]).toEqual([5, 6]);
  });

  test('partial buffers ask for more data instead of guessing', () => {
    for (const src of ['12', '/Nam', '(open', '<ab', 'endob', '<', '>']) {
      expect(() => tokens(src, false)).toThrow(NeedMoreData);
    }
    // ...while the same input at the real end of the file is fine
    expect(tokens('12', true).map((x) => x.v)).toEqual([12]);
    expect(tokens('(open', true).map(text)).toEqual(['(open']);
  });

  test('a token followed by a delimiter is complete even in a partial buffer', () => {
    const lex = new Lexer(latin1Bytes('12 0 obj<<'), 0, false);
    expect([lex.next().v, lex.next().v, lex.next().v]).toEqual([12, 0, 'obj']);
    expect(lex.next().t).toBe(T_DOPEN);
    expect(() => lex.next()).toThrow(NeedMoreData);
  });
});
