import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ models: [], prices: [] }));
vi.mock('../../src/constants/Types.ts', () => ({ VIDEO_GENERATION_MODEL_TYPES: fixtures.models }));
vi.mock('../../src/constants/ModelPrices.jsx', () => ({ VIDEO_MODEL_PRICES: fixtures.prices }));

import {
  getModelPriceForAspect, getVideoGenerationModelDropdownData,
  getVideoGenerationModelMeta,
} from '../../src/components/video/util/videoGenerationModelOptions.js';

const imageItem = { type: 'image', src: '/image.png' };
const scene = (id, items = [imageItem]) => ({ _id: id, imageSession: { activeItemList: items } });

beforeEach(() => {
  fixtures.models.splice(0, fixtures.models.length,
    { key: 'UNPRICED', isImageToVideoModel: true, isTextToVideoModel: true },
    { key: 'IMAGE', isImageToVideoModel: true },
    { key: 'TEXT', isTextToVideoModel: true },
    { key: 'LEGACY_IMAGE', isImgToVidModel: true },
    { key: 'LEGACY_TEXT', isTextToVidModel: true },
    { key: 'PRICING_FLAGS' },
    { key: 'FIRST_LAST', isFirstLastFrameToVideoModel: true },
    { key: 'STANDALONE', standaloneOnly: true, isImageToVideoModel: true },
    { key: 'RUNWAYML', isImageToVideoModel: true },
    { key: 'VEO3.1I2V', isImageToVideoModel: true },
    { key: 'VEO3.1I2VFAST', isImageToVideoModel: true },
    { key: 'NO_CAPABILITY' },
  );
  fixtures.prices.splice(0, fixtures.prices.length,
    ...fixtures.models.filter(({ key }) => key !== 'UNPRICED').map(({ key }) => ({
      key, prices: [{ aspectRatio: '16:9', price: 10 }],
      ...(key === 'PRICING_FLAGS' ? { isImageToVideoModel: true, isTextToVidModel: true } : {}),
    })),
  );
});

describe('video generation model dropdown', () => {
  it('uses image capabilities when the canvas contains an image', () => {
    const result = getVideoGenerationModelDropdownData({ activeItemList: [imageItem] });
    expect(result).toEqual(expect.objectContaining({ hasImageItem: true, dropdownMode: 'image', supportsFirstLastFrameToVideo: false }));
    expect(result.availableModelKeys).toEqual(['RUNWAYML', 'VEO3.1I2V', 'VEO3.1I2VFAST', 'IMAGE', 'LEGACY_IMAGE', 'PRICING_FLAGS']);
    expect(result.availableModelKeysSignature).toBe(result.availableModelKeys.join('|'));
    expect(result.availableModels.map(({ key }) => key)).toEqual(result.availableModelKeys);
  });
  it.each([undefined, null, {}, [], [{ type: 'text' }]])('defaults an image-free canvas to text generation', (items) => {
    const result = getVideoGenerationModelDropdownData({ activeItemList: items });
    expect(result.hasImageItem).toBe(false);
    expect(result.dropdownMode).toBe('text');
    expect(result.availableModelKeys).toEqual(['TEXT', 'LEGACY_TEXT', 'PRICING_FLAGS']);
  });
  it('honors explicit text mode even on a populated image canvas', () => {
    const result = getVideoGenerationModelDropdownData({ activeItemList: [imageItem], mode: 'text' });
    expect(result.hasImageItem).toBe(true);
    expect(result.availableModelKeys).toEqual(['TEXT', 'LEGACY_TEXT', 'PRICING_FLAGS']);
  });
  it('honors explicit image mode and falls back from an unrecognized mode', () => {
    expect(getVideoGenerationModelDropdownData({ activeItemList: [], mode: 'image' }).dropdownMode).toBe('image');
    expect(getVideoGenerationModelDropdownData({ activeItemList: [], mode: 'unknown' }).dropdownMode).toBe('text');
  });
  it('only lists standalone-only models in standalone deployments', () => {
    expect(getVideoGenerationModelDropdownData({ mode: 'image' }).availableModelKeys).not.toContain('STANDALONE');
    expect(getVideoGenerationModelDropdownData({ mode: 'image', isStandaloneDeployment: true }).availableModelKeys).toContain('STANDALONE');
  });
  it('permits provider-billed models without a local price table', () => {
    fixtures.prices.push({ key: 'UNPRICED', providerBilled: true });
    expect(getVideoGenerationModelDropdownData({ mode: 'text' }).availableModelKeys).toContain('UNPRICED');
  });
  it('omits models with an empty price table and models without capabilities', () => {
    fixtures.prices.find(({ key }) => key === 'IMAGE').prices = [];
    const keys = getVideoGenerationModelDropdownData({ mode: 'image' }).availableModelKeys;
    expect(keys).not.toContain('IMAGE');
    expect(keys).not.toContain('NO_CAPABILITY');
    expect(keys).not.toContain('UNPRICED');
  });
  it('preserves registry order among models of equal priority without mutating the registry', () => {
    const before = fixtures.models.map(({ key }) => key);
    getVideoGenerationModelDropdownData({ mode: 'image' });
    expect(fixtures.models.map(({ key }) => key)).toEqual(before);
  });
  it('prefers current false capability flags over legacy true flags', () => {
    fixtures.models.push({ key: 'EXPLICIT_FALSE', isImageToVideoModel: false, isImgToVidModel: true, isTextToVideoModel: false, isTextToVidModel: true });
    fixtures.prices.push({ key: 'EXPLICIT_FALSE', providerBilled: true });
    expect(getVideoGenerationModelDropdownData({ mode: 'image' }).availableModelKeys).not.toContain('EXPLICIT_FALSE');
    expect(getVideoGenerationModelDropdownData({ mode: 'text' }).availableModelKeys).not.toContain('EXPLICIT_FALSE');
  });
});

describe('first and last frame generation eligibility', () => {
  it('offers interpolation only with two consecutive visible starting images', () => {
    const currentLayer = scene('one');
    const result = getVideoGenerationModelDropdownData({ activeItemList: [imageItem], currentLayer, sessionDetails: { layers: [currentLayer, scene('two')] } });
    expect(result.supportsFirstLastFrameToVideo).toBe(true);
    expect(result.availableModelKeys).toContain('FIRST_LAST');
  });
  it.each(['aiVideoLayer', 'aiVideoRemoteLink', 'hasAiVideoLayer', 'aiVideoGenerationPending'])('blocks interpolation while the current scene has %s', (flag) => {
    const currentLayer = { ...scene('one'), [flag]: true };
    const result = getVideoGenerationModelDropdownData({ mode: 'image', currentLayer, sessionDetails: { layers: [currentLayer, scene('two')] } });
    expect(result.supportsFirstLastFrameToVideo).toBe(false);
    expect(result.availableModelKeys).not.toContain('FIRST_LAST');
  });
  it.each([
    ['hidden current image', scene('one', [{ ...imageItem, isHidden: true }]), scene('two')],
    ['missing current source', scene('one', [{ type: 'image' }]), scene('two')],
    ['hidden next image', scene('one'), scene('two', [{ ...imageItem, isHidden: true }])],
    ['text-only next scene', scene('one'), scene('two', [{ type: 'text', src: '/text.png' }])],
    ['empty next scene', scene('one'), scene('two', [])],
  ])('blocks interpolation for %s', (_name, currentLayer, nextLayer) => {
    expect(getVideoGenerationModelDropdownData({ mode: 'image', currentLayer, sessionDetails: { layers: [currentLayer, nextLayer] } }).supportsFirstLastFrameToVideo).toBe(false);
  });
  it('does not offer interpolation for express sessions or the final scene', () => {
    const currentLayer = scene('one');
    expect(getVideoGenerationModelDropdownData({ mode: 'image', currentLayer, sessionDetails: { layers: [currentLayer, scene('two')], isExpressGeneration: true } }).supportsFirstLastFrameToVideo).toBe(false);
    expect(getVideoGenerationModelDropdownData({ mode: 'image', currentLayer, sessionDetails: { layers: [currentLayer] } }).supportsFirstLastFrameToVideo).toBe(false);
  });
  it('falls back to the active canvas only when the current scene has no item array', () => {
    const currentLayer = { _id: 'one' };
    const details = { layers: [currentLayer, scene('two')] };
    expect(getVideoGenerationModelDropdownData({ mode: 'image', activeItemList: [imageItem], currentLayer, sessionDetails: details }).supportsFirstLastFrameToVideo).toBe(true);
    currentLayer.imageSession = { activeItemList: [] };
    expect(getVideoGenerationModelDropdownData({ mode: 'image', activeItemList: [imageItem], currentLayer, sessionDetails: details }).supportsFirstLastFrameToVideo).toBe(false);
  });
  it('matches database ids by their string value', () => {
    const currentLayer = scene({ toString: () => 'one' });
    const result = getVideoGenerationModelDropdownData({ mode: 'image', currentLayer, sessionDetails: { layers: [scene('one'), scene('two')] } });
    expect(result.supportsFirstLastFrameToVideo).toBe(true);
  });
  it('requires a known current scene and a valid session layer list', () => {
    expect(getVideoGenerationModelDropdownData({ mode: 'image', currentLayer: scene('absent'), sessionDetails: { layers: [scene('one'), scene('two')] } }).supportsFirstLastFrameToVideo).toBe(false);
    expect(getVideoGenerationModelDropdownData({ mode: 'image', currentLayer: {}, sessionDetails: { layers: 'invalid' } }).supportsFirstLastFrameToVideo).toBe(false);
  });
  it('does not expose first/last-frame models in text mode even with eligible scenes', () => {
    const currentLayer = scene('one');
    const result = getVideoGenerationModelDropdownData({ mode: 'text', currentLayer, sessionDetails: { layers: [currentLayer, scene('two')] } });
    expect(result.supportsFirstLastFrameToVideo).toBe(true);
    expect(result.availableModelKeys).not.toContain('FIRST_LAST');
  });
});

describe('video model metadata and aspect pricing', () => {
  it('resolves model capabilities from the definition and the pricing registry', () => {
    expect(getVideoGenerationModelMeta('IMAGE')).toEqual(expect.objectContaining({ modelDef: fixtures.models[1], supportsImageToVideo: true, supportsTextToVideo: false, supportsFirstLastFrameToVideo: false }));
    expect(getVideoGenerationModelMeta('PRICING_FLAGS')).toEqual(expect.objectContaining({ supportsImageToVideo: true, supportsTextToVideo: true }));
    expect(getVideoGenerationModelMeta('FIRST_LAST').supportsFirstLastFrameToVideo).toBe(true);
  });
  it('returns absent registry entries and false capabilities for unknown models', () => {
    expect(getVideoGenerationModelMeta('missing')).toEqual({ modelDef: undefined, pricing: undefined, supportsImageToVideo: false, supportsTextToVideo: false, supportsFirstLastFrameToVideo: false });
  });
  it('can identify first/last frame support stored only in pricing', () => {
    fixtures.prices.find(({ key }) => key === 'NO_CAPABILITY').isFirstLastFrameToVideoModel = true;
    expect(getVideoGenerationModelMeta('NO_CAPABILITY').supportsFirstLastFrameToVideo).toBe(true);
  });
  it.each([undefined, null, {}, { prices: [] }])('returns no price for missing or empty pricing', (pricing) => {
    expect(getModelPriceForAspect(pricing, '9:16')).toBeNull();
  });
  it('selects an exact aspect price and falls back to the first price', () => {
    const pricing = { prices: [{ aspectRatio: '16:9', price: 10 }, { aspectRatio: '9:16', price: 20 }] };
    expect(getModelPriceForAspect(pricing, '9:16')).toBe(pricing.prices[1]);
    expect(getModelPriceForAspect(pricing, '1:1')).toBe(pricing.prices[0]);
  });
});
