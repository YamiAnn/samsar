import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import AudioTrackWaveformOverlay from '../../src/components/video/util/AudioTrackWaveformOverlay.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 100, height: 600 });
  axios.get.mockReset().mockResolvedValue({ data: new ArrayBuffer(8) });
  vi.stubGlobal('AudioContext', class {
    decodeAudioData = async () => ({ length: 8, numberOfChannels: 1, sampleRate: 8 });
    close = async () => {};
  });
});

it('F2P: volume-point clicks use the same segmented clock as the scene rail', () => {
  const onCreateVolumePoint = vi.fn();
  const geometry = { totalPixels: 600, segments: [
    { frameStart: 0, frameEnd: 24, pixelStart: 0, pixelEnd: 76 },
    { frameStart: 24, frameEnd: 240, pixelStart: 76, pixelEnd: 600 },
  ] };
  const { container } = render(<StudioFrameRateContext.Provider value={24}>
    <AudioTrackWaveformOverlay manualVolumeAdjustmentEnabled viewportGeometry={geometry} trackStartTimeSeconds={0}
      visibleLayerStartSeconds={0} visibleLayerDurationSeconds={10} onCreateVolumePoint={onCreateVolumePoint} />
  </StudioFrameRateContext.Provider>);
  fireEvent.click(container.querySelector('canvas'), { clientX: 50, clientY: 76 });
  expect(onCreateVolumePoint).toHaveBeenCalledWith(1);
});

it('F2P: a refreshed audio credential reuses the decoded waveform buffer', async () => {
  const { rerender } = render(<AudioTrackWaveformOverlay audioUrl="/assets_v2/wave-f2p.wav?asset_token=old" />);
  await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  rerender(<AudioTrackWaveformOverlay audioUrl="/assets_v2/wave-f2p.wav?asset_token=new" />);
  await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
});
