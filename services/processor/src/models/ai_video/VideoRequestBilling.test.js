import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVideoRequestBilling, videoQueueBillingFields } from './VideoRequestBilling.js';
import { buildDirectExternalI2VGenerationDocument } from './DirectExternalI2V.js';
import AIVideoLayerGeneration from '../../schema/AIVideoLayerGeneration.js';

function deps(balance = 100) {
  return { connect: async () => {}, env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    User: { findById: () => ({ select: () => ({ lean: async () => ({ generationCredits: balance }) }) }) },
    assertAPIKeyUsageLimitForDebit: async () => {} };
}

test('hosted Studio and SDK video admission carries completion policy and API-key attribution without debiting', async () => {
  const fields = await prepareVideoRequestBilling('owner', { apiKeyId: 'key' }, deps());
  assert.equal(fields.videoBillingPolicy, 'adapter');
  assert.equal(fields.videoBillingPending, true);
  assert.equal(fields.expireAt, null);
  assert.deepEqual(fields.videoBillingAPIKeyUsage, { apiKeyId: 'key' });
  assert.deepEqual(videoQueueBillingFields(fields).videoBillingAPIKeyUsage, { apiKeyId: 'key' });
  await assert.rejects(prepareVideoRequestBilling('owner', {}, deps(0)), /Insufficient/);
});

test('standalone local jobs do not require a local balance or incur a local debit', async () => {
  const fields = await prepareVideoRequestBilling('owner', {}, { ...deps(0), env: { SAMSAR_DEPLOYMENT_EDITION: 'standalone' } });
  assert.equal(fields.videoBillingPending, false);
  assert.equal(videoQueueBillingFields({ videoBillingPolicy: 'pipeline' }).expireAt, null);
  assert.equal(new AIVideoLayerGeneration({ status: 'INIT' }).expireAt, null);
  assert.equal(AIVideoLayerGeneration.schema.path('expireAt').options.expires, 3600);
});

test('direct standalone video jobs retain their request before provider submission', () => {
  const job = buildDirectExternalI2VGenerationDocument({ generationRequestId: 'job', videoSessionId: 'session',
    currentLayerId: 'layer', directExternalTextToVideo: true, model: 'VEO3.1',
    videoBillingPolicy: 'pipeline', userId: 'owner' });
  assert.equal(job.status, 'INIT');
  assert.equal(job.expireAt, null);
});

test('direct text model jobs need no image and retain the completion billing fields', () => {
  const job = buildDirectExternalI2VGenerationDocument({ generationRequestId: 'job', videoSessionId: 'session',
    currentLayerId: 'layer', directExternalTextToVideo: true, model: 'VEO3.1',
    videoBillingPolicy: 'adapter', userId: 'owner' });
  assert.equal(job.useStartFrame, false);
  assert.equal(job.videoBillingPolicy, 'adapter');
  assert.equal(job.expireAt, null);
});
