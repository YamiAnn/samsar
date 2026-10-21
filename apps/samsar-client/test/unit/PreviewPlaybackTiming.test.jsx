import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewPlaybackController from '../../src/components/video/PreviewPlaybackController.jsx';
import { StudioFrameRateContext } from '../../src/components/video/StudioFrameRateContext.jsx';

let audioElements;
let contexts;
let callbacks;
let nextFrameId;
let clockTime;
let autoReady;
let loadError;
let graphError;
let playError;
let contextState;
let resumePromise;
const browserStorage = { localStorage: window.localStorage, sessionStorage: window.sessionStorage };

class PreviewAudio extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.readyState = 0;
    this.paused = true;
    this.volume = 1;
    this.src = '';
    this.error = null;
    this.load = vi.fn(() => {
      if (loadError && this.src) throw loadError;
      if (autoReady) this.readyState = 3;
    });
    this.pause = vi.fn(() => { this.paused = true; });
    this.play = vi.fn(() => {
      if (playError) return Promise.reject(playError);
      this.paused = false;
      return Promise.resolve();
    });
    this.removeAttribute = vi.fn((name) => { if (name === 'src') this.src = ''; });
    audioElements.push(this);
  }
}

function makeAudioNode() {
  return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
}

class PreviewAudioContext {
  constructor() {
    this.state = contextState;
    this.destination = {};
    this.gains = [];
    this.sources = [];
    this.resume = vi.fn(() => resumePromise);
    this.close = vi.fn(() => { this.state = 'closed'; return Promise.resolve(); });
    this.createGain = vi.fn(() => { const node = makeAudioNode(); this.gains.push(node); return node; });
    this.createMediaElementSource = vi.fn((audio) => {
      if (graphError) throw graphError;
      const node = { ...makeAudioNode(), audio };
      this.sources.push(node);
      return node;
    });
    contexts.push(this);
  }
}

beforeEach(() => {
  audioElements = [];
  contexts = [];
  callbacks = new Map();
  nextFrameId = 0;
  clockTime = 0;
  autoReady = true;
  loadError = null;
  graphError = null;
  playError = null;
  contextState = 'running';
  resumePromise = Promise.resolve();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('Audio', PreviewAudio);
  vi.stubGlobal('AudioContext', PreviewAudioContext);
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id) => { callbacks.delete(id); }));
  vi.spyOn(performance, 'now').mockImplementation(() => clockTime);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The shared setup also stubs storage on Node 25+; keep that setup intact.
  vi.stubGlobal('localStorage', browserStorage.localStorage);
  vi.stubGlobal('sessionStorage', browserStorage.sessionStorage);
});

const track = (overrides = {}) => ({ url: 'https://media.example/voice.wav', startTime: 0, duration: 5,
  generationType: 'speech', volume: 100, ...overrides });

async function mountController(overrides = {}, displayRate = 30) {
  const props = { audioLayers: [], currentLayerSeek: 0, framesPerSecond: 30, totalDuration: 5,
    isVideoPreviewPlaying: true, setCurrentLayerSeek: vi.fn(), setIsVideoPreviewPlaying: vi.fn(),
    onPlaybackActiveChange: vi.fn(), ...overrides };
  const element = () => <StudioFrameRateContext.Provider value={displayRate}><PreviewPlaybackController {...props} /></StudioFrameRateContext.Provider>;
  let view;
  await act(async () => { view = render(element()); });
  return { props, ...view, update: async (changes) => {
    Object.assign(props, changes);
    await act(async () => { view.rerender(element()); });
  } };
}

async function tick(time) {
  const entry = callbacks.entries().next().value;
  expect(entry, 'a preview animation should be scheduled').toBeDefined();
  const [id, callback] = entry;
  callbacks.delete(id);
  clockTime = time;
  await act(async () => { callback(time); });
}

describe('preview project clock', () => {
  it.each([0, -1, 'bad'])('stops immediately for an invalid duration %j', async (duration) => {
    const { props } = await mountController({ totalDuration: duration });
    expect(props.setIsVideoPreviewPlaying).toHaveBeenCalledWith(false);
    expect(props.onPlaybackActiveChange).toHaveBeenCalledWith(false);
    expect(callbacks.size).toBe(0);
  });

  it('remains idle while paused and cancels playback on stop', async () => {
    const { props, update } = await mountController({ isVideoPreviewPlaying: false, audioLayers: [track()] });
    expect(callbacks.size).toBe(0);
    expect(audioElements[0].play).not.toHaveBeenCalled();
    await update({ isVideoPreviewPlaying: true });
    expect(callbacks.size).toBe(1);
    expect(audioElements[0].play).toHaveBeenCalledOnce();
    await update({ isVideoPreviewPlaying: false });
    expect(callbacks.size).toBe(0);
    expect(audioElements[0].paused).toBe(true);
    expect(props.onPlaybackActiveChange).toHaveBeenLastCalledWith(false);
  });

  it.each([undefined, 0, 60, 'bad'])('uses 24 preview fps when rate %j is unsupported while preserving the display clock', async (rate) => {
    const { props } = await mountController({ framesPerSecond: rate });
    await tick(1000 / 24 + 0.01);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1.25);
  });

  it('does not emit duplicate frames before the next preview frame is due', async () => {
    const { props } = await mountController();
    await tick(1);
    await tick(15);
    expect(props.setCurrentLayerSeek).not.toHaveBeenCalled();
    await tick(34);
    await tick(35);
    expect(props.setCurrentLayerSeek).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('replays from zero when started at the final frame', async () => {
    const { props } = await mountController({ currentLayerSeek: 149 });
    expect(props.setCurrentLayerSeek).toHaveBeenCalledExactlyOnceWith(0);
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('clamps a negative or nonnumeric initial seek to the project start', async () => {
    const { props } = await mountController({ currentLayerSeek: 'bad' });
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('seeks to the final native frame when a delayed animation crosses the end', async () => {
    const { props } = await mountController({ totalDuration: 1, audioLayers: [track()] });
    await tick(1300);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(29);
    expect(props.setIsVideoPreviewPlaying).toHaveBeenCalledWith(false);
    expect(props.onPlaybackActiveChange).toHaveBeenLastCalledWith(false);
    expect(audioElements[0].paused).toBe(true);
    expect(callbacks.size).toBe(0);
  });

  it('rebases the clock on a user seek and ignores the parent echo of an emitted frame', async () => {
    const { props, update } = await mountController();
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
    await update({ currentLayerSeek: 1 });
    await tick(68);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(2);
    await update({ currentLayerSeek: 90 });
    await tick(100);
    await tick(134);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(91);
  });

  it('accepts the latest parent frame echo after sustained playback without rewinding the clock', async () => {
    const { props, update } = await mountController();
    for (let frame = 1; frame <= 16; frame += 1) await tick(frame * 1000 / 30 + 0.01);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(16);
    await update({ currentLayerSeek: 16 });
    await tick(17 * 1000 / 30 + 0.01);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(17);
  });

  it('clamps external seeks beyond the timeline before advancing to its end', async () => {
    const { props, update } = await mountController({ totalDuration: 1 });
    await update({ currentLayerSeek: 999 });
    await tick(34);
    await tick(68);
    expect(props.setIsVideoPreviewPlaying).toHaveBeenCalledWith(false);
    expect(props.setCurrentLayerSeek.mock.calls.every(([frame]) => frame < 30)).toBe(true);
  });

  it('normalizes a nonnumeric user seek during active playback to the start', async () => {
    const { props, update } = await mountController({ currentLayerSeek: 60, onPlaybackActiveChange: undefined });
    await update({ currentLayerSeek: 'bad' });
    await tick(34);
    await tick(68);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('does not leak scheduled frames after unmount', async () => {
    const { props, unmount } = await mountController();
    const staleFrame = [...callbacks.values()][0];
    unmount();
    expect(callbacks.size).toBe(0);
    await act(async () => { staleFrame(1000); });
    expect(props.setCurrentLayerSeek).not.toHaveBeenCalled();
  });
});

describe('preview audio scheduling and media readiness', () => {
  it('loads only the lookahead window, starts at the trim offset, and pauses tracks after their end', async () => {
    const { props } = await mountController({ currentLayerSeek: 15, audioLayers: [
      track({ startTime: 0.25, endTime: 1, sourceTrimStartTime: 2 }),
      track({ url: 'https://media.example/later.wav', startTime: 2, duration: 1 }),
    ] });
    expect(audioElements[0]).toMatchObject({ currentTime: 2.25, preload: 'none', crossOrigin: 'anonymous', src: 'https://media.example/voice.wav' });
    expect(audioElements[0].load).toHaveBeenCalledOnce();
    expect(audioElements[0].play).toHaveBeenCalledOnce();
    expect(audioElements[1].load).not.toHaveBeenCalled();
    await tick(600);
    expect(audioElements[0].paused).toBe(true);
    expect(audioElements[1].play).not.toHaveBeenCalled();
    await tick(1700);
    expect(audioElements[1].load).toHaveBeenCalledOnce();
    expect(audioElements[1].play).toHaveBeenCalledOnce();
    expect(props.setIsVideoPreviewPlaying).not.toHaveBeenCalled();
  });

  it('does not disturb a media clock when the drift is within 200ms', async () => {
    await mountController({ audioLayers: [track()] });
    audioElements[0].currentTime = 0.1;
    await tick(34);
    expect(audioElements[0].currentTime).toBe(0.1);
    audioElements[0].currentTime = 3;
    await tick(68);
    expect(audioElements[0].currentTime).toBeCloseTo(2 / 30);
  });

  it.each(['canplay', 'loadeddata'])('waits for %s readiness before starting the video clock', async (event) => {
    autoReady = false;
    const { props } = await mountController({ audioLayers: [track()] });
    expect(callbacks.size).toBe(0);
    expect(audioElements[0].play).not.toHaveBeenCalled();
    expect(audioElements[0].load).toHaveBeenCalledOnce();
    audioElements[0].readyState = 3;
    await act(async () => { audioElements[0].dispatchEvent(new Event(event)); });
    expect(callbacks.size).toBe(1);
    expect(props.onPlaybackActiveChange).toHaveBeenLastCalledWith(true);
    expect(audioElements[0].play).toHaveBeenCalledOnce();
  });

  it('starts after the 250ms readiness timeout when media remains unavailable', async () => {
    autoReady = false;
    await mountController({ audioLayers: [track()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(callbacks.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callbacks.size).toBe(1);
    expect(audioElements[0].load).toHaveBeenCalledOnce();
  });

  it('does not resume a cancelled readiness wait after the component is paused', async () => {
    autoReady = false;
    const { props, update } = await mountController({ audioLayers: [track()] });
    await update({ isVideoPreviewPlaying: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(callbacks.size).toBe(0);
    expect(audioElements[0].play).not.toHaveBeenCalled();
    expect(props.onPlaybackActiveChange).not.toHaveBeenCalledWith(true);
  });

  it('omits disabled, pending, missing-source, and suspended audio without blocking video playback', async () => {
    const { update } = await mountController({ audioLayers: [
      track({ isEnabled: false }), track({ generationStatus: 'PENDING' }), { duration: 2 },
    ] });
    expect(audioElements).toHaveLength(0);
    expect(callbacks.size).toBe(1);
    await update({ audioLayers: [track()], suspendAudioPreview: true });
    expect(audioElements).toHaveLength(0);
    expect(callbacks.size).toBe(1);
  });

  it('keeps video playback moving after a media load failure and remembers failed sources', async () => {
    loadError = new Error('media unavailable');
    const { props, update } = await mountController({ audioLayers: [track()] });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('skipping failed audio source'), expect.objectContaining({ reason: 'load_error' }));
    expect(audioElements[0].play).not.toHaveBeenCalled();
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
    loadError = null;
    await update({ audioLayers: [track()] });
    expect(audioElements).toHaveLength(1);
  });

  it('handles a media error during buffering without waiting forever', async () => {
    autoReady = false;
    await mountController({ audioLayers: [track()] });
    audioElements[0].error = { code: 4, message: 'unsupported media' };
    await act(async () => { audioElements[0].dispatchEvent(new Event('error')); });
    expect(audioElements[0].play).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ errorCode: 4 }));
  });

  it('does not classify autoplay denial as a permanent source failure', async () => {
    playError = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' });
    const { props } = await mountController({ audioLayers: [track()] });
    expect(console.warn).not.toHaveBeenCalled();
    playError = null;
    await tick(34);
    expect(audioElements[0].play).toHaveBeenCalledTimes(2);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('remembers a genuine failed playback source and does not repeatedly warn or retry it', async () => {
    autoReady = false;
    const { update } = await mountController({ audioLayers: [track()] });
    const audio = audioElements[0];
    audio.error = { code: 3, message: 'decode error' };
    audio.readyState = 3;
    playError = Object.assign(new Error('decode error'), { name: 'NotSupportedError' });
    await act(async () => { audio.dispatchEvent(new Event('canplay')); });
    expect(console.warn).toHaveBeenCalledTimes(1);
    await tick(34);
    expect(audio.play).toHaveBeenCalledOnce();
    await act(async () => { audio.dispatchEvent(new Event('error')); });
    expect(console.warn).toHaveBeenCalledTimes(1);
    await update({ audioLayers: [track()] });
    expect(audioElements).toHaveLength(1);
  });

  it('normalizes malformed track bounds and negative trim before playback', async () => {
    await mountController({ audioLayers: [track({ startTime: 'bad', duration: '2', endTime: -1, sourceTrimStartTime: -5 })] });
    expect(audioElements[0].play).toHaveBeenCalledOnce();
    expect(audioElements[0].currentTime).toBe(0);
    await tick(2100);
    expect(audioElements[0].paused).toBe(true);
  });
});

describe('preview gain graph and cleanup', () => {
  it('separates base volume from music ducking and restores it when playback stops', async () => {
    const { update } = await mountController({ currentLayerSeek: 60, audioLayers: [
      track({ generationType: 'music', duration: 10, volume: 50 }),
      track({ startTime: 1, duration: 2 }),
    ] });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].gains.map(({ gain }) => gain.value)).toEqual([0.5, 0.225, 1]);
    expect(audioElements.map(({ volume }) => volume)).toEqual([1, 1]);
    await update({ isVideoPreviewPlaying: false });
    expect(contexts[0].gains.map(({ gain }) => gain.value)).toEqual([0.5, 1, 1]);
  });

  it('uses native element volume when ducking and amplification are unnecessary', async () => {
    await mountController({ applyAudioDucking: false, audioLayers: [track({ volume: 25 })] });
    expect(contexts).toHaveLength(0);
    expect(audioElements[0].volume).toBe(0.25);
  });

  it('keeps music at base gain when no other audio is present and suppresses ducking when disabled', async () => {
    const { update } = await mountController({ currentLayerSeek: 60, audioLayers: [track({ generationType: 'music', volume: 40 })] });
    expect(contexts[0].gains.map(({ gain }) => gain.value)).toEqual([0.4, 1]);
    await update({ applyAudioDucking: false, audioLayers: [
      track({ generationType: 'music', volume: 40 }), track({ startTime: 1, duration: 2 }),
    ] });
    await tick(34);
    expect(audioElements[1].volume).toBe(0.4);
  });

  it('amplifies above 100% in the gain graph when automatic ducking is disabled', async () => {
    await mountController({ applyAudioDucking: false, audioLayers: [track({ volume: 150 })] });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].gains[0].gain.value).toBe(1.5);
    expect(audioElements[0].volume).toBe(1);
  });

  it('starts the project clock while an autoplay-blocked AudioContext resume remains pending', async () => {
    contextState = 'suspended';
    resumePromise = new Promise(() => {});
    const { props } = await mountController({ audioLayers: [track()] });
    expect(contexts[0].resume).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('continues preview if AudioContext resume rejects and supports the legacy constructor', async () => {
    contextState = 'suspended';
    resumePromise = Promise.reject(new Error('gesture required'));
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', PreviewAudioContext);
    const { props } = await mountController({ audioLayers: [track()] });
    expect(contexts[0].resume).toHaveBeenCalledOnce();
    await tick(34);
    expect(props.setCurrentLayerSeek).toHaveBeenLastCalledWith(1);
  });

  it('applies manual volume automation instead of automatic ducking to music', async () => {
    await mountController({ currentLayerSeek: 60, audioLayers: [
      track({ generationType: 'music', duration: 4, manualVolumeAdjustmentEnabled: true, startVolume: 20, endVolume: 100 }),
      track({ startTime: 1, duration: 2 }),
    ] });
    expect(contexts[0].gains[0].gain.value).toBeCloseTo(0.6);
    expect(contexts[0].gains[1].gain.value).toBe(1);
  });

  it('keeps a manually muted track silent during real preview startup', async () => {
    await mountController({ audioLayers: [track({ manualVolumeAdjustmentEnabled: true, startVolume: 0, endVolume: 0 })] });
    expect(contexts[0].gains[0].gain.value).toBe(0);
  });

  it('falls back to element volume if a browser cannot create the audio graph', async () => {
    graphError = new Error('media source already connected');
    await mountController({ audioLayers: [track({ volume: 50 })] });
    expect(audioElements[0].volume).toBe(0.5);
    expect(audioElements[0].play).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);
  });

  it('retains manual music automation in browsers without AudioContext', async () => {
    vi.stubGlobal('AudioContext', undefined);
    await mountController({ currentLayerSeek: 60, audioLayers: [
      track({ generationType: 'music', duration: 4, volume: 100, manualVolumeAdjustmentEnabled: true, startVolume: 20, endVolume: 100 }),
    ] });
    expect(contexts).toHaveLength(0);
    expect(audioElements[0].volume).toBeCloseTo(0.6);
  });

  it('closes contexts, disconnects graph nodes, and releases media sources on unmount', async () => {
    const { unmount } = await mountController({ audioLayers: [track({ generationType: 'music' })] });
    const context = contexts[0];
    const audio = audioElements[0];
    context.sources[0].disconnect.mockImplementationOnce(() => { throw new Error('already disconnected'); });
    unmount();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(audio.src).toBe('');
    expect(context.gains.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
  });

  it('releases old media when the selected audio changes and leaves an already closed context alone', async () => {
    const { update, unmount } = await mountController({ audioLayers: [track()] });
    const oldAudio = audioElements[0];
    const oldContext = contexts[0];
    oldContext.state = 'closed';
    await update({ audioLayers: [track({ url: 'https://media.example/new.wav' })] });
    expect(oldAudio.pause).toHaveBeenCalled();
    expect(oldAudio.src).toBe('');
    expect(oldContext.close).not.toHaveBeenCalled();
    expect(audioElements).toHaveLength(2);
    expect(contexts).toHaveLength(2);
    await tick(34);
    expect(audioElements[1].src).toBe('https://media.example/new.wav');
    contexts[1].close.mockRejectedValueOnce(new Error('context already gone'));
    unmount();
    await act(async () => {});
    expect(contexts[1].close).toHaveBeenCalledOnce();
  });
});
