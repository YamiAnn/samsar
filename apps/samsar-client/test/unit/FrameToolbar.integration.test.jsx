import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FrameToolbar from '../../src/components/video/toolbars/frame_toolbar/index.jsx';

vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ user: { _id: 'editor-user' } }) }));
vi.mock('react-slider', () => ({ default: props => <input data-testid="frame-seek" type="range"
  min={props.min} max={props.max} value={props.value} onChange={event => {
    props.onBeforeChange?.(); props.onChange?.(Number(event.target.value)); props.onAfterChange?.(Number(event.target.value));
  }} /> }));
vi.mock('../../src/components/video/util/DualThumbSlider.jsx', () => ({ default: () => <div data-testid="view-range" /> }));
vi.mock('../../src/components/video/util/TimeRuler.jsx', () => ({ default: props => <output data-testid="ruler-duration">{props.totalDuration}</output> }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/RangeOverlaySlider.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/util/AudioTrackSlider.jsx', () => ({ default: props => <button
  onClick={() => props.setAudioRangeSliderDisplayAsSelected?.(props.audioTrack?._id)}>{props.audioTrack?.title || 'Select audio track'}</button> }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/text_toolbar/TextTrackDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/visual_toolbar/VisualTrackDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/visual_toolbar/SelectedVisualTrackDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/video_toolbar/VideoTrackDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/video_toolbar/SelectedVideoTrackDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/text_toolbar/SelectedTextToolbarDisplay.jsx', () => ({ default: () => null }));
vi.mock('../../src/components/video/toolbars/frame_toolbar/hints_toolbar/HintTrackDisplay.jsx', () => ({ default: props => <button
  onClick={() => props.setHintTrackDisplayAsSelected(props.hint.id)}>{props.hint.text}</button> }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

const layers = () => [
  { _id: 'scene-1', duration: 5, durationOffset: 0, imageSession: { activeItemList: [] } },
  { _id: 'scene-2', duration: 7, durationOffset: 5, imageSession: { activeItemList: [] } },
];
function toolbar(extra = {}) {
  const props = {
    layers: layers(), audioLayers: [], globalAudioLayers: [], globalVideos: [], selectedLayerIndex: 0, currentLayerSeek: 0,
    sessionId: 'toolbar-session', frameToolbarView: 'EXPANDED', framesPerSecond: 24,
    setSelectedLayer: vi.fn(), setSelectedLayerIndex: vi.fn(), setLayerDuration: vi.fn(),
    setCurrentLayerSeek: vi.fn(), setIsLayerSeeking: vi.fn(), updateSessionLayer: vi.fn(),
    removeSessionLayer: vi.fn(), addLayerToComposition: vi.fn(), copyCurrentLayerBelow: vi.fn(),
    onApplyAudioDuckingChange: vi.fn(), onRegenerateFramesBeforeRenderChange: vi.fn(),
    updateChangesToActiveSessionLayers: vi.fn(), submitRegenerateFrames: vi.fn(), ...extra,
  };
  return { props, ...render(<FrameToolbar {...props} />) };
}
const settings = () => fireEvent.click(screen.getByText('Settings', { exact: true }));

describe('frame toolbar integration', () => {
  it('computes the whole timeline from real scene metadata', () => {
    toolbar(); settings();
    expect(screen.getByTestId('ruler-duration')).toHaveTextContent('12');
    expect(screen.getByText('12.0s', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Ready', { exact: true })).toBeInTheDocument();
  });

  it.each(['none', 'fade', 'dissolve'])('forwards the chosen %s transition to the session owner', transition => {
    const onSceneTransitionPresetChange = vi.fn();
    toolbar({ onSceneTransitionPresetChange }); settings();
    const label = transition[0].toUpperCase() + transition.slice(1);
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
    expect(onSceneTransitionPresetChange).toHaveBeenCalledExactlyOnceWith(transition);
  });

  it('changes render flags through real settings controls', () => {
    const { props } = toolbar(); settings();
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable audio ducking/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Regenerate frames before render/ }));
    expect(props.onApplyAudioDuckingChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(props.onRegenerateFramesBeforeRenderChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('shows waveform style choices only after waveforms are enabled', () => {
    toolbar(); settings();
    expect(screen.queryByRole('button', { name: 'Spectrogram' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show layer waveforms/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Spectrogram' }));
    expect(screen.getByRole('button', { name: 'Spectrogram' })).toHaveClass('bg-sky-500');
    expect(screen.getByText('Waveform lanes appear beside each enabled audio layer in the Audio tab.')).toBeInTheDocument();
  });

  it('uses a pending render status and permits cancellation from Settings', () => {
    const cancelPendingRender = vi.fn();
    toolbar({ isRenderPending: true, cancelPendingRender }); settings();
    expect(screen.getByText('Rendering', { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel render' }));
    expect(cancelPendingRender).toHaveBeenCalledOnce();
  });

  it('keeps destructive track tabs disabled while a render is pending', () => {
    toolbar({ isRenderPending: true });
    expect(screen.getByText('Hints', { exact: true }).parentElement).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByText('Hints', { exact: true }));
    expect(screen.queryByRole('button', { name: 'Add hint' })).not.toBeInTheDocument();
    settings(); expect(screen.getByText('Editor Options')).toBeInTheDocument();
  });

  it('adds a scene through the nested real Layer menu', () => {
    const { props } = toolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Layer', exact: true }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'At end' }));
    expect(props.addLayerToComposition).toHaveBeenCalledExactlyOnceWith('end');
  });

  it('enables and removes the actual timeline grid through Settings', () => {
    const { container } = toolbar(); settings();
    fireEvent.click(screen.getByRole('checkbox', { name: /Timeline grid/ }));
    expect(container.querySelector('.action-view-grid-overlay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide timeline grid' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide timeline grid' }));
    expect(container.querySelector('.action-view-grid-overlay')).not.toBeInTheDocument();
  });

  it('adds and immediately persists a scene-bound hint with seconds-based timing', async () => {
    const updateSessionHints = vi.fn().mockResolvedValue({ success: true });
    toolbar({ updateSessionHints });
    fireEvent.click(screen.getByText('Hints', { exact: true }));
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add hint', exact: true }));
    fireEvent.change(screen.getByPlaceholderText('Hint text'), { target: { value: '  Enter the ruins  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    await waitFor(() => expect(updateSessionHints).toHaveBeenCalledOnce());
    expect(updateSessionHints.mock.calls[0][0]).toEqual([expect.objectContaining({ text: 'Enter the ruins', startTime: 0, endTime: 5, duration: 5, layerId: 'scene-1' })]);
    await waitFor(() => expect(screen.getByText('Hint added.')).toBeInTheDocument());
  });

  it('rejects a blank scene hint before calling persistence', () => {
    const updateSessionHints = vi.fn();
    toolbar({ updateSessionHints });
    fireEvent.click(screen.getByText('Hints', { exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Add hint', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    expect(updateSessionHints).not.toHaveBeenCalled();
    expect(screen.getByText('Enter hint text before adding.')).toBeInTheDocument();
  });

  it('keeps an unsaved hint after a rejected persistence request', async () => {
    toolbar({ updateSessionHints: vi.fn().mockRejectedValue(new Error('Offline, try again')) });
    fireEvent.click(screen.getByText('Hints', { exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Add hint', exact: true }));
    fireEvent.change(screen.getByPlaceholderText('Hint text'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    await waitFor(() => expect(screen.getByText('Offline, try again')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('Hint text')).toHaveValue('Keep this draft');
  });

  it('selects the clicked scene and moves the playhead to that scene', () => {
    const { props } = toolbar();
    fireEvent.mouseDown(screen.getByRole('button', { name: '2 7.0s' }), { button: 0 });
    expect(props.setSelectedLayerIndex).toHaveBeenCalledWith(1);
    expect(props.setSelectedLayer).toHaveBeenCalledWith(props.layers[1]);
    expect(props.setCurrentLayerSeek).toHaveBeenCalledWith(expect.any(Number));
    expect(props.setCurrentLayerSeek.mock.calls.at(-1)[0]).toBeGreaterThanOrEqual(150);
  });

  it('updates scene duration through the scene quick editor', () => {
    const { props } = toolbar();
    fireEvent.mouseDown(screen.getByRole('button', { name: '1 5.0s' }), { button: 0 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update', exact: true }));
    expect(props.setLayerDuration).toHaveBeenCalledExactlyOnceWith(8.5, 0);
    expect(props.updateSessionLayer).toHaveBeenCalledWith(expect.objectContaining({ _id: 'scene-1', duration: 8.5 }),
      { clipStart: false, clipEnd: false, clipStartFrames: 0, clipEndFrames: 0 });
  });

  it('protects the final scene from removal', () => {
    const { props } = toolbar({ layers: [layers()[0]] });
    fireEvent.mouseDown(screen.getByRole('button', { name: '1 5.0s' }), { button: 0 });
    expect(screen.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
    expect(props.removeSessionLayer).not.toHaveBeenCalled();
  });

  it('removes a selected scene when other scenes remain', () => {
    const { props } = toolbar();
    fireEvent.mouseDown(screen.getByRole('button', { name: '1 5.0s' }), { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
    expect(props.removeSessionLayer).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('discards unsaved audio changes with Reset', () => {
    toolbar({ audioLayers: [{ _id: 'audio-1', title: 'Background music', generationType: 'music', startTime: 0, duration: 8, volume: 50, isEnabled: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Background music', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Layer volume' }), { target: { value: '20' } });
    expect(screen.getByRole('textbox', { name: 'Layer volume' })).toHaveValue('20');
    fireEvent.click(screen.getByRole('button', { name: 'Reset unsaved audio layer changes' }));
    expect(screen.getByRole('textbox', { name: 'Layer volume' })).toHaveValue('50');
  });

  it('locks audio timing while leaving its volume editable', () => {
    toolbar({ audioLayers: [{ _id: 'audio-1', title: 'Background music', generationType: 'music', startTime: 0, duration: 8, volume: 50, isEnabled: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Background music', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock audio layer', exact: true }));
    expect(screen.getByRole('textbox', { name: 'Start time' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'End time' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Layer volume' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock audio layer', exact: true }));
    expect(screen.getByRole('textbox', { name: 'Start time' })).toBeEnabled();
  });

  it('rejects a nonpositive scene duration before updating session state', () => {
    const { props } = toolbar();
    fireEvent.mouseDown(screen.getByRole('button', { name: '1 5.0s' }), { button: 0 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update', exact: true }));
    expect(props.setLayerDuration).not.toHaveBeenCalled();
    expect(props.updateSessionLayer).not.toHaveBeenCalled();
  });
});
