import { describe, expect, it, vi } from 'vitest';

const konva = vi.hoisted(() => ({ Filters: {} }));
vi.mock('konva', () => ({ default: konva }));

import { applyBloomEffect } from '../../src/utils/frame_animation/BloomUtils.jsx';
import { applyGlitchEffect } from '../../src/utils/frame_animation/GlitchUtils.jsx';

function makeImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data.set([pixel + 1, pixel + 2, pixel + 3, 100 + pixel], pixel * 4);
  }
  return { width, height, data };
}

describe('canvas image filter pixel math', () => {
  it('blooms only pixels above the brightness threshold, clamps RGB, and preserves alpha', () => {
    const image = {
      data: new Uint8ClampedArray([
        200, 200, 200, 99,
        201, 210, 255, 42,
        255, 100, 0, 77,
        0, 0, 0, 0,
      ]),
    };
    konva.Filters.CustomBloom(image);
    expect(Array.from(image.data)).toEqual([
      200, 200, 200, 99,
      241, 252, 255, 42,
      255, 100, 0, 77,
      0, 0, 0, 0,
    ]);
  });

  it('accepts an empty image', () => {
    const image = makeImage(0, 0);
    expect(() => konva.Filters.CustomBloom(image)).not.toThrow();
    expect(() => konva.Filters.CustomGlitch(image)).not.toThrow();
    expect(image.data).toHaveLength(0);
  });

  it('leaves every pixel unchanged when no horizontal slice is selected', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const image = makeImage(12, 11);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    expect(image.data).toEqual(before);
    expect(Math.random).toHaveBeenCalledTimes(3);
  });

  it('ignores shifts wholly outside the canvas', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValueOnce(0);
    const image = makeImage(3, 1);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    expect(image.data).toEqual(before);
  });

  it('copies RGBA channels together when a row shifts left', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValueOnce(0.25);
    const image = makeImage(6, 1);
    const lastPixel = Array.from(image.data.slice(20, 24));
    konva.Filters.CustomGlitch(image);
    expect(Array.from(image.data.slice(0, 4))).toEqual(lastPixel);
  });

  it('shifts every row of the selected five-pixel horizontal slice', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValueOnce(0.25);
    const image = makeImage(6, 5);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    for (let row = 0; row < 5; row += 1) {
      const destination = row * 6 * 4;
      const source = (row * 6 + 5) * 4;
      expect(Array.from(image.data.slice(destination, destination + 4)))
        .toEqual(Array.from(before.slice(source, source + 4)));
    }
  });

  it('uses original source pixels when shifting right over overlapping destinations', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValueOnce(0.75);
    const image = makeImage(12, 1);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    expect(Array.from(image.data.slice(10 * 4, 11 * 4)))
      .toEqual(Array.from(before.slice(5 * 4, 6 * 4)));
  });

  it('rounds random shifts to whole pixels instead of writing fractional array indices', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValueOnce(0.56);
    const image = makeImage(6, 1);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    expect(Array.from(image.data.slice(4, 8))).toEqual(Array.from(before.slice(0, 4)));
    expect(Array.from(image.data.slice(20, 24))).toEqual(Array.from(before.slice(16, 20)));
  });

  it('handles a final partial slice without modifying unselected rows or extending the image', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.01).mockReturnValueOnce(0.25);
    const image = makeImage(6, 7);
    const before = new Uint8ClampedArray(image.data);
    konva.Filters.CustomGlitch(image);
    expect(image.data).toHaveLength(before.length);
    expect(image.data.slice(0, 5 * 6 * 4)).toEqual(before.slice(0, 5 * 6 * 4));
    for (const row of [5, 6]) {
      expect(image.data.slice(row * 6 * 4, row * 6 * 4 + 4))
        .toEqual(before.slice((row * 6 + 5) * 4, (row * 6 + 6) * 4));
    }
  });
});

describe.each([
  ['bloom', applyBloomEffect, () => konva.Filters.CustomBloom],
  ['glitch', applyGlitchEffect, () => konva.Filters.CustomGlitch],
])('%s filter application', (_name, apply, getFilter) => {
  it.each([false, true])('caches only uncached nodes (cached=%s), installs filter and redraws its layer', (cached) => {
    const batchDraw = vi.fn();
    const node = { isCached: vi.fn(() => cached), cache: vi.fn(), filters: vi.fn(), getLayer: vi.fn(() => ({ batchDraw })) };
    apply(node);
    expect(node.cache).toHaveBeenCalledTimes(cached ? 0 : 1);
    expect(node.filters).toHaveBeenCalledWith([getFilter()]);
    expect(batchDraw).toHaveBeenCalledOnce();
  });
});
