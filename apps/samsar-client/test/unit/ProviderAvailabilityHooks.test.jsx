import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const deployment = vi.hoisted(() => ({ standalone: true }));
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../../src/utils/environment.jsx', () => ({ get IS_STANDALONE_DEPLOYMENT() { return deployment.standalone; } }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } }) }));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetModules();
  deployment.standalone = true;
  axios.get.mockReset().mockResolvedValue({ data: {} });
});

describe('deployment image and video availability', () => {
  async function load() {
    const { useDeploymentModelAvailability } = await import('../../src/hooks/useDeploymentModelAvailability.js');
    const { refreshModelAvailabilityCaches } = await import('../../src/utils/modelAvailabilityRefresh.mjs');
    return { useDeploymentModelAvailability, refreshModelAvailabilityCaches };
  }

  it('does not contact the provider catalog in hosted mode and permits hosted subtitles', async () => {
    deployment.standalone = false;
    const { useDeploymentModelAvailability } = await load();
    const { result } = renderHook(useDeploymentModelAvailability);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toMatchObject({ isStandaloneDeployment: false, imageModelValues: [], hasSubtitleGenerationCredentials: true, error: null });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('shares pending reads, normalizes configured models, and caches settled availability', async () => {
    const pending = deferred();
    axios.get.mockReturnValue(pending.promise);
    const { useDeploymentModelAvailability } = await load();
    const first = renderHook(useDeploymentModelAvailability);
    const second = renderHook(useDeploymentModelAvailability);
    expect(first.result.current.isLoading).toBe(true);
    expect(axios.get).toHaveBeenCalledOnce();
    expect(axios.get).toHaveBeenCalledWith('/v1/video/supported_models', { headers: { Authorization: 'Bearer test-token' } });
    await act(async () => { pending.resolve({ data: { image_models: [' flux '], video_models: ['veo'], deployment: { providers: ['openai'] } } }); });
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(first.result.current.imageModelValues).toEqual(['FLUX']);
    expect(second.result.current.videoModelValues).toEqual(['VEO']);
    expect(second.result.current.hasSubtitleGenerationCredentials).toBe(true);
    const third = renderHook(useDeploymentModelAvailability);
    expect(third.result.current.isLoading).toBe(false);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('fails closed with an exposed error and recovers after catalog refresh', async () => {
    const failure = new Error('configuration offline');
    axios.get.mockRejectedValueOnce(failure);
    const { useDeploymentModelAvailability, refreshModelAvailabilityCaches } = await load();
    const { result } = renderHook(useDeploymentModelAvailability);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.imageModelValues).toEqual([]);
    expect(result.current.error).toBe(failure);
    expect(result.current.hasSubtitleGenerationCredentials).toBe(false);
    axios.get.mockResolvedValue({ data: { image_models: ['new-image'] } });
    await act(async () => { await refreshModelAvailabilityCaches(); });
    expect(result.current.imageModelValues).toEqual(['NEW-IMAGE']);
    expect(result.current.error).toBeNull();
  });

  it('prevents an old response from replacing refreshed catalog data in a mounted consumer or cache', async () => {
    const old = deferred();
    const newer = deferred();
    axios.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const { useDeploymentModelAvailability, refreshModelAvailabilityCaches } = await load();
    const { result } = renderHook(useDeploymentModelAvailability);
    let refreshing;
    act(() => { refreshing = refreshModelAvailabilityCaches(); });
    await act(async () => { newer.resolve({ data: { image_models: ['new'] } }); await refreshing; });
    await act(async () => { old.resolve({ data: { image_models: ['old'] } }); await old.promise; });
    expect(result.current.imageModelValues).toEqual(['NEW']);
    const latest = renderHook(useDeploymentModelAvailability);
    expect(latest.result.current.imageModelValues).toEqual(['NEW']);
  });

  it('allows a shared catalog read to finish after one subscriber unmounts', async () => {
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    const { useDeploymentModelAvailability } = await load();
    const first = renderHook(useDeploymentModelAvailability);
    const second = renderHook(useDeploymentModelAvailability);
    first.unmount();
    await act(async () => { pending.resolve({ data: { video_models: ['scene'] } }); });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(second.result.current.videoModelValues).toEqual(['SCENE']);
  });
});

describe('deployment inference availability', () => {
  async function load() {
    const { useInferenceModelAvailability } = await import('../../src/hooks/useInferenceModelAvailability.js');
    const { refreshModelAvailabilityCaches } = await import('../../src/utils/modelAvailabilityRefresh.mjs');
    return { useInferenceModelAvailability, refreshModelAvailabilityCaches };
  }

  it('exposes configured hosted choices without requesting deployment configuration', async () => {
    deployment.standalone = false;
    const { useInferenceModelAvailability } = await load();
    const { result } = renderHook(useInferenceModelAvailability);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasConfiguredInferenceModels).toBe(true);
    expect(result.current.inferenceModelOptions.length).toBeGreaterThan(0);
    expect(result.current.assistantModelOptions.length).toBeGreaterThan(0);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('keeps an empty standalone deployment closed and exposes a failed catalog read', async () => {
    const failure = new Error('catalog unavailable');
    axios.get.mockRejectedValue(failure);
    const { useInferenceModelAvailability } = await load();
    const { result } = renderHook(useInferenceModelAvailability);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(failure);
    expect(result.current.hasConfiguredInferenceModels).toBe(false);
    expect(result.current.inferenceModelOptions).toEqual([]);
    expect(result.current.assistantModelOptions).toEqual([]);
  });

  it('loads provider-proven inference choices once across multiple selectors', async () => {
    axios.get.mockResolvedValue({ data: { deployment: { providers: ['openai'] } } });
    const { useInferenceModelAvailability } = await load();
    const first = renderHook(useInferenceModelAvailability);
    const second = renderHook(useInferenceModelAvailability);
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(first.result.current.hasConfiguredInferenceModels).toBe(true);
    expect(first.result.current.modelValues.length).toBeGreaterThan(0);
    expect(second.result.current.inferenceModelOptions.length).toBeGreaterThan(0);
    expect(axios.get).toHaveBeenCalledOnce();
    const third = renderHook(useInferenceModelAvailability);
    expect(third.result.current.isLoading).toBe(false);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('rejects an older in-flight configuration after a refresh removes all providers', async () => {
    const old = deferred();
    axios.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: {} });
    const { useInferenceModelAvailability, refreshModelAvailabilityCaches } = await load();
    const { result } = renderHook(useInferenceModelAvailability);
    await act(async () => { await refreshModelAvailabilityCaches(); });
    await act(async () => { old.resolve({ data: { deployment: { providers: ['openai'] } } }); await old.promise; });
    expect(result.current.hasConfiguredInferenceModels).toBe(false);
    expect(result.current.modelValues).toEqual([]);
    const another = renderHook(useInferenceModelAvailability);
    expect(another.result.current.modelValues).toEqual([]);
  });

  it('does not update an unmounted selector when its catalog request finishes', async () => {
    const pending = deferred();
    axios.get.mockReturnValue(pending.promise);
    const { useInferenceModelAvailability } = await load();
    const { unmount } = renderHook(useInferenceModelAvailability);
    unmount();
    await act(async () => { pending.resolve({ data: {} }); });
    expect(axios.get).toHaveBeenCalledOnce();
  });
});

describe('audio provider availability', () => {
  it('avoids deployment catalog requests for hosted clients', async () => {
    deployment.standalone = false;
    const { useAudioProviderAvailability } = await import('../../src/hooks/useAudioProviderAvailability.js');
    const { result } = renderHook(useAudioProviderAvailability);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.audioAvailability).toMatchObject({ ttsProviders: [], musicProviders: [] });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('shares and caches normalized provider rules between mounted audio menus', async () => {
    const pending = deferred();
    axios.get.mockReturnValue(pending.promise);
    const { useAudioProviderAvailability } = await import('../../src/hooks/useAudioProviderAvailability.js');
    const first = renderHook(useAudioProviderAvailability);
    const second = renderHook(useAudioProviderAvailability);
    expect(axios.get).toHaveBeenCalledOnce();
    first.unmount();
    await act(async () => { pending.resolve({ data: { audio: { ttsProviders: ['google'], musicProviders: ['lyria3'], allowAllTtsSpeakers: false } } }); });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(second.result.current.audioAvailability).toMatchObject({ ttsProviders: ['GOOGLE'], musicProviders: ['LYRIA3'], allowAllTtsSpeakers: false });
    const third = renderHook(useAudioProviderAvailability);
    expect(third.result.current.isLoading).toBe(false);
    expect(axios.get).toHaveBeenCalledOnce();
  });

  it('fails closed after a server error and retries for a later consumer', async () => {
    axios.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { audio: { ttsProviders: ['openai'] } } });
    const { useAudioProviderAvailability } = await import('../../src/hooks/useAudioProviderAvailability.js');
    const first = renderHook(useAudioProviderAvailability);
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(first.result.current.audioAvailability.ttsProviders).toEqual([]);
    const retry = renderHook(useAudioProviderAvailability);
    await waitFor(() => expect(retry.result.current.isLoading).toBe(false));
    expect(retry.result.current.audioAvailability.ttsProviders).toEqual(['OPENAI']);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
