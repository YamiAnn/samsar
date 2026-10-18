import test from 'node:test';
import assert from 'node:assert/strict';
import { secondsToFrameCount, frameCountToSeconds, getLayerFrameRange } from './FrameClock.js';

for (const fps of [16, 24, 30]) {
  test(`P2P ${fps} fps: frame counts survive 1000 duration round trips`, () => {
    for (const count of [1, 7, 31, 127, 10001]) {
      let duration = frameCountToSeconds(count, fps);
      for (let stage = 0; stage < 1000; stage += 1) {
        assert.equal(secondsToFrameCount(duration, fps), count);
        duration = frameCountToSeconds(secondsToFrameCount(duration, fps), fps);
      }
    }
  });
  test(`P2P ${fps} fps: fractional scene boundaries share an integer frame budget`, () => {
    let offset = 0;
    let frameCount = 0;
    for (let scene = 0; scene < 137; scene += 1) {
      const duration = 1.37;
      const range = getLayerFrameRange({ durationOffset: offset, duration }, fps);
      assert.equal(range.startFrame, frameCount);
      frameCount += range.frameCount;
      offset += duration;
    }
    assert.equal(frameCount, secondsToFrameCount(offset, fps));
  });
}
test('P2P invalid and zero durations never request negative frames', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 0]) {
    assert.equal(secondsToFrameCount(value, 24), 0);
  }
  assert.equal(frameCountToSeconds(5, 0), 0);
  assert.equal(getLayerFrameRange({duration: 0}, 24).frameCount, 0);
});
