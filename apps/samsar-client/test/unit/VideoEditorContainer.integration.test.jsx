import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const boundary = vi.hoisted(() => ({ toolbar: null, canvas: null, library: null }));
const session = vi.hoisted(() => ({
  headers: { headers: { Authorization: 'Bearer studio-owner' } },
  route: {}, colorMode: 'dark',
  getUserAPI: vi.fn(), openAlertDialog: vi.fn(), closeAlertDialog: vi.fn(), setIsAlertActionPending: vi.fn(),
  success: vi.fn(), error: vi.fn(), capture: vi.fn(),
}));

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useParams: () => session.route }));
vi.mock('konva', () => ({ default: { Filters: {} } }));
vi.mock('../../src/contexts/UserContext.jsx', () => ({ useUser: () => ({ getUserAPI: session.getUserAPI, user: { _id: 'owner' } }) }));
vi.mock('../../src/contexts/AlertDialogContext.jsx', () => ({ useAlertDialog: () => session }));
vi.mock('../../src/contexts/ColorMode.jsx', () => ({ useColorMode: () => ({ colorMode: session.colorMode }) }));
vi.mock('../../src/contexts/LocalizationContext.jsx', () => ({ useLocalization: () => ({ t: (key) => key }) }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: () => session.headers }));
vi.mock('../../src/utils/environment.jsx', () => ({ IS_STANDALONE_DEPLOYMENT: false }));
vi.mock('../../src/utils/assistantFrameCapture.js', () => ({ captureAssistantStageImageData: session.capture }));
vi.mock('react-toastify', () => ({ toast: { success: session.success, error: session.error } }));
vi.mock('../../src/components/auth/AuthContainer.jsx', () => ({ default: () => <div>Sign in</div>, AUTH_DIALOG_OPTIONS: { hideCloseButton: true } }));
vi.mock('../../src/components/image/ImageUploadDialog.jsx', () => ({ default: () => <div>Upload media</div> }));
vi.mock('../../src/components/video/util/LoadingImage.jsx', () => ({ default: () => <div>Loading scene</div> }));
vi.mock('../../src/components/video/util/LoadingImageBase.jsx', () => ({ default: () => <div>Working on canvas</div> }));
vi.mock('../../src/components/video/toolbars/VideoEditorToolbar.jsx', () => ({ default: (props) => { boundary.toolbar = props; return <aside data-testid="editor-toolbar" />; } }));
vi.mock('../../src/components/video/editor/VideoCanvasContainer.jsx', async () => {
  const { forwardRef } = await import('react');
  return { default: forwardRef((props, _ref) => { boundary.canvas = props; return <div data-testid="editor-canvas" />; }) };
});
vi.mock('../../src/components/library/LibraryHome.jsx', () => ({ default: (props) => { boundary.library = props; return <section data-testid="media-library" />; } }));

import VideoEditorContainer from '../../src/components/video/VideoEditorContainer.jsx';
import { TOOLBAR_ACTION_VIEW } from '../../src/constants/Types.ts';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const makeLayer = (id = 'scene-a', extra = {}) => ({
  _id: id, durationOffset: 2, duration: 3, prompt: `Prompt for ${id}`,
  imageSession: { activeItemList: [], generationStatus: 'COMPLETED' }, ...extra,
});

function mount(overrides = {}, displayFrameRate = 30) {
  const layer = overrides.currentLayer || makeLayer();
  const props = {
    id: 'project-a', selectedLayerId: layer._id, currentLayerSeek: 60, currentLayer: layer,
    activeItemList: layer.imageSession.activeItemList, layers: [layer],
    videoSessionDetails: { _id: 'project-a', layers: [layer], audioLayers: [] },
    generationImages: [], aspectRatio: '16:9', totalDuration: 5,
    stageZoomScale: 1, isVideoPreviewPlaying: false,
    ...Object.fromEntries([
      'setCurrentLayerSeek', 'updateSessionLayerActiveItemList', 'updateSessionLayerActiveItemListAnimations',
      'setActiveItemList', 'showAddAudioToProjectDialog', 'updateCurrentActiveLayer', 'setVideoSessionDetails',
      'toggleHideItemInLayer', 'pollForLayersUpdate', 'setIsCanvasDirty', 'updateCurrentLayer',
      'applyAnimationToAllLayers', 'setGenerationImages', 'toggleStageZoom', 'zoomCanvasIn', 'zoomCanvasOut',
      'resetCanvasZoom', 'updateCurrentLayerInSessionList', 'updateCurrentLayerAndLayerList',
      'setIsVideoPreviewPlaying', 'setAudioLayers',
    ].map((key) => [key, vi.fn()])),
    ...overrides,
  };
  const element = () => <StudioFrameRateContext.Provider value={displayFrameRate}><VideoEditorContainer {...props} /></StudioFrameRateContext.Provider>;
  const view = render(element());
  return { ...view, props, update(changes) { Object.assign(props, changes); view.rerender(element()); } };
}

async function invoke(name, ...args) {
  let returned;
  await act(async () => { returned = boundary.toolbar[name](...args); await returned; });
  return returned;
}
async function tick(ms) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function openUpload() {
  act(() => boundary.toolbar.showUploadAction());
  const dialog = session.openAlertDialog.mock.calls.at(-1)[0];
  return dialog.props.children.props;
}

beforeEach(() => {
  vi.useFakeTimers();
  boundary.toolbar = boundary.canvas = boundary.library = null;
  session.headers = { headers: { Authorization: 'Bearer studio-owner' } };
  session.route = {};
  session.colorMode = 'dark';
  for (const key of ['getUserAPI', 'openAlertDialog', 'closeAlertDialog', 'setIsAlertActionPending', 'success', 'error', 'capture']) session[key].mockReset();
  session.capture.mockResolvedValue('data:image/png;base64,captured');
  axios.get.mockReset().mockResolvedValue({ data: { status: 'PENDING', generationStatus: 'PENDING' } });
  axios.post.mockReset().mockResolvedValue({ data: {} });
});

describe('Studio editor scene integration', () => {
  it('mounts the canvas and toolbar with the current scene, its prompt, and native frame rate', () => {
    const { props } = mount();
    expect(screen.getByTestId('editor-canvas')).toBeInTheDocument();
    expect(boundary.toolbar.currentDefaultPrompt).toBe('Prompt for scene-a');
    expect(boundary.canvas.currentLayerSeek).toBe(60);
    expect(boundary.canvas.currentLayer).toBe(props.currentLayer);
    expect(boundary.toolbar.textConfig).toMatchObject({ x: 896, y: 512 });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('shows a scene loading state and delegates resumed image generation to the parent poller', () => {
    const layer = makeLayer('pending', { imageSession: { activeItemList: [], generationStatus: 'PENDING' } });
    const { props } = mount({ currentLayer: layer });
    expect(screen.getByText('Loading scene')).toBeInTheDocument();
    expect(props.pollForLayersUpdate).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('editor-canvas')).not.toBeInTheDocument();
  });

  it('computes speech overlap strictly within scene boundaries and reacts to session refresh', () => {
    const layer = makeLayer();
    const { update } = mount({ currentLayer: layer, videoSessionDetails: { audioLayers: [
      { generationType: 'speech', startTime: 0, endTime: 2 },
      { generationType: 'speech', startTime: 5, endTime: 6 },
      { generationType: 'music', startTime: 2, endTime: 5 },
    ] } });
    expect(boundary.toolbar.currentLayerHasSpeechLayer).toBe(false);
    act(() => update({ videoSessionDetails: { audioLayers: [{ generationType: 'speech', startTime: 1, endTime: 3 }] } }));
    expect(boundary.toolbar.currentLayerHasSpeechLayer).toBe(true);
  });

  it('registers assistant image capture and clears the callback on unmount', async () => {
    const onAssistantFrameCaptureChange = vi.fn();
    const { unmount } = mount({ onAssistantFrameCaptureChange });
    const capture = onAssistantFrameCaptureChange.mock.calls[0][0];
    await expect(capture()).resolves.toEqual({ dataUrl: 'data:image/png;base64,captured', mimeType: 'image/png' });
    expect(session.capture).toHaveBeenCalledWith(expect.objectContaining({ current: null }), { maxDimension: 1536 });
    session.capture.mockResolvedValue(null);
    await expect(capture()).resolves.toBeNull();
    unmount();
    expect(onAssistantFrameCaptureChange).toHaveBeenLastCalledWith(null);
  });

  it('opens the library boundary and returns to the canvas after selecting an image', async () => {
    const { props } = mount();
    await invoke('setCurrentCanvasAction', TOOLBAR_ACTION_VIEW.SHOW_LIBRARY_DISPLAY);
    expect(screen.getByTestId('media-library')).toBeInTheDocument();
    act(() => boundary.library.selectImageFromLibrary('/assets/photo.png', { previewUrl: 'https://signed.test/photo' }));
    expect(screen.getByTestId('editor-canvas')).toBeInTheDocument();
    const added = props.setActiveItemList.mock.calls.at(-1)[0][0];
    expect(added).toMatchObject({ type: 'image', id: 'item_0', src: '/assets/photo.png', previewUrl: 'https://signed.test/photo', startFrame: 60, endFrame: 150, config: { frameRate: 30, frameDuration: 90 } });
    expect(props.updateSessionLayerActiveItemList).toHaveBeenCalledWith([added]);
  });
});

describe('image generation lifecycle through editor callbacks', () => {
  function completion(layer = makeLayer()) {
    const completed = { ...layer, prompt: 'Generated prompt', imageSession: { ...layer.imageSession, activeGeneratedImage: 'completed.png' } };
    return { status: 'COMPLETED', layer: completed, layers: [completed], generationImages: ['completed.png'] };
  }

  it('submits selected prompt/model/session and appends completed generation on the native timeline', async () => {
    axios.get.mockResolvedValue({ data: completion() });
    const { props } = mount({}, 24);
    await invoke('setPromptText', 'Night skyline');
    const model = boundary.toolbar.selectedGenerationModel;
    await invoke('submitGenerateNewRequest', { guidanceScale: 7 });
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/video_sessions/request_generate'), {
      guidanceScale: 7, prompt: 'Night skyline', videoSessionId: 'project-a', model, layerId: 'scene-a', aspectRatio: '16:9',
    }, session.headers);
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/video_sessions/generate_status?id=project-a&layerId=scene-a'), session.headers);
    const [added] = props.setActiveItemList.mock.calls.at(-1)[0];
    expect(added).toMatchObject({ type: 'image', id: 'item_0', x: 0, y: 0, width: 1792, height: 1024, startFrame: 48, endFrame: 120 });
    expect(added.src).toContain('/generations/completed.png');
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(props.setGenerationImages).toHaveBeenCalledWith(['completed.png']);
    expect(props.setIsCanvasDirty).toHaveBeenCalledWith(true);
    expect(session.getUserAPI).toHaveBeenCalledOnce();
  });

  it('polls pending generation once per second and stops after a server-declared failure', async () => {
    axios.get.mockResolvedValueOnce({ data: { status: 'PENDING' } }).mockResolvedValueOnce({ data: { status: 'FAILED', generationError: 'Image quota exhausted' } });
    mount();
    await invoke('submitGenerateNewRequest', {});
    expect(boundary.toolbar.isGenerationPending).toBe(true);
    await tick(999);
    expect(axios.get).toHaveBeenCalledOnce();
    await tick(1);
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(boundary.toolbar.generationError).toBe('Image quota exhausted');
    await tick(5000);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('clears the pending flag and exposes a rejected generation request', async () => {
    axios.post.mockRejectedValueOnce(new Error('Generation unavailable'));
    mount();
    await invoke('submitGenerateNewRequest', {});
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(boundary.toolbar.generationError).toBe('Generation unavailable');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('marks recreate requests to skip prompt theming and respects an explicit model', async () => {
    const pending = deferred();
    axios.post.mockReturnValueOnce(pending.promise);
    mount();
    await invoke('submitGenerateRecreateRequest', { prompt: 'Recreate scene', model: 'explicit-model' });
    expect(axios.post.mock.calls[0][1]).toMatchObject({ prompt: 'Recreate scene', model: 'explicit-model', videoSessionId: 'project-a', layerId: 'scene-a', skipApplyThemeToPrompt: true, isRecreateRequest: true });
    await act(async () => { pending.resolve({ data: { prompt: 'Expanded prompt' } }); });
    expect(boundary.toolbar.currentDefaultPrompt).toBe('Expanded prompt');
  });

  it('opens sign-in without leaving a guest generation permanently pending', async () => {
    session.headers = undefined;
    mount();
    await invoke('submitGenerateNewRequest', {});
    expect(session.openAlertDialog).toHaveBeenCalledOnce();
    expect(axios.post).not.toHaveBeenCalled();
    expect(boundary.toolbar.isGenerationPending).toBe(false);
  });

  it('cancels scheduled image polling when the selected scene changes', async () => {
    const { update } = mount();
    await invoke('submitGenerateNewRequest', {});
    const next = makeLayer('scene-b');
    act(() => update({ currentLayer: next, selectedLayerId: 'scene-b', activeItemList: [] }));
    await tick(5000);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('does not replace the selected scene canvas with an old in-flight image response', async () => {
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    const { props, update } = mount();
    await invoke('submitGenerateNewRequest', {});
    const next = makeLayer('scene-b');
    act(() => update({ currentLayer: next, selectedLayerId: 'scene-b', activeItemList: [] }));
    props.setActiveItemList.mockClear();
    await act(async () => { pending.resolve({ data: completion() }); });
    expect(props.setActiveItemList).not.toHaveBeenCalled();
    expect(props.updateCurrentLayerAndLayerList.mock.calls.every(([, , options]) => options?.preserveCurrentLayer === true)).toBe(true);
  });

  it('clears scheduled image polling on unmount', async () => {
    const { unmount } = mount();
    await invoke('submitGenerateNewRequest', {});
    unmount();
    await tick(5000);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('does not start polling for a submission accepted after switching scenes', async () => {
    const pending = deferred();
    axios.post.mockReturnValueOnce(pending.promise);
    const { props, update } = mount();
    await invoke('submitGenerateNewRequest', {});
    const next = makeLayer('scene-b');
    act(() => update({ currentLayer: next, selectedLayerId: 'scene-b', layers: [next] }));
    await act(async () => { pending.resolve({ data: {} }); });
    expect(axios.get).not.toHaveBeenCalled();
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(props.setActiveItemList).not.toHaveBeenCalled();
  });

  it('ignores the old completion after switching away from a scene and back to it', async () => {
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    const { props, update } = mount();
    await invoke('submitGenerateNewRequest', {});
    const other = makeLayer('scene-b');
    act(() => update({ currentLayer: other, selectedLayerId: 'scene-b' }));
    act(() => update({ currentLayer: makeLayer(), selectedLayerId: 'scene-a' }));
    props.setActiveItemList.mockClear();
    await act(async () => { pending.resolve({ data: completion() }); });
    expect(props.setActiveItemList).not.toHaveBeenCalled();
    expect(props.updateCurrentLayerAndLayerList).not.toHaveBeenCalled();
  });

  it('ignores a superseded completion when a newer generation has already finished', async () => {
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ data: completion() });
    const { props } = mount();
    await invoke('submitGenerateNewRequest', {});
    await invoke('submitGenerateNewRequest', {});
    expect(props.setActiveItemList).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ data: completion() }); });
    expect(props.setActiveItemList).toHaveBeenCalledOnce();
    expect(boundary.toolbar.isGenerationPending).toBe(false);
  });

  it('does not apply an in-flight generation completion after leaving the editor', async () => {
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    const { props, unmount } = mount();
    await invoke('submitGenerateNewRequest', {});
    unmount();
    await act(async () => { pending.resolve({ data: completion() }); });
    expect(props.setActiveItemList).not.toHaveBeenCalled();
    expect(props.updateCurrentLayerAndLayerList).not.toHaveBeenCalled();
    expect(session.getUserAPI).not.toHaveBeenCalled();
  });

  it('releases pending state when image polling fails to reach the server', async () => {
    axios.get.mockRejectedValueOnce(new Error('Polling service offline'));
    mount();
    await invoke('submitGenerateNewRequest', {});
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(boundary.toolbar.generationError).toBe('Polling service offline');
    await tick(5000);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('releases pending state when authentication expires between submission and polling', async () => {
    const pending = deferred();
    axios.post.mockReturnValueOnce(pending.promise);
    mount();
    await invoke('submitGenerateNewRequest', {});
    session.headers = undefined;
    await act(async () => { pending.resolve({ data: {} }); });
    expect(boundary.toolbar.isGenerationPending).toBe(false);
    expect(session.openAlertDialog).toHaveBeenCalledOnce();
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('subtitle and session maintenance requests', () => {
  it.each([
    ['Thai', 'en', { subtitle_language: 'th' }],
    ['', 'bn-BD', { subtitle_language: 'bn' }],
    ['auto', undefined, {}],
  ])('regenerates subtitles with selected %s and session speech language %s', async (selected, speechLanguage, fields) => {
    const { props } = mount({ videoSessionDetails: { audioLayers: [], speechLanguage } });
    await act(async () => { await boundary.canvas.requestRegenerateSubtitles(selected); });
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/video_sessions/request_regenerate_subtitles'), { sessionId: 'project-a', realignAudio: true, ...fields }, session.headers);
    expect(props.setIsCanvasDirty).toHaveBeenCalledWith(true);
  });

  it.each([
    ['requestRegenerateAnimations', 'request_regenerate_animations', { sessionId: 'project-a' }],
    ['requestRealignLayers', 'request_realign_layers_to_speech_and_regen_sub', { sessionId: 'project-a', realignAudio: true }],
    ['requestRealignToAiVideoAndLayers', 'request_realign_to_ai_video_and_layers', { sessionId: 'project-a' }],
  ])('marks the project dirty after %s is accepted', async (action, endpoint, payload) => {
    const { props } = mount();
    await act(async () => { await boundary.canvas[action](); });
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining(`/video_sessions/${endpoint}`), payload, session.headers);
    expect(props.setIsCanvasDirty).toHaveBeenCalledWith(true);
  });

  it('saves defaults and exposes the pending state until the backend accepts them', async () => {
    const pending = deferred();
    axios.post.mockReturnValueOnce(pending.promise);
    const { props } = mount();
    let saving;
    act(() => { saving = boundary.toolbar.submitUpdateSessionDefaults({ duration: 7 }); });
    expect(boundary.toolbar.isUpdateDefaultsPending).toBe(true);
    const updated = { ...props.videoSessionDetails, defaultSceneDuration: 7 };
    await act(async () => { pending.resolve({ data: { videoSession: updated } }); await saving; });
    expect(axios.post.mock.calls[0][1]).toEqual({ sessionId: 'project-a', defaults: { duration: 7 } });
    expect(props.setVideoSessionDetails).toHaveBeenCalledWith(updated);
    expect(boundary.toolbar.isUpdateDefaultsPending).toBe(false);
  });

  it('rejects failed defaults saves and returns the settings controls to idle', async () => {
    const error = new Error('Defaults not saved');
    axios.post.mockRejectedValueOnce(error);
    mount();
    await act(async () => { await expect(boundary.toolbar.submitUpdateSessionDefaults({})).rejects.toBe(error); });
    expect(boundary.toolbar.isUpdateDefaultsPending).toBe(false);
    expect(session.error).toHaveBeenCalledOnce();
  });
});

describe('canvas edit actions and uploads', () => {
  it('adds styled text using the current portrait canvas and leaves the existing image intact', async () => {
    const image = { id: 'item_0', type: 'image', src: '/photo.png?signature=temporary' };
    const { props } = mount({ activeItemList: [image], aspectRatio: '9:16' });
    await invoke('addTextBoxToCanvas', { type: 'text', text: 'Caption', config: { fontSize: 64 } });
    expect(props.setActiveItemList.mock.calls[0][0]).toEqual([image, expect.objectContaining({ id: 'item_1', type: 'text', text: 'Caption', config: expect.objectContaining({ x: 512, y: 896, fontSize: 64 }) })]);
    expect(props.updateSessionLayerActiveItemList.mock.calls[0][0][0].src).toBe('/photo.png');
    expect(image.src).toBe('/photo.png?signature=temporary');
  });

  it.each(['rectangle', 'circle', 'polygon', 'dialog'])('adds a %s with visible canvas-relative geometry and persists it', async (shape) => {
    const { props } = mount();
    await invoke('setSelectedShape', shape);
    const [added] = props.setActiveItemList.mock.calls[0][0];
    expect(added).toMatchObject({ id: 'item_0', type: 'shape', shape, config: { fillColor: '#f5f5f5', strokeWidth: 2 } });
    expect(added.config.width).toBeGreaterThan(0);
    expect(added.config.height).toBeGreaterThan(0);
    expect(boundary.toolbar.selectedId).toBe('item_0');
    expect(props.updateSessionLayerActiveItemList).toHaveBeenCalledWith([added]);
  });

  it('preserves explicit shape configuration and clears the selection when entering eraser mode', async () => {
    const { props } = mount();
    await invoke('setSelectedShape', 'rectangle', { x: 20, y: 40, width: 200, height: 100, fillColor: '#ff0000' });
    expect(props.setActiveItemList.mock.calls[0][0][0].config).toMatchObject({ x: 20, y: 40, fillColor: '#ff0000' });
    await invoke('setCurrentCanvasAction', TOOLBAR_ACTION_VIEW.SHOW_ERASER_DISPLAY);
    expect(boundary.toolbar.selectedId).toBeNull();
  });

  it('adds only valid image uploads and binds their frame duration to the selected scene', () => {
    const { props } = mount({}, 24);
    const upload = openUpload();
    expect(upload.canvasDimensions).toEqual({ width: 1792, height: 1024 });
    act(() => upload.setUploadURL([null, { url: '/one.png', width: 120, height: 80 }, {}, { url: '/two.png', x: 30 }]));
    const added = props.setActiveItemList.mock.calls[0][0];
    expect(added.map(({ id, src }) => ({ id, src }))).toEqual([{ id: 'item_0', src: '/one.png' }, { id: 'item_1', src: '/two.png' }]);
    expect(added.every(({ startFrame, endFrame }) => startFrame === 48 && endFrame === 120)).toBe(true);
    expect(props.updateSessionLayerActiveItemList).toHaveBeenCalledWith(added);
    expect(session.closeAlertDialog).toHaveBeenCalledOnce();
  });

  it('ignores empty upload results without modifying the canvas', () => {
    const { props } = mount();
    const upload = openUpload();
    act(() => { upload.setUploadURL(null); upload.setUploadURL([]); upload.setUploadURL([{}]); });
    expect(props.setActiveItemList).not.toHaveBeenCalled();
  });

  it('uploads binary chunks with authenticated media headers and tracks progress through completion', async () => {
    const { props } = mount();
    const layer = makeLayer('scene-a', { hasUserVideoLayer: true, userVideoLayer: '/uploaded.mp4' });
    const updated = { ...props.videoSessionDetails, layers: [layer], audioLayers: [{ _id: 'uploaded-audio' }] };
    axios.post.mockImplementation(async (url) => url.includes('/upload_user_video_layer_chunk')
      ? { data: { session: updated, layer } }
      : { data: { status: 'PENDING' } });
    const upload = openUpload();
    const file = new File([new Uint8Array(8 * 1024 * 1024 + 3)], 'clip name.mp4', { type: 'video/mp4' });
    await act(async () => { await upload.setUploadVideo(file); });
    const chunks = axios.post.mock.calls.filter(([url]) => url.includes('/upload_user_video_layer_chunk'));
    expect(chunks).toHaveLength(2);
    expect(chunks.map(([url]) => new URL(url, 'https://test.invalid').searchParams.get('chunkIndex'))).toEqual(['0', '1']);
    expect(chunks.map(([, blob]) => blob.size)).toEqual([8 * 1024 * 1024, 3]);
    expect(chunks[0][2]).toEqual({ headers: { Authorization: 'Bearer studio-owner', 'Content-Type': 'video/mp4' } });
    expect(props.setAudioLayers).toHaveBeenCalledWith(updated.audioLayers);
    expect(props.updateCurrentLayerAndLayerList).toHaveBeenCalledWith(updated.layers, 0, { preserveCurrentLayer: true });
    expect(props.setIsCanvasDirty).toHaveBeenCalledWith(true);
  });

  it('rejects a video upload when the current scene already owns a video', async () => {
    mount({ currentLayer: makeLayer('scene-a', { hasUserVideoLayer: true, userVideoLayer: '/existing.mp4' }) });
    const upload = openUpload();
    await expect(upload.setUploadVideo(new File(['clip'], 'clip.mp4'))).rejects.toThrow('Remove the existing or pending video');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('reports an oversized upload chunk and restores video controls after failure', async () => {
    axios.post.mockRejectedValue({ response: { status: 413 } });
    mount();
    const upload = openUpload();
    await act(async () => { await expect(upload.setUploadVideo(new File(['clip'], 'clip.mp4'))).rejects.toThrow('server request limit'); });
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
    expect(session.error).toHaveBeenCalledOnce();
  });
});

describe('video generation and lip-sync eligibility', () => {
  it.each([
    { userVideoGenerationPending: true }, { aiVideoGenerationPending: true },
    { hasUserVideoLayer: true, userVideoLayer: '/existing.mp4' },
    { userVideoUploadTask: { status: 'UPLOADING' } },
    { lipSyncGenerationPending: true }, { soundEffectGenerationPending: true },
  ])('blocks a competing AI video request while the current scene owns %j', async (state) => {
    mount({ currentLayer: makeLayer('scene-a', state) });
    axios.post.mockClear();
    await invoke('submitGenerateNewVideoRequest', { model: 'new-video-model' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(session.error).toHaveBeenCalled();
  });

  it('submits the selected video prompt and request overrides, then settles completed video polling', async () => {
    const layer = makeLayer('scene-a', { aiVideoLayer: '/generated.mp4', layerAiVideoType: 'ai_video' });
    const details = { layers: [layer], audioLayers: [{ _id: 'voice' }] };
    axios.post.mockImplementation(async (url) => url.endsWith('/request_generate_custom_video')
      ? { data: { session: details, layer } }
      : { data: { status: 'COMPLETED', session: details } });
    const { props } = mount();
    await invoke('setVideoPromptText', 'Clouds over mountains');
    await invoke('submitGenerateNewVideoRequest', { model: 'override-video', duration: 5 });
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/request_generate_custom_video'), {
      prompt: 'Clouds over mountains', model: 'override-video', duration: 5, currentLayerId: 'scene-a', videoSessionId: 'project-a', aspectRatio: '16:9',
    }, session.headers);
    expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/generate_ai_video_status'), { sessionId: 'project-a', layerId: 'scene-a', aiVideoLayerType: 'ai_video' }, session.headers);
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
    expect(props.setAudioLayers).toHaveBeenCalledWith(details.audioLayers);
    expect(props.setIsCanvasDirty).toHaveBeenCalledWith(true);
  });

  it('returns AI-video controls to idle after the generation request is rejected', async () => {
    axios.post.mockRejectedValueOnce(new Error('Video provider offline'));
    mount();
    await invoke('submitGenerateNewVideoRequest', {});
    expect(boundary.toolbar.generationError).toBe('Video provider offline');
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
  });

  it('keeps AI-video controls idle when a guest is asked to sign in', async () => {
    session.headers = undefined;
    mount();
    await invoke('submitGenerateNewVideoRequest', {});
    expect(axios.post).not.toHaveBeenCalled();
    expect(session.openAlertDialog).toHaveBeenCalledOnce();
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
  });

  it('does not release another scene’s pending AI-video request when an old submission fails', async () => {
    const original = deferred();
    const current = deferred();
    axios.post.mockReturnValueOnce(original.promise).mockReturnValueOnce(current.promise);
    const { update } = mount();
    await invoke('submitGenerateNewVideoRequest', {});
    const next = makeLayer('scene-b');
    act(() => update({ currentLayer: next, selectedLayerId: 'scene-b', layers: [next] }));
    await invoke('submitGenerateNewVideoRequest', {});
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(true);
    await act(async () => { original.reject(new Error('Old scene provider failed')); });
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(true);
    expect(boundary.toolbar.generationError).toBeNull();
    expect(session.error).not.toHaveBeenCalled();
    await act(async () => { current.reject(new Error('Current scene provider failed')); });
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
    expect(boundary.toolbar.generationError).toBe('Current scene provider failed');
  });

  it('does not select or poll an old scene when its AI-video submission succeeds late', async () => {
    const original = deferred();
    const current = deferred();
    axios.post.mockReturnValueOnce(original.promise).mockReturnValueOnce(current.promise);
    const { props, update } = mount();
    await invoke('submitGenerateNewVideoRequest', {});
    const next = makeLayer('scene-b');
    act(() => update({ currentLayer: next, selectedLayerId: 'scene-b', layers: [next] }));
    await invoke('submitGenerateNewVideoRequest', {});
    const oldLayer = makeLayer('scene-a');
    await act(async () => { original.resolve({ data: { session: { layers: [oldLayer] }, layer: oldLayer } }); });
    expect(props.updateCurrentLayerAndLayerList).not.toHaveBeenCalled();
    expect(axios.post.mock.calls.some(([url]) => url.endsWith('/generate_ai_video_status'))).toBe(false);
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(true);
    expect(session.success).not.toHaveBeenCalled();
    await act(async () => { current.reject(new Error('Finish pending current request')); });
  });

  it('ignores an AI-video request completion after the editor is unmounted', async () => {
    const pending = deferred();
    axios.post.mockReturnValueOnce(pending.promise);
    const { props, unmount } = mount();
    await invoke('submitGenerateNewVideoRequest', {});
    unmount();
    const oldLayer = makeLayer();
    await act(async () => { pending.resolve({ data: { session: { layers: [oldLayer] }, layer: oldLayer } }); });
    expect(props.updateCurrentLayerAndLayerList).not.toHaveBeenCalled();
    expect(axios.post.mock.calls.some(([url]) => url.endsWith('/generate_ai_video_status'))).toBe(false);
  });

  it.each([
    { hasUserVideoLayer: true }, { userVideoGenerationPending: true },
    { aiVideoGenerationPending: true }, { lipSyncGenerationPending: true },
    { soundEffectGenerationPending: true }, {},
  ])('blocks lip-sync without an eligible completed AI video (%j)', async (state) => {
    mount({ currentLayer: makeLayer('scene-a', state) });
    axios.post.mockClear();
    await invoke('requestLipSyncToSpeech', 'sync-model');
    expect(axios.post).not.toHaveBeenCalled();
    expect(session.error).toHaveBeenCalled();
  });

  it('submits lip-sync against the current AI video and releases pending state on failure', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { error: 'Speech alignment unavailable' } } });
    mount({ currentLayer: makeLayer('scene-a', { aiVideoLayer: '/ai.mp4' }) });
    await invoke('requestLipSyncToSpeech', 'sync-model');
    expect(axios.post.mock.calls[0][1]).toEqual({ videoSessionId: 'project-a', sessionId: 'project-a', layerId: 'scene-a', model: 'sync-model' });
    expect(boundary.toolbar.aiVideoGenerationPending).toBe(false);
    expect(session.error).toHaveBeenCalledOnce();
  });
});
