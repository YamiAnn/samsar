import { describe, expect, it } from 'vitest';
import {
  getModelPriceForAspect, getVideoGenerationModelDropdownData, getVideoGenerationModelMeta,
} from '../../src/components/video/util/videoGenerationModelOptions.js';
import {
  EXPRESS_VIDEO_CREDITS_PER_SECOND_BY_MODEL,
  getExpressVideoCreditsPerSecond, getExpressVideoCreditsPerSecondForRateClass,
  getExpressVideoPricingDistributionPerSecond, getExpressVideoPricingDistributionPerSecondForRateClass,
  normalizeExpressVideoPricingRateClass,
} from '../../src/constants/pricing/ExpressVideoPricingDistribution.js';

describe('published model registry integration', () => {
  it('offers Runway in text and image generation while retaining Veo capability separation', () => {
    const text = getVideoGenerationModelDropdownData({ mode: 'text' });
    const image = getVideoGenerationModelDropdownData({ mode: 'image' });
    expect(text.availableModelKeys[0]).toBe('RUNWAYML');
    expect(image.availableModelKeys[0]).toBe('RUNWAYML');
    expect(text.availableModelKeys).toContain('VEO3.1');
    expect(text.availableModelKeys).not.toContain('VEO3.1I2V');
    expect(image.availableModelKeys).toContain('VEO3.1I2V');
    expect(image.availableModelKeys).not.toContain('VEO3.1');
  });
  it('offers the configured Veo first/last frame model only for an adjacent image pair', () => {
    const currentLayer = { _id: 'one', imageSession: { activeItemList: [{ type: 'image', src: '/one.png' }] } };
    const next = { _id: 'two', imageSession: { activeItemList: [{ type: 'image', src: '/two.png' }] } };
    const params = { mode: 'image', currentLayer, sessionDetails: { layers: [currentLayer, next] } };
    expect(getVideoGenerationModelDropdownData(params).availableModelKeys).toContain('VEO3.1FLIV');
    expect(getVideoGenerationModelDropdownData({ ...params, sessionDetails: { layers: [currentLayer] } }).availableModelKeys).not.toContain('VEO3.1FLIV');
  });
  it.each(['16:9', '9:16'])('resolves a usable Runway rate for the %s editor aspect', (aspect) => {
    const metadata = getVideoGenerationModelMeta('RUNWAYML');
    const price = getModelPriceForAspect(metadata.pricing, aspect);
    expect(metadata.modelDef.supportedAspectRatios).toContain(aspect);
    expect(price.aspectRatio).toBe(aspect);
    expect(price.price).toBeGreaterThan(0);
    expect(price.price).toBe(getExpressVideoCreditsPerSecond('RUNWAYML'));
  });
});

describe('express video credit accounting', () => {
  it.each(Object.entries(EXPRESS_VIDEO_CREDITS_PER_SECOND_BY_MODEL))('accounts for all charge components in %s without negative credit costs', (model, total) => {
    const distribution = getExpressVideoPricingDistributionPerSecond(model);
    const { total: distributionTotal, ...components } = distribution;
    expect(distributionTotal).toBe(total);
    expect(Object.values(components).reduce((sum, value) => sum + value, 0)).toBe(total);
    expect(Object.values(components).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });
  it('normalizes a model key consistently across total and distribution lookups', () => {
    expect(getExpressVideoCreditsPerSecond(' runwayml ')).toBe(30);
    expect(getExpressVideoPricingDistributionPerSecond(' runwayml ').total).toBe(30);
  });
  it.each([null, undefined, '', 'missing', 6])('does not invent a rate for an unrecognized model %s', (model) => {
    expect(getExpressVideoCreditsPerSecond(model)).toBeNull();
    expect(getExpressVideoPricingDistributionPerSecond(model)).toBeNull();
    expect(getExpressVideoPricingDistributionPerSecondForRateClass(model, 'agent')).toBeNull();
  });
  it.each([
    ['agent', 'agent'], [' VIDGENIE ', 'vidgenie'], ['studio', 'studio'],
    ['', 'studio'], [null, 'studio'], ['unexpected', 'studio'], [1, 'studio'],
  ])('normalizes operation rate class %s', (input, expected) => {
    expect(normalizeExpressVideoPricingRateClass(input)).toBe(expected);
  });
  it.each(['agent', 'vidgenie', ' AGENT '])('applies the Seedance 2.5 %s rate without changing its shared Studio tariff', (rateClass) => {
    const base = getExpressVideoPricingDistributionPerSecond('SEEDANCE2.5I2V');
    const tailored = getExpressVideoPricingDistributionPerSecondForRateClass(' seedance2.5i2v ', rateClass);
    expect(getExpressVideoCreditsPerSecondForRateClass(' seedance2.5i2v ', rateClass)).toBe(60);
    expect(tailored.total).toBe(60);
    expect(tailored.video - base.video).toBe(10);
    expect(tailored.pipeline).toBe(base.pipeline);
    expect(base.total).toBe(50);
    expect(getExpressVideoCreditsPerSecondForRateClass('SEEDANCE2.5I2V')).toBe(50);
  });
  it('uses standard model pricing for other models and unknown rate classes', () => {
    expect(getExpressVideoCreditsPerSecondForRateClass('RUNWAYML', 'agent')).toBe(30);
    expect(getExpressVideoCreditsPerSecondForRateClass('SEEDANCE2.5I2V', 'unknown')).toBe(50);
    const distribution = getExpressVideoPricingDistributionPerSecondForRateClass('RUNWAYML');
    distribution.video = 0;
    expect(getExpressVideoPricingDistributionPerSecond('RUNWAYML').video).toBe(14);
  });
});
