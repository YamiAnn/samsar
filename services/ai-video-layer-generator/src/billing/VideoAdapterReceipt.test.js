import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVideoAdapterReceipt } from './VideoAdapterReceipt.js';

test('saved Sync v3 output resolves from its durable receipt without Fal billing calls', async () => {
  let probes = 0;
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'SYNCLIPSYNC', providerRequestId: 'finished-request' },
    { result: { remoteUrl: 'https://provider.example/result.mp4' } },
    { probeDuration: async () => { probes++; return 5.042; },
      fetchImpl: async () => assert.fail('Fal billing API must not be called') },
  );
  assert.equal(probes, 1);
  assert.equal(receipt.outputSeconds, 5.042);
  assert.equal(receipt.providerRequestId, 'finished-request');
});

test('saved local output is preferred and probe errors do not disclose its URL', async () => {
  const signed = 'https://provider.example/secret-token.mp4';
  await assert.rejects(resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'LATENTSYNC' },
    { result: { localVideoLink: '/saved/output.mp4', remoteUrl: signed } },
    { probeDuration: async path => {
      assert.equal(path, '/saved/output.mp4');
      throw new Error(signed);
    } },
  ), error => error.code === 'VIDEO_BILLING_PENDING' && !error.message.includes(signed));
});

test('Kling uses its snapshotted input duration without polling media or billing', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'KLINGLIPSYNC', inputSeconds: 5.01 }, {},
    { fetchImpl: async () => assert.fail('No billing lookup'),
      probeDuration: async () => assert.fail('Input duration was snapshotted') },
  );
  assert.equal(receipt.inputSeconds, 5.01);
});

test('Hummingbird fallback takes the originally requested duration', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'HUMMINGBIRDLIPSYNC' },
    { requestedSeconds: 7, result: { remoteUrl: 'https://provider.example/result.mp4' } },
    { fetchImpl: async () => assert.fail('No billing lookup'),
      probeDuration: async () => assert.fail('Fallback uses requested duration') },
  );
  assert.equal(receipt.requestedSeconds, 7);
});

test('saved legacy Mirelo result uses its queue duration and old two-sample default', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'MIRELOAI', providerRequestId: 'completed-request' },
    { requestId: 'original-queue', result: { remoteUrl: 'https://provider.example/result.mp4' } },
    { lookupGeneration: async id => { assert.equal(id, 'original-queue'); return { duration: 5 }; },
      probeDuration: async () => assert.fail('Saved queue duration is available'),
      fetchImpl: async () => assert.fail('Neither provider result nor billing GET is needed') },
  );
  assert.equal(receipt.requestedSeconds, 5);
  assert.equal(receipt.sampleCount, 2);
  assert.equal(receipt.sampleCountSource, 'legacy_default');
  assert.equal(receipt.durationSource, 'legacy_queue');
});

test('orphaned legacy Mirelo receipt recovers from its saved output without provider GET', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'MIRELOAI' },
    { requestId: 'removed-queue', result: { localVideoLink: '/saved/first.mp4' } },
    { lookupGeneration: async () => null,
      probeDuration: async path => { assert.equal(path, '/saved/first.mp4'); return 5; },
      fetchImpl: async () => assert.fail('No provider GET') },
  );
  assert.equal(receipt.requestedSeconds, 5);
  assert.equal(receipt.sampleCount, 2);
  assert.equal(receipt.durationSource, 'legacy_measured_output');
});

test('MMAudio existing default and current native sound receipts need no billing GET', async () => {
  const legacy = await resolveVideoAdapterReceipt({ adapter: 'fal', model: 'MMAUDIOV2' }, {},
    { fetchImpl: async () => assert.fail('No billing lookup') });
  assert.equal(legacy.requestedSeconds, 8);
  assert.equal(legacy.sampleCount, 1);
  const current = await resolveVideoAdapterReceipt({ adapter: 'fal', model: 'MIRELOAI',
    requestedSeconds: 5, sampleCount: 1, sampleCountSource: 'provider_result' }, {},
  { lookupGeneration: async () => assert.fail('No queue lookup') });
  assert.equal(current.sampleCount, 1);
});

test('GMICloud uses saved submitted configuration without a cost/status GET', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'gmicloud', model: 'SEEDANCE2.0I2V', providerRequestId: 'paid', costUsd: 999 },
    { requestId: 'original-queue' }, {
      lookupGeneration: async () => ({ model: 'SEEDANCE2.0I2V', duration: 5,
        startImage: 'https://assets.example/first.png', submittedAdapter: 'gmicloud',
        generationId: 'genblaze-video:paid' }),
      fetchImpl: async () => assert.fail('No provider charge/status GET'),
    });
  assert.equal(receipt.tariffRateUsd, 0.152);
  assert.equal(receipt.seconds, 5);
  assert.equal(receipt.pricingRecovery, 'legacy_queue');
  assert.equal(Object.hasOwn(receipt, 'costUsd'), false);
});

test('missing original configuration stays pending even with a reported zero price', async () => {
  await assert.rejects(resolveVideoAdapterReceipt(
    { adapter: 'gmicloud', model: 'SEEDANCE2.0I2V', providerRequestId: 'paid', costUsd: 0 },
    { requestId: 'deleted-queue' }, {
      lookupGeneration: async () => null,
      fetchImpl: async () => assert.fail('No provider GET'),
    }), /original static video submission configuration/);
});

test('saved current GMI tariff needs no queue or provider lookup', async () => {
  const { buildStaticVideoReceipt } = await import('./StaticVideoTariffs.js');
  const sealed = buildStaticVideoReceipt({ adapter: 'gmicloud', model: 'SEEDANCE2.0I2V',
    seconds: 10, resolution: '720p' });
  assert.deepEqual(await resolveVideoAdapterReceipt(sealed, {}, {
    lookupGeneration: async () => assert.fail('No queue lookup'),
    fetchImpl: async () => assert.fail('No provider GET'),
  }), sealed);
});

test('legacy GMI Hailuo never performs a second GET to recover a missing charge', async () => {
  for (const costUsd of [undefined, 0, 0.48]) {
    const receipt = { adapter: 'gmicloud', model: 'HAILUOPRO', ...(costUsd === undefined ? {} : { costUsd }) };
    assert.deepEqual(await resolveVideoAdapterReceipt(receipt, {}, {
      lookupGeneration: async () => assert.fail('No repricing queue lookup'),
      fetchImpl: async () => assert.fail('No result or pricing GET'),
    }), receipt);
  }
});
