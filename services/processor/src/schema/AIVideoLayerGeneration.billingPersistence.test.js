import assert from 'node:assert/strict';
import test from 'node:test';
import AIVideoLayerGeneration from './AIVideoLayerGeneration.js';

const receipt = { adapter: 'fal', model: 'HAPPYHORSEI2V', endpoint: 'fal-ai/happy-horse/image-to-video',
  durationSeconds: 5, videoTariffVersion: 'test-static-version' };

test('F2P: a hydrated video job saves its sealed native receipt and billing error', async t => {
  const job = AIVideoLayerGeneration.hydrate({ _id: '507f191e810c19729de860ef',
    videoBillingPolicy: 'adapter', videoBillingPending: true });
  let saved;
  t.mock.method(AIVideoLayerGeneration.collection, 'updateOne', async (_filter, update) => {
    saved = update;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  job.videoBillingNativeReceipt = receipt;
  job.videoBillingError = 'Retry settlement without repeating generation';
  await job.save();
  assert.deepEqual(saved.$set.videoBillingNativeReceipt, receipt);
  assert.equal(saved.$set.videoBillingError, 'Retry settlement without repeating generation');
  assert.deepEqual(job.toObject().videoBillingNativeReceipt, receipt);
});

test('P2P: an ordinary pipeline job does not gain native billing metadata', () => {
  const job = new AIVideoLayerGeneration({ sessionId: 'session', layerId: 'layer' }).toObject();
  assert.equal(Object.hasOwn(job, 'videoBillingNativeReceipt'), false);
  assert.equal(Object.hasOwn(job, 'videoBillingError'), false);
  assert.equal(Object.hasOwn(job, 'videoBillingPolicy'), false);
});
