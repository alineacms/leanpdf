import { describe, expect, test } from 'bun:test';
import { ImageCache, type CachedImage, type LoadedImage } from '../../src/render/image.ts';

const image = (w: number, h: number) => ({ source: { width: w, height: h }, stencil: false, interpolate: false }) as unknown as LoadedImage;
const entry = (img: Promise<LoadedImage | null>): CachedImage => ({ img, w: 10, h: 10, warnings: [] });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ImageCache', () => {
  test('shares a load while it runs', async () => {
    const cache = new ImageCache();
    let done!: (v: LoadedImage) => void;
    const e = entry(new Promise((r) => (done = r)));
    cache.set(1, e);
    expect(cache.get(1)).toBe(e);
    done(image(4, 4));
    expect((await cache.get(1)!.img)?.source.width).toBe(4);
  });

  test('forgets failed loads', async () => {
    const cache = new ImageCache();
    const e = entry(Promise.reject(new Error('read failed')));
    cache.set(1, e);
    await expect(e.img).rejects.toThrow('read failed');
    await tick();
    expect(cache.get(1)).toBeUndefined();
  });

  test('evicts the least recently used past its pixel budget, counting decoded images only', async () => {
    const cache = new ImageCache(250);
    cache.set(1, entry(Promise.resolve(image(10, 10))));
    cache.set(2, entry(Promise.resolve(image(10, 10))));
    await tick();
    cache.get(1);
    cache.set(3, entry(Promise.resolve(image(10, 10))));
    await tick();
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBeDefined();
    expect(cache.get(3)).toBeDefined();
    // A load still running holds no pixels yet.
    cache.set(4, entry(new Promise(() => {})));
    expect(cache.get(1)).toBeDefined();
  });
});
