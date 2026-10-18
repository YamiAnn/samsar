import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PreviewPlaybackController from '../../src/components/video/PreviewPlaybackController.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';

const callbacks = new Map();
let frameId = 0;
afterEach(() => { callbacks.clear(); });
for (const fps of [16,24,30]) {
  it(`advances the ${fps} fps studio preview by one native frame and stops at its final frame`, async () => {
    vi.stubGlobal('requestAnimationFrame', callback => { const id=++frameId; callbacks.set(id,callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', id => callbacks.delete(id));
    const now = vi.spyOn(performance,'now').mockReturnValue(0);
    const seek = vi.fn();
    const playing = vi.fn();
    await act(async()=>{
      render(<StudioFrameRateContext.Provider value={fps}>
        <PreviewPlaybackController framesPerSecond={fps} audioLayers={[]} currentLayerSeek={0}
          isVideoPreviewPlaying totalDuration={3/fps} setCurrentLayerSeek={seek}
          setIsVideoPreviewPlaying={playing} />
      </StudioFrameRateContext.Provider>);
    });
    function tick(time) {
      const [id,callback]=callbacks.entries().next().value;
      callbacks.delete(id);act(()=>callback(time));
    }
    tick(1000/fps+0.01);
    expect(seek).toHaveBeenLastCalledWith(1);
    tick(2000/fps+0.01);
    expect(seek).toHaveBeenLastCalledWith(2);
    tick(3000/fps+0.01);
    expect(playing).toHaveBeenLastCalledWith(false);
    expect(seek.mock.calls.map(([frame])=>frame)).toEqual([1,2]);
    now.mockRestore();
  });
}
