/** Fit (w, h) inside (maxW, maxH), keeping the aspect ratio and never enlarging. */
export function fitInside(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const s = Math.min(1, maxW / w, maxH / h);
  return s >= 1 ? [w, h] : [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/**
 * Area-averaging downscaler for 8-bit single-channel images, fed one source row at a time. It
 * keeps two rows of accumulators, so a mask of any size shrinks in O(output width) memory. Each
 * output pixel is the exact area-weighted mean of the source pixels it covers.
 */
export class GrayDownscaler {
  private readonly w: number;
  private readonly h: number;
  private readonly ow: number;
  private readonly oh: number;
  private readonly onRow: (row: Uint8Array) => void;
  private readonly hrow: Float64Array;
  private readonly acc: Float64Array;
  private readonly out: Uint8Array;
  private y = 0;
  private oy = 0;

  constructor(w: number, h: number, ow: number, oh: number, onRow: (row: Uint8Array) => void) {
    this.w = w;
    this.h = h;
    this.ow = ow;
    this.oh = oh;
    this.onRow = onRow;
    this.hrow = new Float64Array(ow);
    this.acc = new Float64Array(ow);
    this.out = new Uint8Array(ow);
  }

  push(src: Uint8Array): void {
    const { w, h, ow, oh, hrow, acc } = this;
    if (this.y >= h) return;
    // In integer units: source column x spans [x*ow, (x+1)*ow), output column j spans [j*w, (j+1)*w).
    hrow.fill(0);
    for (let x = 0; x < w; x++) {
      const a = x * ow;
      const b = a + ow;
      const j = Math.floor(a / w);
      const edge = (j + 1) * w;
      if (b <= edge) hrow[j] += src[x] * ow;
      else {
        hrow[j] += src[x] * (edge - a);
        hrow[j + 1] += src[x] * (b - edge);
      }
    }
    // Same vertically: source row y spans [y*oh, (y+1)*oh), output row i spans [i*h, (i+1)*h).
    const a = this.y++ * oh;
    const b = a + oh;
    const edge = (this.oy + 1) * h;
    if (b < edge) {
      for (let j = 0; j < ow; j++) acc[j] += hrow[j] * oh;
      return;
    }
    for (let j = 0; j < ow; j++) acc[j] += hrow[j] * (edge - a);
    this.emit();
    if (b > edge) for (let j = 0; j < ow; j++) acc[j] = hrow[j] * (b - edge);
  }

  private emit(): void {
    const norm = 1 / (this.w * this.h);
    for (let j = 0; j < this.ow; j++) this.out[j] = Math.min(255, Math.round(this.acc[j] * norm));
    this.acc.fill(0);
    this.oy++;
    this.onRow(this.out);
  }
}
