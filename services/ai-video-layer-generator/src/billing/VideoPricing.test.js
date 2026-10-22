import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVideoCallCredits, videoBillingMode } from './VideoPricing.js';
import { FAL_LIP_SYNC_TARIFFS } from './FalLipSyncTariffs.js';
import { FAL_SOUND_EFFECT_TARIFFS } from './FalSoundEffectTariffs.js';
import { buildFalVideoSubmissionReceipt } from './FalVideoTariffs.js';

for (const adapter of ['gmicloud', 'runway', 'googleCloud', 'alibabaCloud', 'hailuo', 'custom']) {
  for (const model of ['video', 'SYNCLIPSYNC', 'MIRELOAI', 'MMAUDIOV2']) {
    if (adapter === 'fal' && ['SYNCLIPSYNC', 'MIRELOAI', 'MMAUDIOV2'].includes(model)) continue;
    test(`${adapter} ${model} charges the same margin on the actual receipt`, () => {
      assert.equal(calculateVideoCallCredits({ adapter, model, costUsd: 0.375 }).credits, 45);
      assert.equal(calculateVideoCallCredits({ adapter, model, costUsd: 0 }).credits, 0);
    });
  }
}

test('Fal video uses the sealed model/config tariff, ignoring a provider-reported charge', () => {
  const submitted = buildFalVideoSubmissionReceipt({ model: 'KLINGIMGTOVID3PRO',
    duration: 10, generateAudio: true });
  const billed = calculateVideoCallCredits({ ...submitted, costUsd: 0 });
  assert.ok(Math.abs(billed.costUsd - 1.68) < 1e-10);
  assert.equal(billed.credits, 201.6);
  assert.equal(billed.billingBasis, 'second');
  assert.equal(billed.tariffRateUsd, 0.168);
});

test('every Fal lip sync endpoint has an explicit model tariff and source', () => {
  assert.deepEqual(Object.keys(FAL_LIP_SYNC_TARIFFS).sort(), [
    'SYNCLIPSYNC', 'LATENTSYNC', 'KLINGLIPSYNC', 'HUMMINGBIRDLIPSYNC', 'CREATIFYLIPSYNC',
  ].sort());
  for (const tariff of Object.values(FAL_LIP_SYNC_TARIFFS)) {
    assert.match(tariff.source, /^https:\/\/fal\.ai\/models\//);
    assert.ok(tariff.endpoint);
  }
});

test('Fal sound-effect endpoint tariffs use submitted seconds and generated samples', () => {
  assert.deepEqual(Object.keys(FAL_SOUND_EFFECT_TARIFFS).sort(), ['MIRELOAI', 'MMAUDIOV2']);
  const mirelo = calculateVideoCallCredits({ adapter: 'fal', model: 'MIRELOAI',
    requestedSeconds: 5, sampleCount: 2, sampleCountSource: 'legacy_default', costUsd: 999 });
  assert.equal(mirelo.costUsd, 0.1);
  assert.equal(mirelo.credits, 12);
  assert.equal(mirelo.billableSeconds, 10);
  assert.equal(mirelo.billingBasis, 'submittedSecondsPerSample');
  assert.equal(mirelo.sampleMultiplierInferred, true);
  const current = calculateVideoCallCredits({ adapter: 'fal', model: 'MIRELOAI',
    requestedSeconds: 5, sampleCount: 1, sampleCountSource: 'provider_result' });
  assert.equal(current.credits, 6);
  assert.equal(current.sampleMultiplierInferred, true);
  const mmaudio = calculateVideoCallCredits({ adapter: 'fal', model: 'MMAUDIOV2',
    requestedSeconds: 8, sampleCount: 1 });
  assert.equal(mmaudio.costUsd, 0.008);
  assert.equal(mmaudio.credits, 0.96);
});

test('Fal sound effects fail closed on missing duration or sample count', () => {
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'MIRELOAI',
    sampleCount: 2 }), /duration/);
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'MIRELOAI',
    requestedSeconds: 5 }), /sample count/);
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'MMAUDIOV2',
    requestedSeconds: 8, sampleCount: 2 }), /sample count/);
});

test('Sync v3 uses measured output seconds at $8/minute plus 20%', () => {
  const receipt = calculateVideoCallCredits({ adapter: 'fal', model: 'SYNCLIPSYNC',
    outputSeconds: 10.042, costUsd: 999 });
  assert.equal(receipt.costUsd, 10.042 * 8 / 60);
  assert.equal(receipt.credits, 160.672);
  assert.equal(receipt.billingBasis, 'outputSeconds');
  assert.equal(receipt.billableSeconds, 10.042);
  assert.equal(receipt.tariffVerifiedOn, '2026-10-23');
});

test('LatentSync charges $0.20 through 40 output seconds, then $0.005/second', () => {
  const price = outputSeconds => calculateVideoCallCredits({ adapter: 'fal', model: 'LATENTSYNC', outputSeconds });
  assert.equal(price(1).credits, 24);
  assert.equal(price(40).credits, 24);
  assert.equal(price(41).credits, 24.6);
});

test('Kling uses submitted input video seconds rounded to five-second blocks', () => {
  const price = inputSeconds => calculateVideoCallCredits({ adapter: 'fal', model: 'KLINGLIPSYNC', inputSeconds });
  assert.equal(price(0.1).credits, 8.4);
  assert.equal(price(5).credits, 8.4);
  assert.equal(price(5.001).credits, 16.8);
});

test('Creatify uses $1 per measured output minute plus 20%', () => {
  assert.equal(calculateVideoCallCredits({ adapter: 'fal', model: 'CREATIFYLIPSYNC',
    outputSeconds: 60 }).credits, 120);
});

test('Hummingbird uses the explicit historical fallback, never an unverified provider price', () => {
  const price = calculateVideoCallCredits({ adapter: 'fal', model: 'HUMMINGBIRDLIPSYNC',
    requestedSeconds: 7 });
  assert.equal(price.credits, 105);
  assert.equal(price.costUsd, null);
  assert.equal(price.billingBasis, 'requestedSeconds');
  assert.equal(price.pricingFallback, 'historical_fixed_credits');
  assert.equal(price.tariffVerifiedOn, null);
});

test('missing or wrong billable durations fail closed', () => {
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'HUMMINGBIRDLIPSYNC',
    outputSeconds: 60 }), /requested duration/);
  for (const outputSeconds of [undefined, null, 0, -1, NaN, Infinity, '']) {
    assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'SYNCLIPSYNC',
      outputSeconds }), /outputSeconds/);
  }
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'KLINGLIPSYNC',
    outputSeconds: 10 }), /inputSeconds/);
  assert.equal(calculateVideoCallCredits({ adapter: 'gmicloud', model: 'SYNCLIPSYNC',
    costUsd: 0.375 }).credits, 45);
});

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
    assert.throws(() => calculateVideoCallCredits({ adapter: 'gmicloud', costUsd }), /Invalid/);
  }
  assert.throws(() => calculateVideoCallCredits({ adapter: 'fal', model: 'HAIPER2.0', costUsd: 0 }), /tariff/);
  assert.throws(() => calculateVideoCallCredits({ adapter: 'gmicloud', model: 'RUNWAYML', seconds: 5 }), /not available/);
});

test('Docker runtime does not waive hosted production calls; standalone edition does', () => {
  assert.equal(videoBillingMode({ videoBillingPolicy: 'adapter' }, { SAMSAR_DEPLOYMENT_EDITION: 'production', SAMSAR_RUNTIME: 'docker' }), 'adapter');
  assert.equal(videoBillingMode({ videoBillingPolicy: 'adapter' }, { SAMSAR_DEPLOYMENT_EDITION: 'standalone' }), 'standalone');
  assert.equal(videoBillingMode({}, {}), 'legacy');
});
