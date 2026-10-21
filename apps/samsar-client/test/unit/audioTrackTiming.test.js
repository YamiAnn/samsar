import { describe, expect, it } from 'vitest';
import { getAudioTrackFrameBounds, getAudioTrackTimeBounds } from '../../src/components/video/util/audioTrackTiming.js';
import { createLayerBoundImageItem } from '../../src/components/video/util/layerBoundImageItem.js';

describe('audio source and timeline bounds', () => {
  it.each([
    [{}, { startTime: 0, endTime: 0 }],
    [null, { startTime: 0, endTime: 0 }],
    [{ startTime: '2', endTime: '12', duration: '8', originalDuration: '4' }, { startTime: 2, endTime: 6 }],
    [{ startTime: 2, endTime: 5, duration: 8, originalDuration: 10 }, { startTime: 2, endTime: 5 }],
    [{ startTime: 2, duration: 3 }, { startTime: 2, endTime: 5 }],
    [{ startTime: 2, originalDuration: 4 }, { startTime: 2, endTime: 6 }],
    [{ startTime: 'bad', endTime: Infinity, duration: -1, originalDuration: 0 }, { startTime: 0, endTime: 0 }],
    [{ startTime: 3, endTime: 2, duration: 0 }, { startTime: 3, endTime: 3 }],
    [{ startTime: -2, duration: 3 }, { startTime: -2, endTime: 1 }],
  ])('resolves source-safe bounds for %j', (track, expected) => {
    expect(getAudioTrackTimeBounds(track)).toEqual(expected);
  });

  it.each(['loop', 'isLooped', 'loopOverEntireSession'])('allows an explicit looped end beyond the source with %s', (flag) => {
    expect(getAudioTrackTimeBounds({ startTime: 1, endTime: 20, duration: 2, [flag]: true }))
      .toEqual({ startTime: 1, endTime: 20 });
    expect(getAudioTrackTimeBounds({ startTime: 1, duration: 2, [flag]: true }))
      .toEqual({ startTime: 1, endTime: 3 });
  });

  it.each([16, 24, 30, 60, '24'])('converts seconds using the requested %s fps without rounding away subframes', (fps) => {
    expect(getAudioTrackFrameBounds({ startTime: 0.125, duration: 0.25 }, fps))
      .toEqual({ startFrame: 0.125 * Number(fps), endFrame: 0.375 * Number(fps) });
  });

  it.each([undefined, 0, '', NaN])('falls back to 30 fps for an absent or unusable rate %j', (fps) => {
    expect(getAudioTrackFrameBounds({ startTime: 1, duration: 2 }, fps))
      .toEqual({ startFrame: 30, endFrame: 90 });
  });
});

describe('image placement on the native timeline', () => {
  it('preserves item metadata and config while binding an image to its scene', () => {
    const config = { crop: 'contain' };
    const item = createLayerBoundImageItem({ layer: { durationOffset: 2, duration: 3 }, id: 'asset', type: 'text', config });
    expect(item).toEqual({ id: 'asset', type: 'image', startFrame: 60, endFrame: 150, startTime: 2, endTime: 5,
      config: { crop: 'contain', frameRate: 30, frameOffset: 0, frameDuration: 90 } });
    expect(config).toEqual({ crop: 'contain' });
  });

  it.each([16, 24, 30, 60])('keeps fractional scene offsets aligned to rounded endpoint differences at %s fps', (fps) => {
    const item = createLayerBoundImageItem({ layer: { durationOffset: 1.09, duration: 0.19 }, framesPerSecond: fps });
    const start = Math.round(1.09 * fps);
    const end = Math.round(1.28 * fps);
    expect(item.startFrame).toBe(start);
    expect(item.endFrame).toBe(end);
    expect(item.config.frameDuration).toBe(end - start);
  });

  it('converts a legacy source rate to the native frame rate using endpoints', () => {
    const item = createLayerBoundImageItem({ layer: { durationOffset: 10, duration: 3 }, framesPerSecond: 30,
      config: { framesPerSecond: 24, frameOffset: 1, frameDuration: 2 } });
    expect(item.config).toMatchObject({ frameRate: 30, frameOffset: 1, frameDuration: 3 });
  });

  it('prefers the explicit source frameRate over the legacy framesPerSecond field', () => {
    const item = createLayerBoundImageItem({ layer: {}, framesPerSecond: 30,
      config: { frameRate: 60, framesPerSecond: 24, frameOffset: 30, frameDuration: 90 } });
    expect(item.config).toMatchObject({ frameOffset: 15, frameDuration: 45 });
  });

  it('supports an explicitly trimmed item relative to a later scene', () => {
    const item = createLayerBoundImageItem({ layer: { durationOffset: 2, duration: 4 }, startFrame: 75, endFrame: 105 });
    expect(item).toMatchObject({ startFrame: 75, endFrame: 105, startTime: 2.5, endTime: 3.5,
      config: { frameOffset: 15, frameDuration: 30 } });
  });

  it('retains supplied seconds and enforces at least one frame on backwards bounds', () => {
    const item = createLayerBoundImageItem({ layer: {}, startFrame: -10, endFrame: -20, startTime: 4, endTime: 2,
      config: { frameOffset: -1, frameDuration: -4 } });
    expect(item).toMatchObject({ startFrame: 0, endFrame: 1, startTime: 4, endTime: 4 + 1 / 30,
      config: { frameOffset: 0, frameDuration: 1 } });
  });

  it.each([undefined, null, 'invalid'])('creates a one-frame image with malformed scene/config %j', (config) => {
    const item = createLayerBoundImageItem({ layer: { durationOffset: -2, duration: 'bad' }, config });
    expect(item).toMatchObject({ startFrame: 0, endFrame: 1, startTime: 0, endTime: 1 / 30,
      config: { frameRate: 30, frameOffset: 0, frameDuration: 1 } });
  });
});
