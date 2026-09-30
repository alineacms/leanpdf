import type { ImageCodec, ImageInput, ImageOutput, RecompressOptions } from '../core/types.ts';

/** Fit (w, h) inside (maxW, maxH), keeping the aspect ratio and never enlarging. */
export function fitInside(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const s = Math.min(1, maxW / w, maxH / h);
  return s >= 1 ? [w, h] : [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/**
 * Codec built on browser primitives: createImageBitmap for decoding and resizing, and
 * OffscreenCanvas.convertToBlob for JPEG encoding. Works in Web Workers. Browsers always encode
 * 3-component JPEGs, so grayscale input comes back as RGB.
 */
export class BrowserImageCodec implements ImageCodec {
  async recompress(input: ImageInput, opts: RecompressOptions): Promise<ImageOutput | null> {
    const [width, height] = fitInside(input.width, input.height, opts.maxWidth, opts.maxHeight);
    const resize: ImageBitmapOptions =
      width === input.width && height === input.height ? {} : { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' };
    const bitmapOpts: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none', ...resize };
    const source: ImageBitmapSource =
      input.kind === 'jpeg' ? new Blob([input.data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) : toImageData(input);
    const bitmap = await createImageBitmap(source, bitmapOpts);
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      if (bitmap.width === width && bitmap.height === height) {
        ctx.drawImage(bitmap, 0, 0);
      } else {
        // The browser ignored the resize options; let the canvas scale instead.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: opts.jpegQuality });
      if (blob.type !== 'image/jpeg') return null;
      return { data: new Uint8Array(await blob.arrayBuffer()), width, height, components: 3 };
    } finally {
      bitmap.close();
    }
  }
}

function toImageData(input: Extract<ImageInput, { kind: 'pixels' }>): ImageData {
  const { data, width, height, components } = input;
  const img = new ImageData(width, height);
  const out = img.data;
  const n = width * height;
  if (components === 1) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = data[i];
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0, o = 0; i < n; i++, j += 3, o += 4) {
      out[o] = data[j];
      out[o + 1] = data[j + 1];
      out[o + 2] = data[j + 2];
      out[o + 3] = 255;
    }
  }
  return img;
}
