import { describe, expect, it } from 'vitest';
import {
  aspectRatioOptions,
  getCanvasDimensionsForAspectRatio,
  normalizeCanvasDimensions,
  isSupportedAspectRatioOptionValue,
  findAspectRatioOptionForCanvasDimensions,
  findClosestAspectRatioOption,
  getSimplifiedAspectRatioLabel,
  fitDimensionsToCanvas,
} from '../../src/utils/canvas.jsx';

describe('canvas aspect ratio and image fitting', () => {
  it.each([
    ['1:1', { width: 1024, height: 1024 }],
    ['16:9', { width: 1792, height: 1024 }],
    ['9:16', { width: 1024, height: 1792 }],
    [' 2:1 ', { width: 2048, height: 1024 }],
    ['1:2', { width: 1024, height: 2048 }],
    ['1.5:1', { width: 1536, height: 1024 }],
    ['1.00001:1', { width: 1024, height: 1024 }],
  ])('turns %s into codec-aligned canvas dimensions', (ratio, expected) => {
    expect(getCanvasDimensionsForAspectRatio(ratio)).toEqual(expected);
  });

  it.each([undefined, null, '', false, 1, '0:1', '1:0', '-1:2', '1/2', '16:9garbage', 'NaN:1'])
    ('falls back to a square for malformed ratio %j', (ratio) => {
      expect(getCanvasDimensionsForAspectRatio(ratio)).toEqual({ width: 1024, height: 1024 });
    });

  it('normalizes each dimension independently and rounds numeric strings', () => {
    expect(normalizeCanvasDimensions({ width: '127.6', height: -2 }, '9:16'))
      .toEqual({ width: 128, height: 1792 });
    expect(normalizeCanvasDimensions({ width: Infinity, height: '512.2' }, '16:9'))
      .toEqual({ width: 1792, height: 512 });
    expect(normalizeCanvasDimensions()).toEqual({ width: 1024, height: 1024 });
  });

  it('requires exact supported values and safely handles a missing options list', () => {
    expect(isSupportedAspectRatioOptionValue('16:9')).toBe(true);
    expect(isSupportedAspectRatioOptionValue('16:9 ', aspectRatioOptions)).toBe(false);
    expect(isSupportedAspectRatioOptionValue('1:1', null)).toBe(false);
    expect(isSupportedAspectRatioOptionValue('1:1', [null, { value: '1:1' }])).toBe(true);
  });

  it('only identifies exact canonical canvas dimensions', () => {
    expect(findAspectRatioOptionForCanvasDimensions({ width: 1792, height: 1024 }))
      .toEqual({ value: '16:9', label: '16:9' });
    expect(findAspectRatioOptionForCanvasDimensions({ width: 1920, height: 1080 })).toBeNull();
    expect(findAspectRatioOptionForCanvasDimensions(null)).toEqual({ value: '1:1', label: '1:1' });
  });

  it.each([
    [{ width: 1920, height: 1080 }, '16:9'],
    [{ width: 1080, height: 1920 }, '9:16'],
    [{ width: 1080, height: 1080 }, '1:1'],
  ])('selects the closest aspect ratio for %j', (dimensions, ratio) => {
    expect(findClosestAspectRatioOption(dimensions)?.value).toBe(ratio);
  });

  it('skips malformed ratio options and handles an empty candidate set', () => {
    expect(findClosestAspectRatioOption({ width: 100, height: 50 }, [null, { value: 'bad' }])).toBeNull();
    expect(findClosestAspectRatioOption({}, [])).toBeNull();
    expect(findClosestAspectRatioOption({}, null)).toBeNull();
    expect(findClosestAspectRatioOption({ width: 100, height: 50 }, [{ value: 'bad' }, { value: '2:1' }]))
      .toEqual({ value: '2:1' });
  });

  it('preserves first-option preference when ratios tie', () => {
    const first = { value: '2:2', label: 'first' };
    expect(findClosestAspectRatioOption({ width: 100, height: 100 }, [first, { value: '1:1' }]))
      .toBe(first);
  });

  it.each([
    [{ width: 1920, height: 1080 }, '16:9'],
    [{ width: 1080, height: 1920 }, '9:16'],
    [{ width: 17, height: 19 }, '17:19'],
    [undefined, '1:1'],
  ])('reduces dimensions %j without a hardcoded ratio list', (dimensions, label) => {
    expect(getSimplifiedAspectRatioLabel(dimensions)).toBe(label);
  });

  it.each([
    [{ width: 2000, height: 1000 }, { width: 1000, height: 1000 }, {}, { width: 1000, height: 500, x: 0, y: 250, scale: 0.5 }],
    [{ width: 1000, height: 2000 }, { width: 1000, height: 1000 }, {}, { width: 500, height: 1000, x: 250, y: 0, scale: 0.5 }],
    [{ width: 100, height: 50 }, { width: 1000, height: 1000 }, {}, { width: 100, height: 50, x: 450, y: 475, scale: 1 }],
    [{ width: 100, height: 50 }, { width: 1000, height: 1000 }, { allowUpscale: true }, { width: 1000, height: 500, x: 0, y: 250, scale: 10 }],
  ])('fits %j inside %j while respecting upscale policy', (source, canvas, options, expected) => {
    expect(fitDimensionsToCanvas(source, canvas, options)).toEqual(expected);
  });

  it('handles missing source and target sizes without nonfinite geometry', () => {
    expect(fitDimensionsToCanvas()).toEqual({ width: 1024, height: 1024, x: 0, y: 0, scale: 1 });
  });
});
