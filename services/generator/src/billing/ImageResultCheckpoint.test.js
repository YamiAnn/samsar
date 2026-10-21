import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointImageResult, checkpointForAttempt } from './ImageResultCheckpoint.js';

test('a native result retains the same billing identity after its API status changes', async () => {
  let update;
  const payload = { _id: 'native-image', imageBillingPolicy: 'adapter' };
  const result = { image: 'saved.png', imageBillingReceipt: { adapter: 'openai', costUsd: 0.1 } };
  await checkpointImageResult(payload, result, { env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    Model: { async updateOne(filter, value) { assert.equal(filter._id, payload._id); update = value.$set; } } });
  assert.equal(update.imageDeliveryPending, true);
  assert.equal(update.expireAt, null);
  const resumed = checkpointForAttempt({ ...payload, ...update, apiRequestId: 'new-native-completion-id' });
  assert.equal(resumed.image, 'saved.png');
  assert.equal(resumed.imageBillingCallId, result.imageBillingCallId);
});

test('a legitimate scoring retry cannot reuse the previous generated image', async () => {
  let update;
  const payload = { _id: 'native-image', imageBillingPolicy: 'adapter' };
  await checkpointImageResult(payload, { image: 'first.png' }, { env: {},
    Model: { async updateOne(filter, value) { update = value.$set; } } });
  assert.equal(checkpointForAttempt({ ...payload, ...update, filterRetryCount: 1 }), null);
});

test('prepaid pipelines and local standalone providers keep their existing result path', async () => {
  const Model = { async updateOne() { throw new Error('unexpected local billing write'); } };
  for (const [payload, env] of [[{ imageBillingPolicy: 'pipeline' }, {}],
    [{ imageBillingPolicy: 'adapter' }, { CURRENT_ENV: 'docker' }], [{}, {}]]) {
    const result = { image: 'unchanged.png' };
    assert.equal(await checkpointImageResult(payload, result, { Model, env }), result);
    assert.equal(result.imageBillingCallId, undefined);
  }
});
