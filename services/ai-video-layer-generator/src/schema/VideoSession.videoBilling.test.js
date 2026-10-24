import test from 'node:test';
import assert from 'node:assert/strict';
import VideoSession from './VideoSession.js';
import AIVideoLayerGeneration from './AIVideoLayerGeneration.js';
import { billCompletedVideo } from '../billing/VideoRequestBilling.js';
import { videoBillingMode } from '../billing/VideoPricing.js';
import { buildStaticVideoReceipt } from '../billing/StaticVideoTariffs.js';

const env = { SAMSAR_DEPLOYMENT_EDITION: 'production' };
const billing = {
  videoBillingPolicy: 'adapter', videoBillingAPIKeyUsage: { apiKeyId: 'key-1', requestId: 'request-1' },
  videoBillingDebits: { 'paid-call': 84 }, videoCreditsCharged: 84, videoRemainingCredits: 0,
};

test('hydrated video sessions expose persisted billing policy, attribution, and stage totals', () => {
  const session = VideoSession.hydrate(billing);
  for (const [key, value] of Object.entries(billing)) assert.deepEqual(session[key], value, key);
});

test('hydrated completed queue retains sealed native pricing and API-key debit attribution', async () => {
  const native = buildStaticVideoReceipt({ adapter: 'alibabaCloud', model: 'happyhorse-1.1-i2v',
    seconds: 5, resolution: '720P', region: 'international' });
  const job = AIVideoLayerGeneration.hydrate({ userId: 'owner', sessionId: 'reroll',
    ...billing, model: 'HAPPYHORSEI2V', submittedAdapter: 'alibabaCloud', generationId: 'paid',
    videoBillingNativeReceipt: native, videoBillingError: 'prior transient failure' });
  assert.deepEqual(job.videoBillingNativeReceipt, native);
  assert.equal(job.videoBillingError, 'prior transient failure');
  let stored, charged;
  const receipt = await billCompletedVideo(job, { remoteUrl: 'https://assets.example/paid.mp4',
    videoBillingReceipt: { ...job.videoBillingNativeReceipt, providerRequestId: 'paid' } }, {
    env,
    store: {
      ensure: async (id, fields) => { stored = { _id: id, ...fields }; return stored; },
      saveBilling: async (_id, calculated) => { stored.billing = calculated; return stored; },
      complete: async (_id, fields) => Object.assign(stored, fields, { status: 'COMPLETED' }),
    },
    charge: async (owner, credits, identity, retained) => {
      charged = { owner, credits, identity, apiKeyUsage: retained.context.apiKeyUsage };
      return { remainingCredits: 0 };
    },
  });
  assert.equal(receipt.billing.credits, 84);
  assert.equal(charged.owner, 'owner');
  assert.deepEqual(charged.apiKeyUsage, billing.videoBillingAPIKeyUsage);
  assert.match(charged.identity, /^video:/);
});

test('F2P: billing assignments on hydrated workers serialize instead of becoming untracked properties', () => {
  const session = VideoSession.hydrate({});
  Object.assign(session, billing);
  for (const [key, value] of Object.entries(billing)) {
    assert.deepEqual(session.toObject()[key], value, key);
    assert.equal(session.isModified(key), true, key);
  }
  const job = AIVideoLayerGeneration.hydrate({ model: 'HAPPYHORSEI2V' });
  job.videoBillingNativeReceipt = { adapter: 'alibabaCloud', seconds: 15 };
  job.videoBillingError = 'retry debit';
  assert.deepEqual(job.toObject().videoBillingNativeReceipt, { adapter: 'alibabaCloud', seconds: 15 });
  assert.equal(job.toObject().videoBillingError, 'retry debit');
});

test('hydrated ordinary pipeline and historical queues do not opt into adapter completion charges', async () => {
  for (const fields of [{ videoBillingPolicy: 'pipeline' }, {}]) {
    const job = AIVideoLayerGeneration.hydrate({ userId: 'owner', ...fields });
    assert.notEqual(videoBillingMode(job, env), 'adapter');
    assert.equal(await billCompletedVideo(job, {}, {
      env, store: { ensure: async () => assert.fail('Pipeline completion cannot receive a second charge') },
    }), null);
  }
});
