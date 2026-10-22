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

test('recovers the confirmed GMICloud charge for a saved video without submitting again', async () => {
  const calls = [];
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'gmicloud', model: 'SEEDANCE2.0I2V', providerRequestId: 'sealed/job' },
    {},
    {
      env: { SAMSAR_GENBLAZE_BASE_URL: 'http://genblaze:8080/v1/' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ status: 'succeeded', billing: { cost_usd: 0.76 } }) };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://genblaze:8080/v1/media/requests/sealed%2Fjob');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(receipt.costUsd, 0.76);
});

test('GMICloud billing recovery keeps an unpriced completed video pending', async () => {
  await assert.rejects(
    resolveVideoAdapterReceipt({ adapter: 'gmicloud', providerRequestId: 'sealed' }, {}, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'succeeded' }) }),
    }),
    error => error.code === 'VIDEO_BILLING_PENDING' && /charge is not available/.test(error.message),
  );
});

test('GMICloud billing recovery accepts an explicit zero charge', async () => {
  const receipt = await resolveVideoAdapterReceipt({ adapter: 'gmicloud' },
    { apiRequestId: 'genblaze-video:sealed' }, {
      fetchImpl: async () => ({ ok: true, json: async () => ({
        status: 'succeeded', billing: { cost_usd: 0 },
      }) }),
    });
  assert.equal(receipt.costUsd, 0);
});
