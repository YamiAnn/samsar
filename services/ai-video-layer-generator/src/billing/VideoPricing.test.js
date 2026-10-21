import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVideoCallCredits, videoBillingMode } from './VideoPricing.js';

for (const adapter of ['fal', 'gmicloud', 'runway', 'googleCloud', 'alibabaCloud', 'hailuo', 'custom']) {
  for (const model of ['video', 'SYNCLIPSYNC', 'MIRELOAI', 'MMAUDIOV2']) {
    test(`${adapter} ${model} charges the same margin on the actual receipt`, () => {
      assert.equal(calculateVideoCallCredits({ adapter, model, costUsd: 0.375 }).credits, 45);
      assert.equal(calculateVideoCallCredits({ adapter, model, costUsd: 0 }).credits, 0);
    });
  }
}

test('native Veo uses generated duration, audio, resolution and successful sample count', () => {
  const input = { adapter: 'googleCloud', model: 'veo-3.1-fast-generate-001', seconds: 8,
    resolution: '720p', generateAudio: false, outputCount: 2 };
  assert.equal(calculateVideoCallCredits(input).credits, 153.6);
  assert.equal(calculateVideoCallCredits({ ...input, generateAudio: true }).credits, 192);
  assert.equal(calculateVideoCallCredits({ ...input, generateAudio: true, resolution: '1080p' }).credits, 230.4);
  assert.equal(calculateVideoCallCredits({ ...input, model: 'veo-3.1-generate-001', generateAudio: true }).credits, 768);
  assert.throws(() => calculateVideoCallCredits({ ...input, outputCount: undefined }), /count/);
});

test('native Runway and Alibaba use the submitted configuration', () => {
  assert.equal(calculateVideoCallCredits({ adapter: 'runway', model: 'gen4.5', seconds: 5 }).credits, 72);
  assert.equal(calculateVideoCallCredits({ adapter: 'alibabaCloud', model: 'happyhorse-1.1-i2v', seconds: 10,
    resolution: '720P', region: 'international' }).credits, 168);
});

test('unknown or malformed charges cannot silently become free or use another adapter tariff', () => {
  for (const costUsd of [null, undefined, '', -1, NaN, Infinity, {}, false]) {
    assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', costUsd }), /Invalid/);
  }
  assert.throws(() => calculateVideoCallCredits({ adapter: 'gmicloud', model: 'RUNWAYML', seconds: 5 }), /not available/);
});

test('Docker runtime does not waive hosted production calls; standalone edition does', () => {
  assert.equal(videoBillingMode({ videoBillingPolicy: 'adapter' }, { SAMSAR_DEPLOYMENT_EDITION: 'production', SAMSAR_RUNTIME: 'docker' }), 'adapter');
  assert.equal(videoBillingMode({ videoBillingPolicy: 'adapter' }, { SAMSAR_DEPLOYMENT_EDITION: 'standalone' }), 'standalone');
  assert.equal(videoBillingMode({}, {}), 'legacy');
});
