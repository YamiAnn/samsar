import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaticVideoReceipt, calculateStaticVideoUsd, STATIC_VIDEO_TARIFF_VERSIONS } from './StaticVideoTariffs.js';
import { sealStaticVideoSubmission } from './StaticVideoSubmission.js';
import { calculateVideoCallCredits } from './VideoPricing.js';
import { GENBLAZE_VIDEO_MODELS, buildGenBlazeVideoRequest,
  buildGenBlazeVideoBillingConfiguration, generateGenBlazeVideoLayer } from '../base/GenBlazeVideoListener.js';

test('each supported GMI video model has a checked-in exact rate or explicit legacy exception', () => {
  const expectedRates = {
    'VEO3.1': 0.40, 'VEO3.1I2V': 0.40, 'VEO3.1FLIV': 0.40,
    'VEO3.1FAST': 0.15, 'VEO3.1I2VFAST': 0.15,
    SEEDANCEI2V: 0.051, 'SEEDANCE2.0I2V': 0.152, 'SEEDANCE2.5I2V': 0.231,
    KLINGIMGTOVID3PRO: 0.252, KLINGIMGTOVIDTURBO: 0.112,
    KLINGIMGTOVIDPRO: 0.098, 'KLINGIMGTOVID2.1MASTER': 0.28,
    'KLINGIMGTOVID2.1PRO': 0.098, 'KLINGIMGTOVID2.1STANDARD': 0.056,
    HAILUOPRO: null, HAPPYHORSEI2V: 0.14,
  };
  assert.deepEqual(Object.keys(expectedRates).sort(), [...GENBLAZE_VIDEO_MODELS].sort());
  for (const model of GENBLAZE_VIDEO_MODELS) {
    const input = { model, startImage: 'https://assets.example/first.png',
      endImage: 'https://assets.example/last.png', duration: 7, generateAudio: true };
    const request = buildGenBlazeVideoRequest(input);
    if (model === 'HAILUOPRO') {
      assert.equal(request.params.resolution, '1080P');
      assert.throws(() => buildStaticVideoReceipt(buildGenBlazeVideoBillingConfiguration(request)), /verified static tariff/);
      continue;
    }
    const receipt = buildStaticVideoReceipt(buildGenBlazeVideoBillingConfiguration(request));
    assert.equal(receipt.seconds, Number(request.params.duration), model);
    assert.equal(receipt.staticVideoTariffVersion, '2026-10-24', model);
    assert.equal(receipt.tariffRateUsd, expectedRates[model], model);
    assert.equal(calculateVideoCallCredits(receipt).credits,
      Math.round(Number(request.params.duration) * expectedRates[model] * 120 * 10_000) / 10_000, model);
    assert.ok(receipt.upstreamModel, model);
  }
});

test('GMI Hailuo preserves the normal completion charge until its 1080P tariff is verified', async () => {
  const payload = { model: 'HAILUOPRO', startImage: 'https://assets.example/first.png',
    videoBillingPolicy: 'adapter' };
  await generateGenBlazeVideoLayer(payload, {
    env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    persist: async () => assert.fail('Do not seal an unverified 1080P rate'),
    request: async () => ({ request_id: 'original' }),
  });
  assert.equal(payload.videoBillingNativeReceipt.pricingFallback, 'legacy_gmicloud_hailuo_reported_cost');
  for (const [costUsd, credits] of [[0, 0], [0.36, 43.2], [0.48, 57.6]]) {
    const billed = calculateVideoCallCredits({ ...payload.videoBillingNativeReceipt, costUsd });
    assert.equal(billed.credits, credits);
    assert.equal(billed.pricingFallback, 'legacy_gmicloud_hailuo_reported_cost');
    assert.equal(billed.tariffVerifiedOn, null);
  }
  assert.throws(() => calculateVideoCallCredits(payload.videoBillingNativeReceipt), /reported adapter charge/);
});

test('GMI audio/resolution tiers and duration buckets use account constants once', () => {
  const price = (model, fields) => calculateVideoCallCredits(buildStaticVideoReceipt({
    adapter: 'gmicloud', model, seconds: 5, ...fields,
  })).credits;
  assert.equal(price('VEO3.1I2VFAST', { resolution: '720p', generateAudio: false }), 60);
  assert.equal(price('VEO3.1I2VFAST', { resolution: '1080p', generateAudio: true }), 90);
  assert.equal(price('VEO3.1I2V', { resolution: '4k', generateAudio: true }), 360);
  assert.equal(price('KLINGIMGTOVID3PRO', { mode: 'pro', generateAudio: false }), 100.8);
  assert.equal(price('KLINGIMGTOVID3PRO', { mode: 'pro', generateAudio: true }), 151.2);
  assert.equal(price('HAPPYHORSEI2V', { resolution: '720P' }), 84);
  assert.equal(price('HAPPYHORSEI2V', { resolution: '1080P' }), 168);
  assert.equal(price('SEEDANCE2.5I2V', { seconds: 20, resolution: '720p' }), 554.4);
  assert.throws(() => price('SEEDANCE2.5I2V', { resolution: '1080p' }), /verified static tariff/);
});

test('sealed snapshots reject modified fields and retain the original dated rate', () => {
  const input = { adapter: 'runway', model: 'gen4.5', seconds: 5 };
  const sealed = buildStaticVideoReceipt(input);
  for (const changes of [{ tariffRateUsd: 5 }, { tariffUnit: 'video' }, { submittedQuantity: 10 }]) {
    assert.throws(() => calculateStaticVideoUsd({ ...sealed, ...changes }), /sealed static video tariff/);
  }
  const versions = { ...STATIC_VIDEO_TARIFF_VERSIONS,
    future: { runway: { source: 'https://docs.dev.runwayml.com/guides/pricing/', gen45UsdPerSecond: 999 } } };
  assert.equal(calculateStaticVideoUsd(sealed, versions).costUsd, 0.6);
  assert.equal(calculateStaticVideoUsd({ ...sealed, costUsd: 999 }).costUsd, 0.6);
});

test('Alibaba Global HappyHorse uses the published USD rate for the production 15s720P receipt', () => {
  const receipt = buildStaticVideoReceipt({ adapter: 'alibabaCloud', model: 'happyhorse-1.1-i2v',
    seconds: 15, resolution: '720P', region: 'global' });
  assert.equal(receipt.tariffRateUsd, 0.123769);
  assert.equal(receipt.staticVideoTariffVersion, '2026-10-24');
  assert.equal(calculateVideoCallCredits({ ...receipt, costUsd: 999 }).credits, 222.7842);
});

test('adapter requests persist the static receipt before a paid generation', async () => {
  const events = [];
  const payload = { _id: 'queue', model: 'SEEDANCE2.5I2V', duration: 18,
    startImage: 'https://assets.example/first.png', videoBillingPolicy: 'adapter' };
  await generateGenBlazeVideoLayer(payload, {
    env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    persist: async (_id, receipt) => { events.push('persist'); assert.equal(receipt.seconds, 20); return {}; },
    request: async (_route, { body }) => { events.push('submit'); assert.equal(body.params.duration, 20); return { request_id: 'paid' }; },
  });
  assert.deepEqual(events, ['persist', 'submit']);
  assert.equal(payload.videoBillingNativeReceipt.tariffRateUsd, 0.231);
});

test('unknown tariffs and missing queue rows reject before a paid generation', async () => {
  const payload = { _id: 'deleted', videoBillingPolicy: 'adapter' };
  await assert.rejects(sealStaticVideoSubmission(payload,
    { adapter: 'runway', model: 'gen4.5', seconds: 5 }, {
      env: { SAMSAR_DEPLOYMENT_EDITION: 'production' }, persist: async () => null,
    }), error => error.code === 'VIDEO_TARIFF_NOT_PERSISTED');
  await assert.rejects(sealStaticVideoSubmission(payload,
    { adapter: 'custom', model: 'unverified', seconds: 5 }, {
      persist: async () => assert.fail('No persistence for an unverified rate'),
    }), error => error.code === 'VIDEO_STATIC_TARIFF_UNAVAILABLE' && !error.videoBillingPending);
});

test('pipeline and standalone submissions keep their existing billing policy', async () => {
  for (const [policy, env] of [['pipeline', {}], ['adapter', { SAMSAR_DEPLOYMENT_EDITION: 'standalone' }]]) {
    const configuration = { adapter: 'samsar', model: 'BYOK' };
    const payload = { videoBillingPolicy: policy };
    await sealStaticVideoSubmission(payload, configuration,
      { env, persist: async () => assert.fail('No hosted debit for this policy') });
    assert.deepEqual(payload.videoBillingNativeReceipt, configuration);
  }
});
