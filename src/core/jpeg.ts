export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  /** Sample precision in bits. */
  precision: number;
  /** SOF marker (0xC0 baseline, 0xC1 extended, 0xC2 progressive, ...). */
  sof: number;
  /** Adobe APP14 transform flag, or -1 when there is no Adobe marker. */
  adobeTransform: number;
  /** Component ids are 'R', 'G', 'B', which some decoders take to mean "no color transform". */
  rgbIds: boolean;
}

/**
 * Read the frame header and Adobe APP14 marker of a JPEG, stopping at the first scan.
 * Returns null if the data is not a parseable JPEG.
 */
export function sniffJpeg(d: Uint8Array): JpegInfo | null {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null;
  let info: JpegInfo | null = null;
  let adobe = -1;
  let i = 2;
  while (i + 3 < d.length) {
    if (d[i] !== 0xff) return null;
    let m = d[i + 1];
    while (m === 0xff && i + 2 < d.length) m = d[++i + 1]; // fill bytes
    i += 2;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue; // standalone markers
    if (m === 0xd9 || i + 1 >= d.length) break;
    const len = (d[i] << 8) | d[i + 1];
    if (len < 2) return null;
    const seg = i + 2;
    if (m === 0xee && len >= 14 && d[seg] === 0x41 && d[seg + 1] === 0x64 && d[seg + 2] === 0x6f && d[seg + 3] === 0x62 && d[seg + 4] === 0x65) {
      adobe = d[seg + 11];
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (seg + 6 > d.length) return null;
      info = {
        precision: d[seg],
        height: (d[seg + 1] << 8) | d[seg + 2],
        width: (d[seg + 3] << 8) | d[seg + 4],
        components: d[seg + 5],
        sof: m,
        adobeTransform: -1,
        rgbIds: d[seg + 5] === 3 && d[seg + 6] === 0x52 && d[seg + 9] === 0x47 && d[seg + 12] === 0x42,
      };
    } else if (m === 0xda) {
      break;
    }
    i += len;
  }
  if (info) info.adobeTransform = adobe;
  return info;
}
