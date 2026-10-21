import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import TimeRuler from '../../src/components/video/util/TimeRuler.jsx';
import AudioTrackSlider from '../../src/components/video/util/AudioTrackSlider.jsx';
import FrameToolbarHorizontal from '../../src/components/video/toolbars/frame_toolbar/FrameToolbarHorizontal.jsx';
import RangeOverlaySlider from '../../src/components/video/toolbars/frame_toolbar/RangeOverlaySlider.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';
import { isItemVisibleAtDisplayFrame } from '../../src/components/video/editor/CanvasUtils.jsx';

const sliders = vi.hoisted(() => []);
vi.mock('konva', () => ({ default: { Filters: {} } }));
vi.mock('react-konva', () => Object.fromEntries(['Image', 'Transformer', 'Group', 'Text', 'Rect', 'Circle', 'Line', 'Shape', 'Path', 'Stage', 'Layer'].map(name => [name, name.toLowerCase()])));
vi.mock('react-konva-utils', () => ({ useImage: () => [null, 'loading'], Html: () => null }));
vi.mock('react-slider', async () => ({ default: (await import('react')).forwardRef((props, _ref) => {
  sliders.push(props);
  return <div data-min-distance={props.minDistance}>{props.renderTrack?.({ key: 'range', style: {}, className: '' }, { index: 1 })}</div>;
}) }));

beforeEach(() => {
  sliders.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  HTMLElement.prototype.scrollBy = vi.fn();
});

for (const fps of [16, 24, 30]) {
  const geometry = { totalPixels: 600, segments: [
    { frameStart: 0, frameEnd: fps, pixelStart: 0, pixelEnd: 76 },
    { frameStart: fps, frameEnd: 10 * fps, pixelStart: 76, pixelEnd: 600 },
  ] };
  it(`F2P: ${fps} FPS ruler agrees with scene geometry`, () => {
    const { container } = render(<StudioFrameRateContext.Provider value={fps}>
      <TimeRuler totalDuration={10} viewportGeometry={geometry} />
    </StudioFrameRateContext.Provider>);
    const tick = [...container.querySelectorAll('.time-ruler-tick')].find(el => el.textContent === '2s');
    expect(parseFloat(tick.style.top)).toBeCloseTo((76 + 524 / 9) / 6, 5);
  });

  it(`F2P: ${fps} FPS audio body movement preserves time duration across scene scales`, () => {
    const onUpdate = vi.fn();
    const { container } = render(<StudioFrameRateContext.Provider value={fps}>
      <AudioTrackSlider audioTrack={{ _id: 'audio', startTime: 0.5, duration: 1, endTime: 1.5 }}
        selectedFrameRange={[0, 10 * fps]} viewportGeometry={geometry} onUpdate={onUpdate}
        setAudioRangeSliderDisplayAsSelected={vi.fn()} isStartVisible isEndVisible />
    </StudioFrameRateContext.Provider>);
    fireEvent.mouseDown(container.querySelector('.timeline-layer-range-bar'), { button: 0, clientY: 100 });
    fireEvent.mouseMove(document, { clientY: 150 });
    fireEvent.mouseUp(document);
    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls.at(-1)[3]).toBeCloseTo(1, 8);
  });

  it(`F2P: ${fps} FPS bottom strip retains explicit timeline gaps`, () => {
    const layers = [{ _id: 'one', duration: 1, durationOffset: 0 }, { _id: 'two', duration: 1, durationOffset: 2 }];
    const { container } = render(<StudioFrameRateContext.Provider value={fps}>
      <FrameToolbarHorizontal layers={layers} totalDuration={3} selectedLayerIndex={0}
        currentLayerSeek={2 * fps} setSelectedLayerIndex={vi.fn()} setSelectedLayer={vi.fn()} setCurrentLayerSeek={vi.fn()} />
    </StudioFrameRateContext.Provider>);
    expect(parseFloat(container.querySelector('[data-layer-id="one"]').style.width)).toBeCloseTo(200, 6);
    expect(parseFloat(container.querySelector('[data-layer-id="two"]').style.left)).toBeCloseTo(400, 6);
  });

  it(`F2P: ${fps} FPS item visibility excludes the end boundary`, () => {
    const item = { config: { frameOffset: 0, frameDuration: fps, frameRate: fps } };
    expect(isItemVisibleAtDisplayFrame(item, fps - 1, fps, fps)).toBe(true);
    expect(isItemVisibleAtDisplayFrame(item, fps, fps, fps)).toBe(false);
  });
}

it('F2P: trim minimum uses the bound 16 FPS project clock', () => {
  const { container } = render(<StudioFrameRateContext.Provider value={16}>
    <RangeOverlaySlider min={0} max={160} value={[0, 160]} onChange={vi.fn()} />
  </StudioFrameRateContext.Provider>);
  expect(container.querySelector('[data-min-distance]')).toHaveAttribute('data-min-distance', '2');
});
