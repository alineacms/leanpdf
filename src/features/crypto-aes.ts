/** AES-CBC and SHA-2 through Web Crypto (browsers, workers, Node 20+, Bun). */
import { PdfError } from '../core/errors.ts';

type Buf = Uint8Array<ArrayBuffer>;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new PdfError('Decryption needs the Web Crypto API (crypto.subtle), which this runtime lacks');
  return s;
}

export const sha = async (alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle().digest(alg, data as Buf));

export const aesKey = (raw: Uint8Array): Promise<CryptoKey> =>
  subtle().importKey('raw', raw as Buf, 'AES-CBC', false, ['encrypt', 'decrypt']);

/** CBC encryption without padding; `data` must be block-aligned. */
export async function cbcEncrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Web Crypto always appends a PKCS#7 block; drop it.
  const out = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: iv as Buf }, key, data as Buf));
  return out.subarray(0, data.length);
}

/**
 * CBC decryption of block-aligned `data`, stripping PKCS#7 padding only when `unpad` is set and
 * the padding is well formed (as qpdf does). Web Crypto insists on valid padding, so the raw
 * case appends one extra block that decrypts to a full padding block: E(pad XOR last block).
 */
export async function cbcDecrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array, unpad = false): Promise<Uint8Array> {
  if (!data.length) return data;
  const alg = { name: 'AES-CBC', iv: iv as Buf };
  if (unpad) {
    try {
      return new Uint8Array(await subtle().decrypt(alg, key, data as Buf));
    } catch {
      // Malformed padding: keep every byte.
    }
  }
  const buf = new Uint8Array(data.length + 16);
  buf.set(data);
  buf.set(await cbcEncrypt(key, data.subarray(data.length - 16), new Uint8Array(16).fill(16)), data.length);
  return new Uint8Array(await subtle().decrypt(alg, key, buf));
}
