/**
 * The standard password security handler (ISO 32000-2 7.6.4): parses /Encrypt, authenticates a
 * user or owner password (R2-R6), and hands out per-object decryptors for the crypt filters.
 */
import { concat, EMPTY } from '../core/bytes.ts';
import type { PdfDocument } from '../core/document.ts';
import { PdfEncryptedError, PdfFormatError } from '../core/errors.ts';
import { intOf, nameOf, PdfDict, PdfString, type PdfObj } from '../core/objects.ts';
import { stringBytes } from '../core/strings.ts';
import { aesKey, cbcDecrypt, cbcEncrypt, sha } from './crypto-aes.ts';
import { md5 } from './crypto-md5.ts';
import { rc4 } from './crypto-rc4.ts';

/** Ciphers a crypt filter can name. */
export const NONE = 0;
export const RC4 = 1;
export const AESV2 = 2;
export const AESV3 = 3;

/**
 * Decrypts one string or stream, chunk by chunk: pass `last` with the final chunk (possibly
 * empty). Chunks may have any size; AES output lags by up to one block.
 */
export type Decrypt = (chunk: Uint8Array, last: boolean) => Promise<Uint8Array>;

export interface Security {
  /** Which password matched. */
  password: 'user' | 'owner';
  /** Human readable, e.g. "AES-256 (R6)". */
  method: string;
  /** Ciphers for strings, streams and embedded files. */
  str: number;
  stm: number;
  eff: number;
  /** Metadata streams are encrypted (false only with /EncryptMetadata false, V4+). */
  meta: boolean;
  /** Cipher of a named crypt filter (for /Crypt stream filters); undefined when unknown. */
  filter(name: string): number | undefined;
  /** A fresh decryptor for data of object `num`/`gen` encrypted with `cipher`. */
  decryptor(cipher: number, num: number, gen: number): Decrypt;
}

/** An encryption we recognize but cannot decrypt. Still a PdfEncryptedError, with details. */
class Unsupported extends PdfEncryptedError {
  constructor(message: string) {
    super();
    this.message = message;
  }
}

const malformed = (what: string): PdfFormatError => new PdfFormatError(`Malformed /Encrypt dictionary: ${what}`);

/** The password padding string of Algorithm 2. */
const PAD = /* @__PURE__ */ Uint8Array.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a'.match(/../g)!,
  (h) => parseInt(h, 16),
);

function pad32(pw: Uint8Array): Uint8Array {
  const b = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  b.set(pw.subarray(0, n));
  b.set(PAD.subarray(0, 32 - n), n);
  return b;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** AES-CBC with the IV in the first 16 bytes; the last block is held back until `last`. */
function aesDecryptor(getKey: () => Promise<CryptoKey>): Decrypt {
  let iv: Uint8Array | undefined;
  let pend: Uint8Array = EMPTY;
  let key: Promise<CryptoKey> | undefined;
  return async (chunk, last) => {
    let b = pend.length ? concat([pend, chunk]) : chunk;
    pend = EMPTY;
    if (!iv) {
      if (b.length < 16) {
        if (!last) pend = b.slice();
        return EMPTY;
      }
      iv = b.slice(0, 16);
      b = b.subarray(16);
    }
    let n = b.length - (b.length % 16);
    if (!last && n) n -= 16;
    if (!last) pend = b.slice(n);
    if (!n) return EMPTY;
    const ct = b.subarray(0, n);
    const out = await cbcDecrypt(await (key ??= getKey()), iv, ct, last);
    iv = ct.slice(n - 16);
    return out;
  };
}

/** Algorithm 2.B (R6): iterated SHA-256/384/512 over AES-128-CBC. */
async function hash2B(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha('SHA-256', concat([pw, salt, udata]));
  for (let i = 0, last = 0; i < 64 || last > i - 32; i++) {
    const unit = concat([pw, k, udata]);
    const k1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) k1.set(unit, j * unit.length);
    const e = await cbcEncrypt(await aesKey(k.subarray(0, 16)), k.subarray(16, 32), k1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = await sha(sum % 3 === 0 ? 'SHA-256' : sum % 3 === 1 ? 'SHA-384' : 'SHA-512', e);
    last = e[e.length - 1];
  }
  return k.subarray(0, 32);
}

/**
 * Authenticate `password` against the document's standard security handler. Returns null when
 * it matches neither the user nor the owner password. Throws PdfFormatError for a malformed
 * /Encrypt dictionary and PdfEncryptedError for handlers or ciphers we don't support.
 */
export async function authenticate(doc: PdfDocument, password: string): Promise<Security | null> {
  if (doc.trailer.get('Encrypt') === undefined) throw new PdfFormatError('The document is not encrypted');
  const enc = await doc.resolve(doc.trailer.get('Encrypt'));
  if (!(enc instanceof PdfDict)) throw malformed('not a dictionary');
  const get = (k: string, d: PdfDict = enc): Promise<PdfObj | undefined> => doc.resolve(d.get(k));
  const bytes = async (k: string): Promise<Uint8Array | undefined> => {
    const s = await get(k);
    return s instanceof PdfString ? stringBytes(s) : undefined;
  };
  const handler = nameOf(await get('Filter'));
  if (handler !== 'Standard') {
    throw new Unsupported(`Unsupported security handler /${handler ?? '?'}: only password encryption (/Standard) can be decrypted`);
  }
  const v = intOf(await get('V')) ?? 0;
  const r = intOf(await get('R')) ?? 0;
  if (![1, 2, 4, 5].includes(v) || r < 2 || r > 6 || (v === 5) !== (r >= 5)) throw new Unsupported(`Unsupported encryption: /V ${v} /R ${r}`);
  const o = await bytes('O');
  const u = await bytes('U');
  const need = r >= 5 ? 48 : 32;
  if (!o || !u || o.length < need || u.length < need) throw malformed('/O or /U is missing or too short');
  const p = intOf(await get('P'));
  if (p === undefined && r < 5) throw malformed('/P is missing');
  const encMeta = (await get('EncryptMetadata')) !== false;

  // Crypt filters (V4+): name -> cipher, -1 when the method is unsupported.
  const cf = await get('CF');
  const filters = new Map<string, number>();
  if (v >= 4 && cf instanceof PdfDict) {
    for (const name of cf.map.keys()) {
      const f = await get(name, cf);
      if (!(f instanceof PdfDict)) continue;
      const cfm = nameOf(await get('CFM', f));
      filters.set(name, cfm === 'V2' ? RC4 : cfm === 'AESV2' ? AESV2 : cfm === 'AESV3' ? AESV3 : cfm === undefined || cfm === 'None' ? NONE : -1);
    }
  }
  filters.set('Identity', NONE);
  const pick = async (key: string, def: number): Promise<number> => {
    if (v < 4) return RC4;
    const name = nameOf(await get(key));
    if (name === undefined) return def;
    const c = filters.get(name);
    if (c === undefined) throw malformed(`/${key} names an undefined crypt filter /${name}`);
    if (c < 0) throw new Unsupported(`Unsupported crypt filter method in /${name}`);
    return c;
  };
  const stm = await pick('StmF', NONE);
  const str = await pick('StrF', NONE);
  const eff = await pick('EFF', stm);

  // Key length in bits. V4 gives it in the stream crypt filter (default 128), which some
  // producers write in bytes: read values below 40 as bytes, as pdf.js does.
  let bits = v === 1 ? 40 : v === 5 ? 256 : (intOf(await get('Length')) ?? 40);
  if (v === 4) {
    const sf = cf instanceof PdfDict ? await get(nameOf(await get('StmF')) ?? 'StdCF', cf) : undefined;
    const len = (sf instanceof PdfDict ? intOf(await get('Length', sf)) : undefined) ?? 128;
    bits = Math.min(128, Math.max(40, len < 40 ? len * 8 : len));
  }
  if (v === 2 && (bits % 8 || bits < 40 || bits > 128)) throw malformed(`invalid key length ${bits}`);

  const ids = await doc.resolve(doc.trailer.get('ID'));
  const id0 = Array.isArray(ids) ? await doc.resolve(ids[0]) : undefined;
  const id = id0 instanceof PdfString ? stringBytes(id0) : EMPTY;

  const utf8 = new TextEncoder().encode(password);
  let key: Uint8Array | undefined;
  let who: 'user' | 'owner' = 'user';

  if (r >= 5) {
    // Algorithms 2.A / 11 / 12: SHA-256 (R5) or 2.B (R6); the file key is wrapped in /UE, /OE.
    const h = r === 5 ? (a: Uint8Array, b: Uint8Array, c: Uint8Array) => sha('SHA-256', concat([a, b, c])) : hash2B;
    const pw = utf8.subarray(0, 127);
    const u48 = u.subarray(0, 48);
    const unwrap = async (k: Uint8Array, e: Uint8Array | undefined): Promise<Uint8Array> => {
      if (!e || e.length < 32) throw malformed('/UE or /OE is missing or too short');
      return cbcDecrypt(await aesKey(k), new Uint8Array(16), e.subarray(0, 32));
    };
    if (equal(await h(pw, u.subarray(32, 40), EMPTY), u.subarray(0, 32))) {
      key = await unwrap(await h(pw, u.subarray(40, 48), EMPTY), await bytes('UE'));
    } else if (equal(await h(pw, o.subarray(32, 40), u48), o.subarray(0, 32))) {
      key = await unwrap(await h(pw, o.subarray(40, 48), u48), await bytes('OE'));
      who = 'owner';
    }
  } else {
    // Algorithms 2, 4-7 (RC4 based). Passwords are PDFDocEncoding; try Latin-1, then UTF-8.
    const n = r === 2 ? 5 : bits >> 3;
    const o32 = o.subarray(0, 32);
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setInt32(0, p!, true);
    const cands = /[^\0-\x7f]/.test(password) ? [utf8] : [];
    if (/^[\0-\xff]*$/.test(password)) cands.unshift(Uint8Array.from(password, (c) => c.charCodeAt(0)));
    const fileKey = (pw32: Uint8Array): Uint8Array => {
      let h = md5(concat([pw32, o32, pBytes, id, r >= 4 && !encMeta ? new Uint8Array(4).fill(255) : EMPTY]));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      return h.subarray(0, n);
    };
    const userKey = (pw32: Uint8Array): Uint8Array | undefined => {
      const k = fileKey(pw32);
      if (r === 2) return equal(rc4(k)(PAD), u.subarray(0, 32)) ? k : undefined;
      let x = rc4(k)(md5(concat([PAD, id])));
      for (let i = 1; i <= 19; i++) x = rc4(k.map((b) => b ^ i))(x);
      return equal(x, u.subarray(0, 16)) ? k : undefined;
    };
    for (const pw of cands) if ((key = userKey(pad32(pw)))) break;
    for (let c = 0; !key && c < cands.length; c++) {
      // Algorithm 7: the owner password decrypts /O into the user password.
      let h = md5(pad32(cands[c]));
      if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
      const ok = h.subarray(0, n);
      let x = o32;
      if (r === 2) x = rc4(ok)(x);
      else for (let i = 19; i >= 0; i--) x = rc4(ok.map((b) => b ^ i))(x);
      if ((key = userKey(x))) who = 'owner';
    }
  }
  if (!key) return null;
  const fk = key;

  let aes256: Promise<CryptoKey> | undefined;
  let last: { id: string; key: Promise<CryptoKey> } | undefined;
  /** Algorithm 1: the per-object key. */
  const objKey = (num: number, gen: number, aes: boolean): Uint8Array => {
    const l = fk.length;
    const b = new Uint8Array(l + (aes ? 9 : 5));
    b.set(fk);
    b.set([num, num >> 8, num >> 16, gen, gen >> 8], l);
    if (aes) b.set([0x73, 0x41, 0x6c, 0x54], l + 5); // "sAlT"
    return md5(b).subarray(0, Math.min(l + 5, 16));
  };
  const names = ['no encryption', `RC4 ${bits}-bit`, 'AES-128', 'AES-256'];
  return {
    password: who,
    method: `${names[Math.max(stm, str)]} (R${r})`,
    str,
    stm,
    eff,
    meta: v < 4 || encMeta,
    filter(name) {
      const c = filters.get(name);
      return c === undefined || c < 0 ? undefined : c;
    },
    decryptor(cipher, num, gen) {
      if (cipher === RC4) {
        const f = rc4(objKey(num, gen, false));
        return async (c) => f(c);
      }
      if (cipher === AESV3) return aesDecryptor(() => (aes256 ??= aesKey(fk)));
      if (cipher === AESV2) {
        // One cached key: an object's strings and data are decrypted one after another.
        const id = `${num} ${gen}`;
        return aesDecryptor(() => (last?.id === id ? last.key : (last = { id, key: aesKey(objKey(num, gen, true)) }).key));
      }
      return async (c) => c;
    },
  };
}
