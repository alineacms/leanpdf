/**
 * RC4 as a stateful keystream: each call continues where the previous one stopped, so a stream
 * can be decrypted chunk by chunk. Input is never modified.
 */
export function rc4(key: Uint8Array): (data: Uint8Array) => Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  let i = 0;
  let j = 0;
  return (data) => {
    const out = new Uint8Array(data.length);
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      const si = s[i];
      j = (j + si) & 255;
      const sj = s[j];
      s[i] = sj;
      s[j] = si;
      out[k] = data[k] ^ s[(si + sj) & 255];
    }
    return out;
  };
}
