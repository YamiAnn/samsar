import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImageRequestBilling, imageSubmissionIdentity, findImageAPIReplay,
  saveImageAPIRequest, imageSubmissionCreditReceipt } from './ImageRequestBilling.js';

function admission(balance = 100) {
  const calls = [];
  return { calls, connect: async () => {}, env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    User: { findById: () => ({ select: () => ({ lean: async () => ({ generationCredits: balance }) }) }) },
    assertAPIKeyUsageLimitForDebit: async (...args) => calls.push(args) };
}

test('Studio and external image jobs admit without a flat debit and preserve API-key attribution', async () => {
  const dependencies = admission();
  const fields = await prepareImageRequestBilling('owner', { apiKeyId: 'key' }, dependencies);
  assert.equal(fields.imageBillingPolicy, 'adapter');
  assert.equal(fields.userId, 'owner');
  assert.equal(fields.imageBillingPending, true);
  assert.deepEqual(fields.imageBillingAPIKeyUsage, { apiKeyId: 'key' });
  assert.equal(dependencies.calls.length, 1);
  assert.deepEqual(imageSubmissionCreditReceipt(), { creditsCharged: 0, remainingCredits: null, billingStatus: 'PENDING' });
});

test('insufficient balance is rejected before a new image request is queued', async () => {
  for (const balance of [0, -10, undefined]) {
    const dependencies = admission(balance);
    if (balance === undefined) dependencies.User = { findById: () => ({ select: () => ({ lean: async () => null }) }) };
    await assert.rejects(prepareImageRequestBilling('owner', {}, dependencies), error => error.status === 402);
  }
});

test('production pipelines and standalone Docker bypass local image admission and debits', async () => {
  const dependencies = admission(0);
  dependencies.User.findById = () => { throw new Error('unexpected account debit'); };
  assert.equal((await prepareImageRequestBilling('owner', { includedInPipeline: true }, dependencies)).imageBillingPolicy, 'pipeline');
  const local = await prepareImageRequestBilling('owner', {}, { ...dependencies, env: { CURRENT_ENV: 'docker' } });
  assert.equal(local.imageBillingPending, false);
  assert.equal(dependencies.calls.length, 0);
});

test('image retry identity is scoped to owner and operation, with a payload fingerprint', () => {
  const original = imageSubmissionIdentity('owner', 'text_to_image', 'key', { model: 'GPTIMAGE2.5', prompt: 'Hello' });
  assert.deepEqual(original, imageSubmissionIdentity('owner', 'text_to_image', 'key', { prompt: 'Hello', model: 'GPTIMAGE2.5' }));
  assert.notEqual(original.id, imageSubmissionIdentity('other-owner', 'text_to_image', 'key', {}).id);
  assert.notEqual(original.id, imageSubmissionIdentity('owner', 'image_enhance', 'key', {}).id);
  assert.notEqual(original.fingerprint, imageSubmissionIdentity('owner', 'text_to_image', 'key', { prompt: 'Changed' }).fingerprint);
  for (const key of ['', ' ', 123, 'x'.repeat(513)]) assert.throws(() => imageSubmissionIdentity('owner', 'image', key, {}), /request keys/);
});

test('a completed image replay returns the original charge without a fresh balance check', async () => {
  const input = { prompt: 'Hello' };
  const identity = imageSubmissionIdentity('owner', 'text_to_image', 'key', input);
  const dependencies = { connect: async () => {}, ImageGeneration: {
    findById: id => ({ lean: async () => {
      assert.equal(id, identity.id);
      return { _id: id, userId: 'owner', imageBillingFingerprint: identity.fingerprint,
        generationStatus: 'COMPLETED', imageBillingPending: false, imageCreditsCharged: 9.6, imageCreditsRemaining: -1 };
    } }),
  } };
  const replay = await findImageAPIReplay('owner', 'text_to_image', 'key', input, dependencies);
  assert.equal(replay.creditsCharged, 9.6);
  assert.equal(replay.remainingCredits, -1);
  assert.equal(replay.request_id, identity.id);
  await assert.rejects(findImageAPIReplay('owner', 'text_to_image', 'key', { prompt: 'Changed' }, dependencies), error => error.status === 409);
});

test('concurrent image submissions create one durable queued job', async () => {
  const jobs = new Map();
  const input = { prompt: 'Hello' };
  const document = { userId: 'owner', case_type: 'text_to_image', toObject() {
    return { _id: 'random-new-document', userId: this.userId, case_type: this.case_type, expireAt: this.expireAt };
  } };
  const dependencies = { ImageGeneration: { async findOneAndUpdate(filter, update) {
    if (!jobs.has(filter._id)) jobs.set(filter._id, { _id: filter._id, ...update.$setOnInsert });
    return jobs.get(filter._id);
  } } };
  const saved = await Promise.all(Array.from({ length: 10 }, () => saveImageAPIRequest(document, 'key', input, dependencies)));
  assert.equal(jobs.size, 1);
  assert.ok(saved.every(job => job._id === saved[0]._id));
  assert.equal(saved[0].expireAt, null);
  await assert.rejects(saveImageAPIRequest(document, 'key', { prompt: 'Changed' }, dependencies), error => error.status === 409);
});
