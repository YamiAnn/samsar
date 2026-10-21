import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } }) }));

const storageKey = 'samsar_google_tts_voice_catalog_v1';
let speakers;
beforeEach(async () => {
  vi.resetModules();
  speakers = await import('../../src/hooks/useGoogleTTSSpeakers.js');
  axios.get.mockReset();
});

describe('Google voice normalization', () => {
  it.each([
    ['en-US-Standard-A', 'female', 'F', 'Female', 'en-US Std A'],
    ['en-US-WaveNet-B', 'm', 'M', 'Male', 'en-US Wave B'],
    ['en-US-Neural2-C', 'NEUTRAL', null, 'Neutral', 'en-US N2 C'],
    ['en-US-Chirp-HD-D', '', null, 'Unspecified', 'en-US Chirp D'],
  ])('prepares %s for voice menus without losing its canonical ID', (name, gender, code, genderLabel, shortLabel) => {
    const details = speakers.getGoogleTTSVoiceDetails({ name, gender, languageCodes: ['en-US', null, ''], previewURL: '/voice-preview', naturalSampleRateHertz: 24000 });
    expect(details).toMatchObject({ provider: 'GOOGLE', value: name, voiceId: name, Gender: code, genderLabel, shortLabel, languageCodes: ['en-US'], previewURL: '/voice-preview', previewRequiresAuth: true, naturalSampleRateHertz: 24000 });
  });

  it('respects supplied labels and public absolute preview URLs', () => {
    expect(speakers.getGoogleTTSVoiceDetails({ value: ' voice ', name: ' Display ', voiceId: ' canonical ', label: ' Human label ', shortLabel: ' Short ', languageCode: ' th-TH ', Gender: 'F', previewURL: ' https://voices.test/one.mp3 ', previewRequiresAuth: false })).toMatchObject({ value: 'voice', voiceId: 'canonical', name: 'Display', label: 'Human label', shortLabel: 'Short', languageCode: 'th-TH', previewURL: 'https://voices.test/one.mp3', previewRequiresAuth: false });
    expect(speakers.getGoogleTTSVoiceDetails()).toMatchObject({ value: '', languageCode: '', languageCodes: [], naturalSampleRateHertz: null, voiceType: '', genderLabel: 'Unspecified' });
  });

  it('deduplicates voices within the same provider and preserves another provider with the same ID', () => {
    const base = [{ provider: 'OPENAI', value: 'one' }, { provider: 'GOOGLE', value: 'existing' }];
    const merged = speakers.mergeGoogleTTSSpeakers(base, [{ name: 'one' }, { name: 'one' }, { name: 'existing' }, { name: '' }, { value: 'two' }]);
    expect(merged.map(({ provider, value }) => `${provider}:${value}`)).toEqual(['OPENAI:one', 'GOOGLE:existing', 'GOOGLE:one', 'GOOGLE:two']);
    expect(base).toHaveLength(2);
    expect(speakers.mergeGoogleTTSSpeakers()).toEqual([]);
  });
});

describe('voice catalog lifecycle', () => {
  it('does not fetch while disabled and loads normalized choices when enabled', async () => {
    axios.get.mockResolvedValue({ data: { voices: [{ name: 'voice-a', gender: 'male' }, {}], source: 'live', generatedAt: '2026-10-20' } });
    const { result, rerender } = renderHook(({ enabled }) => speakers.useGoogleTTSSpeakers({ enabled }), { initialProps: { enabled: false } });
    expect(axios.get).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.googleSpeakers).toHaveLength(1);
    expect(result.current.googleVoiceMap['voice-a']).toMatchObject({ value: 'voice-a', Gender: 'M' });
    expect(result.current.source).toBe('live');
    expect(JSON.parse(localStorage.getItem(storageKey))).toMatchObject({ source: 'live', generatedAt: '2026-10-20', voices: [{ value: 'voice-a' }] });
    const second = renderHook(() => speakers.useGoogleTTSSpeakers());
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(axios.get).toHaveBeenCalledOnce();
    expect(second.result.current.googleSpeakers[0].value).toBe('voice-a');
  });

  it('shares one pending request between mounted voice selectors', async () => {
    let complete;
    axios.get.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const first = renderHook(() => speakers.useGoogleTTSSpeakers());
    const second = renderHook(() => speakers.useGoogleTTSSpeakers());
    expect(axios.get).toHaveBeenCalledOnce();
    first.unmount();
    await act(async () => { complete({ data: { voices: [{ name: 'shared' }] } }); });
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(second.result.current.googleSpeakers[0].value).toBe('shared');
  });

  it('keeps locally cached voices usable when the provider is offline', async () => {
    localStorage.setItem(storageKey, JSON.stringify({ voices: [{ name: 'cached' }] }));
    axios.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => speakers.useGoogleTTSSpeakers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.source).toBe('client-cache');
    expect(result.current.googleVoiceMap.cached.value).toBe('cached');
  });

  it.each(['not json', '{"voices":{}}'])('ignores a corrupt local catalog (%s) and exposes request failure', async (raw) => {
    localStorage.setItem(storageKey, raw);
    const failure = new Error('catalog unavailable');
    axios.get.mockRejectedValue(failure);
    const { result } = renderHook(() => speakers.useGoogleTTSSpeakers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(failure);
    expect(result.current.googleSpeakers).toEqual([]);
  });

  it('handles empty server payloads and normalizes an explicit server voice map', async () => {
    axios.get.mockResolvedValue({ data: { voices: null, voiceMap: { key: { name: 'Mapped', ssmlGender: 'F' } } } });
    const { result } = renderHook(() => speakers.useGoogleTTSSpeakers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.googleSpeakers).toEqual([]);
    expect(result.current.googleVoiceMap.key).toMatchObject({ value: 'Mapped', Gender: 'F' });
    expect(result.current.source).toBe('live');
  });

  it('survives cache quota failures after a successful network response', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    axios.get.mockResolvedValue({ data: { voices: [{ name: 'available' }] } });
    const { result } = renderHook(() => speakers.useGoogleTTSSpeakers());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.googleSpeakers[0].value).toBe('available');
    expect(result.current.error).toBeNull();
  });

  it('downloads an authenticated preview blob and rejects a missing preview before making requests', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    axios.get.mockResolvedValue({ data: blob });
    const create = vi.fn(() => 'blob:voice-preview');
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
    await expect(speakers.fetchGoogleTTSPreviewBlobUrl({ name: 'voice', previewURL: '/preview' })).resolves.toBe('blob:voice-preview');
    expect(axios.get).toHaveBeenCalledWith('/preview', { headers: { Authorization: 'Bearer test-token' }, responseType: 'blob' });
    expect(create).toHaveBeenCalledWith(blob);
    axios.get.mockClear();
    await expect(speakers.fetchGoogleTTSPreviewBlobUrl()).rejects.toThrow('preview URL is unavailable');
    expect(axios.get).not.toHaveBeenCalled();
  });
});
