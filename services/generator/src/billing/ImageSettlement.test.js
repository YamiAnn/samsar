import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { settleCompletedImageCall, debitImageOwnerOnce, imageCallId } from './ImageSettlement.js';
import { billCompletedImage } from './ImageRequestBilling.js';
import { readFalImageCharge } from './ImageAdapterReceipt.js';

function fixture() {
  const receipts = new Map();
  const transactions = new Map();
  const account = { generationCredits: 100, generationCreditDebitReservations: {} };
  let ledgerFailures = 0;
  let receiptFailures = 0;
  let mutations = 0;
  const Owner = {
    async findOneAndUpdate(filter, update) {
      const field = Object.keys(filter).find(key => key.startsWith('generationCreditDebitReservations.'));
      const key = field.split('.')[1];
      if (account.generationCreditDebitReservations[key]) return null;
      mutations++;
      account.generationCredits += update.$inc.generationCredits;
      account.generationCreditDebitReservations[key] = structuredClone(update.$set[field]);
      return structuredClone(account);
    },
    findOne() { return { lean: async () => structuredClone(account) }; },
  };
  const Ledger = { async updateOne(filter, update) {
    if (ledgerFailures-- > 0) throw new Error('ledger unavailable');
    if (!transactions.has(filter.idempotencyKey)) transactions.set(filter.idempotencyKey, update.$setOnInsert);
  } };
  const store = {
    async ensure(id, value) {
      if (!receipts.has(id)) receipts.set(id, { _id: id, ...structuredClone(value) });
      return structuredClone(receipts.get(id));
    },
    async saveBilling(id, billing) {
      const value = receipts.get(id);
      value.billing ||= structuredClone(billing);
      return structuredClone(value);
    },
    async complete(id, fields) {
      if (receiptFailures-- > 0) throw new Error('receipt update unavailable');
      const value = receipts.get(id);
      Object.assign(value, fields, { status: 'COMPLETED' });
      return structuredClone(value);
    },
  };
  const charge = (userId, credits, idempotencyKey) => debitImageOwnerOnce({ Owner, Ledger, userId, credits, idempotencyKey });
  const options = { id: 'logical-image-1', userId: 'owner', result: { image: 'finished.png' },
    adapterReceipt: { adapter: 'fal', costUsd: 0.125 }, store, charge };
  return { options, store, charge, receipts, transactions, account, Owner, Ledger,
    failLedger: () => ledgerFailures++, failReceipt: () => receiptFailures++, mutations: () => mutations };
}

test('parallel completion callbacks debit one image once', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => settleCompletedImageCall(f.options)));
  assert.equal(f.account.generationCredits, 85);
  assert.equal(f.mutations(), 1);
  assert.equal(f.transactions.size, 1);
  assert.ok(results.every(result => result.status === 'COMPLETED'));
});

for (const phase of ['ledger', 'receipt']) {
  test(`${phase} failure repairs the saved completion without another debit`, async () => {
    const f = fixture();
    phase === 'ledger' ? f.failLedger() : f.failReceipt();
    await assert.rejects(settleCompletedImageCall(f.options), /unavailable/);
    assert.equal(f.account.generationCredits, 85);
    assert.deepEqual(f.receipts.get(f.options.id).result, { image: 'finished.png' });
    await settleCompletedImageCall({ ...f.options, result: { image: 'must-not-replace-original.png' } });
    assert.equal(f.account.generationCredits, 85);
    assert.equal(f.transactions.size, 1);
    assert.equal(f.receipts.get(f.options.id).result.image, 'finished.png');
  });
}

test('independent image calls and rerolls each incur their own charge', async () => {
  const f = fixture();
  await Promise.all(['image-1', 'image-2', 'reroll-1'].map(id => settleCompletedImageCall({ ...f.options, id })));
  assert.equal(f.account.generationCredits, 55);
  assert.equal(f.transactions.size, 3);
});

test('missing adapter billing remains pending and later confirmation settles the retained result', async () => {
  const f = fixture();
  const options = { ...f.options, adapterReceipt: { adapter: 'fal' } };
  await assert.rejects(settleCompletedImageCall(options), /charge/i);
  assert.equal(f.mutations(), 0);
  assert.equal(f.receipts.get(options.id).result.image, 'finished.png');
  await settleCompletedImageCall({ ...options, resolveReceipt: async receipt => ({ ...receipt, costUsd: 0.25 }) });
  assert.equal(f.account.generationCredits, 70);
});

test('zero adapter receipts are completed without an artificial minimum charge', async () => {
  const f = fixture();
  const result = await settleCompletedImageCall({ ...f.options, adapterReceipt: { adapter: 'fal', costUsd: 0 } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(f.mutations(), 0);
});

test('incurred image cost is settled even when the final charge exceeds the remaining balance', async () => {
  const f = fixture();
  f.account.generationCredits = 1;
  await settleCompletedImageCall(f.options);
  assert.equal(f.account.generationCredits, -14);
});

test('existing prepaid jobs, production pipelines and local Docker never receive a second image debit', async () => {
  const f = fixture();
  for (const [payload, env] of [
    [{ _id: 'prepaid', userId: 'owner' }, { SAMSAR_DEPLOYMENT_EDITION: 'production' }],
    [{ _id: 'pipeline', userId: 'owner', imageBillingPolicy: 'pipeline' }, { SAMSAR_DEPLOYMENT_EDITION: 'production' }],
    [{ _id: 'local', userId: 'owner', imageBillingPolicy: 'adapter', adapterProvider: 'samsar' }, { CURRENT_ENV: 'docker' }],
  ]) assert.equal(await billCompletedImage(payload, { image: 'done.png' }, { env, store: f.store, charge: f.charge }), null);
  assert.equal(f.mutations(), 0);
});

test('hosted image call from an agent settles through the same path as Studio', async () => {
  const f = fixture();
  await billCompletedImage({ _id: 'hosted-image', userId: 'owner', imageBillingPolicy: 'adapter' },
    { image: 'done.png', imageBillingReceipt: { adapter: 'fal', providerRequestId: 'remote-image', costUsd: 0.125 } },
    { env: { SAMSAR_DEPLOYMENT_EDITION: 'production', SAMSAR_RUNTIME: 'docker' }, store: f.store, charge: f.charge });
  assert.equal(f.account.generationCredits, 85);
});

test('provider polling and transport retries retain one billing identity; a new reroll gets another', () => {
  const job = { _id: 'queue-row', apiRequestId: 'provider-request' };
  assert.equal(imageCallId(job), imageCallId({ ...job, failureRetryCount: 3 }));
  assert.notEqual(imageCallId(job), imageCallId({ ...job, apiRequestId: 'provider-request-2' }));
  assert.notEqual(imageCallId(job), imageCallId({ ...job, _id: 'reroll-row' }));
});

test('Fal uses actual discounted request cost and rejects unrelated/partial records', async () => {
  const fetchImpl = async url => {
    assert.equal(new URL(url).searchParams.get('request_id'), 'wanted');
    return { ok: true, json: async () => ({ billing_events: [
      { request_id: 'other', cost_total: 100 },
      { request_id: 'wanted', cost_total: 0.05, cost_subtotal: 0.1 },
      { request_id: 'wanted', cost_total: 0.025 },
    ], has_more: false, next_cursor: null }) };
  };
  assert.equal(await readFalImageCharge('wanted', { fetchImpl, env: { FAL_BILLING_API_KEY: 'test-billing-key' } }), 0.07500000000000001);
  await assert.rejects(readFalImageCharge('wanted', { env: { FAL_API_KEY: 'test-key' },
    fetchImpl: async () => ({ ok: false, status: 403 }) }), /confirmation/);
  await assert.rejects(readFalImageCharge('wanted', { env: { FAL_API_KEY: 'test-key' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ billing_events: [], has_more: false }) }) }), /not available/);
});

test('a durable debit identity rejects a changed settlement amount', async () => {
  const f = fixture();
  await settleCompletedImageCall(f.options);
  const key = `image:${f.options.id}`;
  assert.ok(f.account.generationCreditDebitReservations[createHash('sha256').update(key).digest('hex')]);
  await assert.rejects(debitImageOwnerOnce({ Owner: f.Owner, Ledger: f.Ledger, userId: 'owner', credits: 20, idempotencyKey: key }), /conflicts/);
  assert.equal(f.mutations(), 1);
});
