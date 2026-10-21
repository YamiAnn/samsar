import { beforeEach, describe, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: client }));

import {
  extractDeploymentModelAvailability, extractDeploymentModelValuesFromCandidates,
  fetchDeploymentProviderConfig, filterOptionsForDeploymentModelValues,
  normalizeDeploymentModelValue,
} from '../../src/utils/deploymentProviders.js';

beforeEach(() => vi.clearAllMocks());

describe('deployment model availability payloads', () => {
  it('merges legacy and current candidate forms while preserving first occurrence order', () => {
    expect(extractDeploymentModelValuesFromCandidates([
      [' a ', { value: 'b' }, { key: 'c' }, { model: 'd' }, { modelKey: 'e' }],
      ['A', { value: ' B ' }, {}, null, 6, false, ' '],
      null, { value: 'ignored' }, 'ignored',
    ])).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
  it('returns an empty availability list for omitted candidates', () => {
    expect(extractDeploymentModelValuesFromCandidates()).toEqual([]);
    expect(extractDeploymentModelAvailability()).toEqual(expect.objectContaining({
      textToVideoImageModelValues: [], textToVideoVideoModelValues: [],
      imageListToVideoImageModelValues: [], imageListToVideoVideoModelValues: [],
      imageModelValues: [], imageEditModelValues: [], videoModelValues: [],
    }));
  });
  it.each([
    { deployment: { models: ['global'] } }, { available: { models: ['global'] } },
    { availableModels: ['global'] }, { available_models: ['global'] }, { models: ['global'] },
  ])('falls back to a global deployment registry when specialized capability lists are absent', (payload) => {
    const result = extractDeploymentModelAvailability(payload);
    for (const key of ['textToVideoImageModelValues', 'textToVideoVideoModelValues', 'imageListToVideoImageModelValues', 'imageListToVideoVideoModelValues', 'imageModelValues', 'imageEditModelValues', 'videoModelValues']) {
      expect(result[key]).toEqual(['GLOBAL']);
    }
  });
  it('keeps text-to-video and image-list capabilities separate and combines their editor menus', () => {
    const result = extractDeploymentModelAvailability({
      models: ['fallback'],
      text_to_video: { image_models: ['t-image'], video_models: ['t-video'] },
      imageListToVideo: { imageModels: ['i-image'], videoModels: ['i-video'] },
      imageEditModels: ['edit'],
    });
    expect(result).toEqual(expect.objectContaining({
      textToVideoImageModelValues: ['T-IMAGE'], textToVideoVideoModelValues: ['T-VIDEO'],
      imageListToVideoImageModelValues: ['I-IMAGE'], imageListToVideoVideoModelValues: ['I-VIDEO'],
      imageModelValues: ['T-IMAGE', 'I-IMAGE'], videoModelValues: ['T-VIDEO', 'I-VIDEO'], imageEditModelValues: ['EDIT'],
    }));
  });
  it('recognizes global uppercase, snake_case, and camelCase capability lists', () => {
    const result = extractDeploymentModelAvailability({
      IMAGE_MODELS: ['image-a'], image_models: ['image-b'], imageModels: ['image-c'],
      VIDEO_MODELS: ['video-a'], video_models: ['video-b'], videoModels: ['video-c'],
      IMAGE_EDIT_MODELS: ['edit'],
    });
    expect(result.imageModelValues).toEqual(['IMAGE-A', 'IMAGE-B', 'IMAGE-C']);
    expect(result.videoModelValues).toEqual(['VIDEO-A', 'VIDEO-B', 'VIDEO-C']);
    expect(result.imageEditModelValues).toEqual(['EDIT']);
  });
  it.each([null, undefined, {}, 7])('normalizes malformed model values to an empty key', (value) => {
    expect(normalizeDeploymentModelValue(value)).toBe('');
  });
  it('normalizes model values without removing punctuation needed by versioned keys', () => {
    expect(normalizeDeploymentModelValue('  veo3.1-i2v  ')).toBe('VEO3.1-I2V');
  });
});

describe('deployment option filtering', () => {
  it('normalizes option keys and allow-list entries without changing option objects', () => {
    const options = [{ value: 'model-a', label: 'A' }, { key: 'MODEL-B' }, ' model-c ', { value: 'not-allowed' }];
    const result = filterOptionsForDeploymentModelValues(options, [' MODEL-A ', 'model-b', 'MODEL-C', null]);
    expect(result).toEqual(options.slice(0, 3));
    expect(result[0]).toBe(options[0]);
    expect(options).toHaveLength(4);
  });
  it('uses a custom option accessor when a menu stores ids outside value/key', () => {
    const options = [{ id: 'a' }, { id: 'b' }];
    expect(filterOptionsForDeploymentModelValues(options, ['B'], (option) => option.id)).toEqual([options[1]]);
  });
  it('fails closed when no deployment model list has been loaded', () => {
    expect(filterOptionsForDeploymentModelValues([{ value: 'a' }], [])).toEqual([]);
    expect(filterOptionsForDeploymentModelValues()).toEqual([]);
  });
});

describe('deployment capability API', () => {
  it('passes request credentials and returns the backend capability document', async () => {
    const data = { models: ['configured'] };
    const headers = { headers: { Authorization: 'Bearer test-owner' } };
    client.get.mockResolvedValue({ data });
    await expect(fetchDeploymentProviderConfig('/api', headers)).resolves.toBe(data);
    expect(client.get).toHaveBeenCalledExactlyOnceWith('/api/v1/video/supported_models', headers);
  });
  it('returns an empty capability document when the backend body is absent', async () => {
    client.get.mockResolvedValue({});
    await expect(fetchDeploymentProviderConfig('/api')).resolves.toEqual({});
  });
  it('propagates request failures to the caller so it can fail closed', async () => {
    const failure = new Error('capabilities unavailable');
    client.get.mockRejectedValue(failure);
    await expect(fetchDeploymentProviderConfig('/api')).rejects.toBe(failure);
  });
});
