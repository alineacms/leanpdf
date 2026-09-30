import { numOf, PdfDict } from '../core/objects.ts';
import { walkPages } from '../core/pages.ts';
import type { Plugin } from '../core/rewrite.ts';
import { plain, setEntry } from './unused.ts';

/** Normalize a multiple of 90 to 0, 90, 180 or 270. */
const normalize = (r: number): number => ((r % 360) + 360) % 360;

const check = (r: number): number => {
  if (!Number.isInteger(r) || r % 90 !== 0) throw new RangeError(`Page rotation must be a multiple of 90, got ${r}`);
  return normalize(r);
};

/**
 * Rewrite plugin that rotates pages (the /Rotate entry: how viewers turn the page when showing
 * or printing it; the content is untouched).
 *
 * - A number rotates every page by that many degrees clockwise, on top of its current rotation:
 *   `rotatePages(90)` turns portrait pages into landscape and landscape pages back.
 * - A function gets each page's 0-based index in the input and its current rotation (0, 90, 180
 *   or 270) and returns the page's new absolute rotation; return `current` to leave a page alone.
 *
 * Rotations must be multiples of 90 (a RangeError otherwise) and are normalized to 0-270. Every
 * changed page gets its own /Rotate, so a value inherited from the page tree cannot interfere.
 * Encrypted input is rejected (PdfEncryptedError).
 */
export function rotatePages(rotation: number | ((pageIndex: number, currentRotate: number) => number)): Plugin {
  const by = typeof rotation === 'number' ? check(rotation) : 0;
  const target = typeof rotation === 'function' ? rotation : (_: number, cur: number) => cur + by;
  return {
    setup: plain,
    async prepare(ctx) {
      for await (const p of walkPages(ctx.doc)) {
        // Another plugin may already have set this page's rotation.
        const d = p.num ? await ctx.getObject(p.num) : undefined;
        const own = d instanceof PdfDict ? numOf(await ctx.doc.resolve(d.get('Rotate'))) : undefined;
        const cur = own === undefined ? p.rotate : normalize(Math.round(own / 90) * 90);
        const next = check(target(p.index, cur));
        if (next === cur && (own === undefined || own === next)) continue;
        if (!(d instanceof PdfDict)) {
          ctx.warn(`Page ${p.index + 1} is not an indirect object; its rotation was left alone`);
          continue;
        }
        setEntry(ctx, p.num, 'Rotate', next);
      }
    },
  };
}
