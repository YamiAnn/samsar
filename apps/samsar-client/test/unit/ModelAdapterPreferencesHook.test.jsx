import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const deployment = vi.hoisted(() => ({ standalone: true }));
const refresh = vi.hoisted(() => vi.fn().mockResolvedValue());
vi.mock('axios', () => ({ default: { get: vi.fn(), put: vi.fn(), isCancel: vi.fn(() => false) } }));
vi.mock('../../src/utils/environment.jsx', () => ({ get IS_STANDALONE_DEPLOYMENT() { return deployment.standalone; } }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: () => ({ headers: { Authorization: 'Bearer test-token' } }) }));
vi.mock('../../src/utils/modelAvailabilityRefresh.mjs', () => ({ refreshModelAvailabilityCaches: refresh }));

let useModelAdapterPreferences;
const payload = { stages: [{ key: 'image', models: [{ modelKey: 'flux', availableAdapters: ['fal', 'native'], preference: ['native', 'fal'] }] }], updatedAt: '2026-10-20' };
beforeEach(async () => {
  vi.resetModules();
  ({ useModelAdapterPreferences } = await import('../../src/hooks/useModelAdapterPreferences.js'));
  axios.get.mockReset().mockResolvedValue({ data: payload });
  axios.put.mockReset().mockResolvedValue({ data: payload });
  axios.isCancel.mockReturnValue(false);
  refresh.mockReset().mockResolvedValue();
  deployment.standalone = true;
});

describe('model adapter account preferences', () => {
  it('disables loading and rejects writes when access is disabled', async () => {
    const { result } = renderHook(() => useModelAdapterPreferences());
    expect(result.current).toMatchObject({ stages: [], updatedAt: null, isLoading: false, isSaving: false, error: null });
    await act(async () => { await expect(result.current.reload()).resolves.toEqual({ stages: [], updatedAt: null }); });
    await expect(result.current.savePreferences([])).rejects.toThrow('unavailable');
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('normalizes the authenticated response and aborts its read when the panel unmounts', async () => {
    const { result, unmount } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.stages[0].models[0]).toMatchObject({ modelKey: 'flux', label: 'flux', availableAdapters: [{ key: 'fal', label: 'fal' }, { key: 'native', label: 'native' }], preference: ['native', 'fal'] });
    const [, config] = axios.get.mock.calls[0];
    expect(config.headers.Authorization).toBe('Bearer test-token');
    expect(config.signal.aborted).toBe(false);
    unmount();
    expect(config.signal.aborted).toBe(true);
  });

  it('persists provider priority, exposes saving state, and refreshes standalone availability', async () => {
    let complete;
    axios.put.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let saving;
    act(() => { saving = result.current.savePreferences(result.current.stages); });
    expect(result.current.isSaving).toBe(true);
    expect(axios.put).toHaveBeenCalledWith('/users/model_adapters', { modelProviderPriority: { flux: ['native', 'fal'] } }, { headers: { Authorization: 'Bearer test-token' } });
    await act(async () => { complete({ data: { stages: [], updatedAt: 'saved' } }); await saving; });
    expect(result.current).toMatchObject({ stages: [], updatedAt: 'saved', isSaving: false, error: null });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh deployment configuration after a hosted save', async () => {
    deployment.standalone = false;
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.savePreferences(result.current.stages); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('exposes loading failures and allows a successful explicit reload', async () => {
    const failure = new Error('Network down');
    axios.get.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.isLoading).toBe(false);
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).toBeNull();
    expect(result.current.stages).toHaveLength(1);
  });

  it.each([{ code: 'ERR_CANCELED' }, { name: 'CanceledError' }])('does not show expected request cancellation as a user error (%s)', async (failure) => {
    axios.get.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('retains loaded preferences after a failed save and exposes the failure to its caller', async () => {
    const failure = new Error('Save rejected');
    axios.put.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await expect(result.current.savePreferences(result.current.stages)).rejects.toBe(failure); });
    expect(result.current.stages[0].models[0].modelKey).toBe('flux');
    expect(result.current.error).toBe(failure);
    expect(result.current.isSaving).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('resets account data and aborts the request when access is revoked', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useModelAdapterPreferences({ enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.stages).toHaveLength(1));
    const signal = axios.get.mock.calls[0][1].signal;
    rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    expect(result.current.stages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(false);
  });

  it('does not let an older reload overwrite a newer preference response', async () => {
    let completeOld;
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    axios.get.mockReturnValueOnce(new Promise((resolve) => { completeOld = resolve; }));
    axios.get.mockResolvedValueOnce({ data: { stages: [], updatedAt: 'newer' } });
    let older;
    act(() => { older = result.current.reload(); });
    await act(async () => { await result.current.reload(); });
    await act(async () => { completeOld({ data: { ...payload, updatedAt: 'older' } }); await older; });
    expect(result.current.updatedAt).toBe('newer');
  });

  it('does not restore preferences from an aborted initial read after access is revoked', async () => {
    let complete;
    axios.get.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const { result, rerender } = renderHook(({ enabled }) => useModelAdapterPreferences({ enabled }), { initialProps: { enabled: true } });
    rerender({ enabled: false });
    await act(async () => { complete({ data: payload }); });
    expect(result.current.stages).toEqual([]);
    expect(result.current.updatedAt).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not overwrite a completed save with a read that started before it', async () => {
    const { result } = renderHook(() => useModelAdapterPreferences({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let completeRead;
    axios.get.mockReturnValueOnce(new Promise((resolve) => { completeRead = resolve; }));
    axios.put.mockResolvedValueOnce({ data: { ...payload, updatedAt: 'saved' } });
    let reading;
    act(() => { reading = result.current.reload(); });
    await act(async () => { await result.current.savePreferences(result.current.stages); });
    await act(async () => { completeRead({ data: { ...payload, updatedAt: 'before-save' } }); await reading; });
    expect(result.current.updatedAt).toBe('saved');
    expect(result.current.isLoading).toBe(false);
  });
});
