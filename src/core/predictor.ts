import { PdfSyntaxError } from './errors.ts';

/** Undo one PNG-filtered row in place. `prev` is the previous decoded row (zeros for the first). */
export function unfilterPng(type: number, row: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = row.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) row[i] += row[i - bpp];
      return;
    case 2:
      for (let i = 0; i < n; i++) row[i] += prev[i];
      return;
    case 3:
      for (let i = 0; i < bpp && i < n; i++) row[i] += prev[i] >> 1;
      for (let i = bpp; i < n; i++) row[i] += (row[i - bpp] + prev[i]) >> 1;
      return;
    case 4:
      for (let i = 0; i < bpp && i < n; i++) row[i] += prev[i];
      for (let i = bpp; i < n; i++) {
        const a = row[i - bpp];
        const b = prev[i];
        const c = prev[i - bpp];
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        row[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      return;
    default:
      throw new PdfSyntaxError(`invalid PNG filter type ${type}`);
  }
}

/**
 * Streaming decoder for /Predictor 1 (none), 2 (TIFF, 8-bit only) and 10-15 (PNG). Feed raw
 * inflated chunks with `push`; each complete row is handed to `onRow` in a reused buffer, so the
 * callback must copy what it keeps. `onRow` may return true to stop.
 */
export class RowDecoder {
  readonly rowBytes: number;
  rows = 0;
  private readonly mode: 0 | 1 | 2; // none, tiff, png
  private readonly bpp: number;
  private readonly rowLen: number;
  private cur: Uint8Array;
  private prev: Uint8Array;
  private fill = 0;
  private readonly onRow: (row: Uint8Array) => boolean | void;

  constructor(
    predictor: number,
    colors: number,
    bpc: number,
    columns: number,
    onRow: (row: Uint8Array) => boolean | void,
  ) {
    this.mode = predictor >= 10 ? 2 : predictor === 2 ? 1 : 0;
    if (predictor !== 1 && predictor !== 2 && !(predictor >= 10 && predictor <= 15)) {
      throw new PdfSyntaxError(`unsupported predictor ${predictor}`);
    }
    if (this.mode === 1 && bpc !== 8) throw new PdfSyntaxError('TIFF predictor needs 8 bits per component');
    this.rowBytes = Math.ceil((colors * bpc * columns) / 8);
    this.bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    this.rowLen = this.rowBytes + (this.mode === 2 ? 1 : 0);
    if (!(this.rowBytes > 0)) throw new PdfSyntaxError('invalid predictor row size');
    this.cur = new Uint8Array(this.rowLen);
    this.prev = new Uint8Array(this.rowLen);
    this.onRow = onRow;
  }

  /** Returns true once `onRow` asked to stop. */
  push(chunk: Uint8Array): boolean {
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, this.rowLen - this.fill);
      this.cur.set(chunk.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.rowLen) {
        this.fill = 0;
        if (this.finishRow()) return true;
      }
    }
    return false;
  }

  private finishRow(): boolean {
    const cur = this.cur;
    let row = cur;
    if (this.mode === 2) {
      row = cur.subarray(1);
      unfilterPng(cur[0], row, this.prev.subarray(1), this.bpp);
      this.cur = this.prev;
      this.prev = cur;
    } else if (this.mode === 1) {
      for (let i = this.bpp; i < row.length; i++) row[i] += row[i - this.bpp];
    }
    this.rows++;
    return this.onRow(row) === true;
  }
}
