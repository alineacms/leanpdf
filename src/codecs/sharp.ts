import sharp from 'sharp';
import type { ImageCodec, ImageInput, ImageOutput, RecompressOptions } from '../core/types.ts';

export interface SharpImageCodecOptions {
  /** Emit progressive JPEGs (mozjpeg's default). Default false: baseline. */
  progressive?: boolean;
  /** Chroma subsampling for color output. Default '4:2:0'. */
  chromaSubsampling?: '4:2:0' | '4:4:4';
}

/**
 * Codec backed by sharp (libvips + mozjpeg) for Node and Bun. Embedded ICC profiles and EXIF
 * orientation in JPEG input are ignored, as PDF renderers do.
 */
export class SharpImageCodec implements ImageCodec {
  private readonly options: SharpImageCodecOptions;

  constructor(options: SharpImageCodecOptions = {}) {
    this.options = options;
  }

  async recompress(input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null> {
    const { data, width, height, components } = input;
    let img =
      input.kind === 'jpeg'
        ? sharp(data, { ignoreIcc: true, autoOrient: false, failOn: 'error' })
        : sharp(data, { raw: { width, height, channels: components } });
    img = img.resize({ width: opts.maxWidth, height: opts.maxHeight, fit: 'inside', withoutEnlargement: true });
    const gray = components === 1 && opts.preserveGray;
    img = img.toColourspace(gray ? 'b-w' : 'srgb');
    img = img.jpeg({
      quality: Math.max(1, Math.min(100, Math.round(opts.jpegQuality * 100))),
      mozjpeg: true,
      chromaSubsampling: this.options.chromaSubsampling ?? '4:2:0',
    });
    // mozjpeg turns on progressive scans; switch back to baseline unless asked not to.
    if (!this.options.progressive) img = img.jpeg({ progressive: false, optimiseScans: false });
    const { data: out, info } = await img.toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
      width: info.width,
      height: info.height,
      components: info.channels === 1 ? 1 : 3,
    };
  }
}
