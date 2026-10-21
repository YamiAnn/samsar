import { describe, expect, it } from 'vitest';
import { frameToViewportValue, getViewportGeometryFrameRange, viewportValueToFrame } from '../../src/components/video/util/viewportGeometry.js';

const geometry = {
  totalPixels: 300,
  segments: [
    { frameStart: 30, frameEnd: 90, pixelStart: 0, pixelEnd: 100 },
    { frameStart: 90, frameEnd: 120, pixelStart: 100, pixelEnd: 300 },
  ],
};

describe('timeline viewport geometry', () => {
  it.each([
    [undefined, [0, 1]],
    [{ segments: null, frameStart: '10.4', frameEnd: '20.8' }, [10, 21]],
    [{ frameStart: 5, frameEnd: 3 }, [5, 6]],
    [{ segments: [{ frameStart: 8.6, frameEnd: 10 }, { frameEnd: 40.2 }] }, [9, 40]],
    [{ segments: [{}] }, [0, 1]],
  ])('derives a nonempty frame range for %j', (input, expected) => {
    expect(getViewportGeometryFrameRange(input)).toEqual(expected);
  });

  it.each([
    [-10, 0], [30, 0], [60, 50], [90, 100], [105, 200], [120, 300], [200, 300], ['105', 200], [NaN, 0],
  ])('maps frame %s to pixel %s across scene widths', (frame, pixels) => {
    expect(frameToViewportValue(frame, geometry)).toBeCloseTo(pixels);
  });

  it.each([
    [-10, 30], [0, 30], [50, 60], [100, 90], [200, 105], [300, 120], [400, 120], ['200', 105], [NaN, 30],
  ])('maps pixel %s to frame %s across scene widths', (pixels, frame) => {
    expect(viewportValueToFrame(pixels, geometry)).toBeCloseTo(frame);
  });

  it('round trips native frames through a nonuniform viewport without drift', () => {
    for (let frame = 30; frame <= 120; frame += 0.5) {
      expect(viewportValueToFrame(frameToViewportValue(frame, geometry), geometry)).toBeCloseTo(frame, 10);
    }
  });

  it('snaps values in a discontinuity to the next scene start', () => {
    const gaps = { totalPixels: 120, segments: [
      { frameStart: 0, frameEnd: 30, pixelStart: 0, pixelEnd: 40 },
      { frameStart: 60, frameEnd: 90, pixelStart: 80, pixelEnd: 120 },
    ] };
    expect(frameToViewportValue(45, gaps)).toBe(80);
    expect(viewportValueToFrame(60, gaps)).toBe(60);
  });

  it('handles missing and collapsed segment coordinates without returning NaN', () => {
    const collapsed = { totalPixels: 20, segments: [{}, { frameStart: 10, frameEnd: 10, pixelStart: 5, pixelEnd: 2 }] };
    expect(frameToViewportValue(0, collapsed)).toBe(0);
    expect(frameToViewportValue(5, collapsed)).toBe(5);
    expect(frameToViewportValue(11, collapsed)).toBe(5);
    expect(viewportValueToFrame(3, collapsed)).toBe(10);
    expect(viewportValueToFrame(20, collapsed)).toBe(10);
  });

  it('scales pixel positions in a fallback geometry without segments', () => {
    const fallback = { frameStart: 30, frameEnd: 90, totalPixels: 120 };
    expect(viewportValueToFrame(60, fallback)).toBe(60);
    expect(viewportValueToFrame(120, fallback)).toBe(90);
  });

  it('round trips frames in a fallback geometry with a different pixel scale', () => {
    const fallback = { frameStart: 30, frameEnd: 90, totalPixels: 120 };
    expect(frameToViewportValue(60, fallback)).toBe(60);
    expect(viewportValueToFrame(frameToViewportValue(60, fallback), fallback)).toBe(60);
  });

  it('supports a default one-frame fallback and clamps its endpoints', () => {
    expect(frameToViewportValue(20)).toBe(1);
    expect(frameToViewportValue(-20)).toBe(0);
    expect(viewportValueToFrame(0)).toBe(0);
    expect(viewportValueToFrame(20)).toBe(1);
  });
});
