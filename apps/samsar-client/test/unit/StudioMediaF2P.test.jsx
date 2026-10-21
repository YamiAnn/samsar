import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import VideoUnderlay from '../../src/components/video/util/VideoUnderlay.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';
import PreviewPlaybackController from '../../src/components/video/PreviewPlaybackController.jsx';

let times;
beforeEach(() => {
  times = new WeakMap();
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(10);
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(function () { return times.get(this) ?? 1; });
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function (time) { times.set(this, time); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

it.each([16, 24, 30])('F2P: %s FPS video corrects drift of two project frames', fps => {
  const seek = 1 + 2 / fps;
  const { container } = render(<StudioFrameRateContext.Provider value={fps}>
    <VideoUnderlay aiVideoLayer="/clip.mp4" currentLayerSeek={seek} isVideoPreviewPlaying canvasDimensions={{ width: 400, height: 300 }} />
  </StudioFrameRateContext.Provider>);
  const video = [...container.querySelectorAll('video')].find(el => el.getAttribute('aria-hidden') === 'false');
  expect(video.currentTime).toBeCloseTo(seek, 8);
});

it('F2P: equivalent audio metadata refresh retains the loaded audio element', async () => {
  const audio = [];
  class AudioStub extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.readyState = 4; this.paused = true;
      this.load = vi.fn(); this.pause = vi.fn(); this.removeAttribute = vi.fn(); audio.push(this); }
  }
  vi.stubGlobal('Audio', AudioStub);
  const tracks = [{ _id: 'speech', url: '/voice.wav', startTime: 0, duration: 2, generationType: 'speech', isEnabled: true }];
  const props = { audioLayers: tracks, applyAudioDucking: false, isVideoPreviewPlaying: false,
    currentLayerSeek: 0, totalDuration: 2, framesPerSecond: 24, setCurrentLayerSeek: vi.fn(), setIsVideoPreviewPlaying: vi.fn() };
  const { rerender } = render(<PreviewPlaybackController {...props} />);
  await act(async () => rerender(<PreviewPlaybackController {...props} audioLayers={tracks.map(track => ({ ...track }))} />));
  expect(audio).toHaveLength(1);
});

it('F2P: rotating a credential preserves an already decoded video slot', () => {
  const props = { aiVideoLayer: '/assets_v2/clip.mp4?asset_token=first', currentLayerSeek: 1,
    canvasDimensions: { width: 400, height: 300 } };
  const { container, rerender } = render(<VideoUnderlay {...props} />);
  const active = () => [...container.querySelectorAll('video')].find(el => el.getAttribute('aria-hidden') === 'false');
  const decodedVideo = active();
  rerender(<VideoUnderlay {...props} aiVideoLayer="/assets_v2/clip.mp4?asset_token=refreshed" />);
  expect(active()).toBe(decodedVideo);
});

it('F2P: failed private video asks its session owner to refresh media credentials', () => {
  const onVideoError = vi.fn();
  const { container } = render(<VideoUnderlay aiVideoLayer="/assets_v2/clip.mp4?asset_token=expired"
    onVideoError={onVideoError} canvasDimensions={{ width: 400, height: 300 }} />);
  const active = [...container.querySelectorAll('video')].find(el => el.getAttribute('aria-hidden') === 'false');
  fireEvent.error(active);
  expect(onVideoError).toHaveBeenCalledOnce();
});

it('F2P: buffering visuals hold the project clock and resume without a wall-clock jump', async () => {
  let callback;
  vi.stubGlobal('requestAnimationFrame', vi.fn(fn => { callback = fn; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const active = vi.fn();
  const seek = vi.fn();
  const props = { audioLayers: [], isVisualReady: false, isVideoPreviewPlaying: true, currentLayerSeek: 0,
    framesPerSecond: 24, totalDuration: 10, onPlaybackActiveChange: active, setCurrentLayerSeek: seek, setIsVideoPreviewPlaying: vi.fn() };
  let view;
  await act(async () => { view = render(<StudioFrameRateContext.Provider value={24}><PreviewPlaybackController {...props} /></StudioFrameRateContext.Provider>); });
  expect(active).not.toHaveBeenCalledWith(true);
  act(() => callback(5000));
  expect(seek).not.toHaveBeenCalled();
  await act(async () => view.rerender(<StudioFrameRateContext.Provider value={24}><PreviewPlaybackController {...props} isVisualReady /></StudioFrameRateContext.Provider>));
  act(() => callback(6000));
  act(() => callback(6042));
  expect(seek).toHaveBeenLastCalledWith(1);
});
