import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import FrameToolbar from '../../src/components/video/toolbars/frame_toolbar/index.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';

vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'owner' } }) }));
vi.mock('react-slider', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/text_toolbar/TextTrackDisplay.jsx', () => ({ default: p =>
  <button onClick={() => p.setTextTrackDisplayAsSelected(p.textItemLayer)}>Select caption</button> }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/video_toolbar/VideoTrackDisplay.jsx', () => ({ default: p =>
  <button onClick={() => p.setVideoTrackDisplayAsSelected(p.videoTrackItem.layerId)}>Select video</button> }));
vi.mock('../../src/components/common/SingleSelect.jsx', () => ({ default: p =>
  <select aria-label="Effect type" value={p.value?.value || ''} onChange={e => p.onChange(p.options.find(o => o.value === e.target.value))}>
    <option value="" />{p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select> }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });

function mount(extra = {}, fps = 24) {
  const layer = { _id: 'scene', duration: 4, durationOffset: 0, hasAiVideoLayer: true, aiVideoLayer: '/video.mp4',
    imageSession: { activeItemList: [{ id: 'caption', type: 'text', text: 'Caption', startFrame: 0, endFrame: 4 * fps,
      config: { frameRate: fps, frameOffset: 0, frameDuration: 4 * fps } }] } };
  const props = { layers: [layer], audioLayers: [], globalAudioLayers: [], globalVideos: [], currentLayer: layer,
    sessionDetails: { framesPerSecond: fps }, sessionId: 'session', selectedLayerIndex: 0, currentLayerSeek: 0,
    frameToolbarView: 'EXPANDED', framesPerSecond: fps, setSelectedLayerIndex: vi.fn(), setSelectedLayer: vi.fn(),
    setCurrentLayerSeek: vi.fn(), setIsLayerSeeking: vi.fn(), updateSessionLayer: vi.fn(),
    requestVideoLayerEdit: vi.fn().mockResolvedValue({ success: true }), ...extra };
  const view = render(<StudioFrameRateContext.Provider value={fps}><FrameToolbar {...props} /></StudioFrameRateContext.Provider>);
  return { ...view, props };
}

it('F2P: text timing fields are editable and save native frame offsets', async () => {
  const { container, props } = mount();
  fireEvent.click(screen.getByText('Text', { exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Select caption' }));
  fireEvent.change(container.querySelector('input[name="startTime"]'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(props.updateSessionLayer).toHaveBeenCalled());
  expect(props.updateSessionLayer.mock.calls.at(-1)[0].imageSession.activeItemList[0].config)
    .toMatchObject({ frameRate: 24, frameOffset: 24, frameDuration: 72 });
});

it('F2P: adding an effect respects the entered time range', () => {
  const { container, props } = mount();
  fireEvent.click(screen.getByText('Text', { exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Select caption' }));
  fireEvent.click(screen.getByRole('button', { name: 'Effect', exact: true }));
  fireEvent.change(screen.getByLabelText('Effect type'), { target: { value: 'typewriter' } });
  const inputs = container.querySelectorAll('input[type="text"]');
  fireEvent.change(inputs[0], { target: { value: '1' } });
  fireEvent.change(inputs[1], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
  const animation = props.updateSessionLayer.mock.calls.at(-1)[0].imageSession.activeItemList[0].animations[0];
  expect(animation).toMatchObject({ startFrame: 24, endFrame: 48, frameOffset: 24, frameDuration: 24 });
});

it.each([1.25, 1.5])('F2P: applying a %sx edit sends that exact multiplier', async speed => {
  const { props } = mount();
  fireEvent.click(screen.getByText('Video', { exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Select video' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fast edit' }));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(speed) } });
  fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
  await waitFor(() => expect(props.requestVideoLayerEdit).toHaveBeenCalled());
  expect(props.requestVideoLayerEdit.mock.calls.at(-1)[0].operations[0].speedMultiplier).toBe(speed);
});

it('F2P: selected legacy text uses its configured clock in a 24 FPS session', () => {
  const layers = [{ _id: 'scene', duration: 4, durationOffset: 0, imageSession: { activeItemList: [
    { id: 'legacy', type: 'text', startFrame: 30, endFrame: 60, config: { frameRate: 30, frameOffset: 30, frameDuration: 30 } },
  ] } }];
  const { container } = mount({ layers });
  fireEvent.click(screen.getByText('Text', { exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Select caption' }));
  expect(container.querySelector('input[name="startTime"]')).toHaveValue('1.00');
  expect(container.querySelector('input[name="endTime"]')).toHaveValue('2.00');
});

it('F2P: Settings scene navigation selects the adjacent scene', () => {
  const layers = ['first', 'second'].map((_id, index) => ({ _id, duration: 2, durationOffset: index * 2, imageSession: { activeItemList: [] } }));
  const { container, props } = mount({ layers });
  fireEvent.click(screen.getByText('Settings', { exact: true }));
  // Existing scene controls have no accessible names; locate their Scenes group.
  const sceneGroup = screen.getByText('Scenes', { exact: true }).parentElement;
  const button = sceneGroup.querySelectorAll('button')[1];
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(props.setSelectedLayerIndex).toHaveBeenCalledWith(1);
});

it('F2P: the vertical timeline reserves space for explicit scene gaps', () => {
  const layers = ['first', 'second'].map((_id, index) => ({ _id, duration: 1, durationOffset: index * 2, imageSession: { activeItemList: [] } }));
  const { container } = mount({ layers });
  const rows = container.querySelectorAll('[data-scene-layer-body]');
  expect(parseFloat(rows[1].style.top || '0')).toBeGreaterThan(parseFloat(rows[0].style.height));
});
