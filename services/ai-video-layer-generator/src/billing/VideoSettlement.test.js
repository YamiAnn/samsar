import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { settleCompletedVideoCall, debitVideoOwnerOnce, videoCallId } from './VideoSettlement.js';
import { billCompletedVideo } from './VideoRequestBilling.js';
import { resolveVideoAdapterReceipt } from './VideoAdapterReceipt.js';

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
  const charge = (userId, credits, idempotencyKey) => debitVideoOwnerOnce({ Owner, Ledger, userId, credits, idempotencyKey });
  const options = { id: 'logical-video-1', userId: 'owner', result: { video: 'finished.png' },
    adapterReceipt: { adapter: 'runway', model: 'gen4.5', seconds: 5, costUsd: 999 }, store, charge };
  return { options, store, charge, receipts, transactions, account, Owner, Ledger,
    failLedger: () => ledgerFailures++, failReceipt: () => receiptFailures++, mutations: () => mutations };
}

test('parallel completion callbacks debit one video once', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => settleCompletedVideoCall(f.options)));
  assert.equal(f.account.generationCredits, 28);
  assert.equal(f.mutations(), 1);
  assert.equal(f.transactions.size, 1);
  assert.ok(results.every(result => result.status === 'COMPLETED'));
});

for (const phase of ['ledger', 'receipt']) {
  test(`${phase} failure repairs the saved completion without another debit`, async () => {
    const f = fixture();
    phase === 'ledger' ? f.failLedger() : f.failReceipt();
    await assert.rejects(settleCompletedVideoCall(f.options), /unavailable/);
    assert.equal(f.account.generationCredits, 28);
    assert.deepEqual(f.receipts.get(f.options.id).result, { video: 'finished.png' });
    await settleCompletedVideoCall({ ...f.options, result: { video: 'must-not-replace-original.png' } });
    assert.equal(f.account.generationCredits, 28);
    assert.equal(f.transactions.size, 1);
    assert.equal(f.receipts.get(f.options.id).result.video, 'finished.png');
  });
}

test('independent video calls and rerolls each incur their own charge', async () => {
  const f = fixture();
  await Promise.all(['video-1', 'video-2', 'reroll-1'].map(id => settleCompletedVideoCall({ ...f.options, id })));
  assert.equal(f.account.generationCredits, -116);
  assert.equal(f.transactions.size, 3);
});

test('missing submitted configuration remains pending and queue recovery settles the retained result', async () => {
  const f = fixture();
  const options = { ...f.options, adapterReceipt: { adapter: 'runway', model: 'gen4.5' } };
  await assert.rejects(settleCompletedVideoCall(options), /charge|duration/i);
  assert.equal(f.mutations(), 0);
  assert.equal(f.receipts.get(options.id).result.video, 'finished.png');
  await settleCompletedVideoCall({ ...options, resolveReceipt: async receipt => ({ ...receipt, seconds: 5 }) });
  assert.equal(f.account.generationCredits, 28);
});

test('a reported zero cannot override the static charge', async () => {
  const f = fixture();
  const result = await settleCompletedVideoCall({ ...f.options, adapterReceipt: { ...f.options.adapterReceipt, costUsd: 0 } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.billing.credits, 72);
  assert.equal(f.mutations(), 1);
});

test('incurred video cost is settled even when the final charge exceeds the remaining balance', async () => {
  const f = fixture();
  f.account.generationCredits = 1;
  await settleCompletedVideoCall(f.options);
  assert.equal(f.account.generationCredits, -71);
});

test('existing prepaid jobs, production pipelines and local Docker never receive a second video debit', async () => {
  const f = fixture();
  for (const [payload, env] of [
    [{ _id: 'prepaid', userId: 'owner' }, { SAMSAR_DEPLOYMENT_EDITION: 'production' }],
    [{ _id: 'pipeline', userId: 'owner', videoBillingPolicy: 'pipeline' }, { SAMSAR_DEPLOYMENT_EDITION: 'production' }],
    [{ _id: 'local', userId: 'owner', videoBillingPolicy: 'adapter', adapterProvider: 'samsar' }, { CURRENT_ENV: 'docker' }],
  ]) assert.equal(await billCompletedVideo(payload, { video: 'done.png' }, { env, store: f.store, charge: f.charge }), null);
  assert.equal(f.mutations(), 0);
});

test('hosted video call from an agent settles through the same path as Studio', async () => {
  const f = fixture();
  await billCompletedVideo({ _id: 'hosted-video', userId: 'owner', videoBillingPolicy: 'adapter' },
    { video: 'done.png', videoBillingReceipt: { adapter: 'runway', model: 'gen4.5', seconds: 5, providerRequestId: 'remote-video', costUsd: 0.125 } },
    { env: { SAMSAR_DEPLOYMENT_EDITION: 'production', SAMSAR_RUNTIME: 'docker' }, store: f.store, charge: f.charge });
  assert.equal(f.account.generationCredits, 28);
});

test('provider polling and transport retries retain one billing identity; a new reroll gets another', () => {
  const job = { _id: 'queue-row', generationId: 'provider-request' };
  assert.equal(videoCallId(job), videoCallId({ ...job, failureRetryCount: 3 }));
  assert.notEqual(videoCallId(job), videoCallId({ ...job, generationId: 'provider-request-2' }));
  assert.notEqual(videoCallId(job), videoCallId({ ...job, _id: 'reroll-row' }));
});

test('Fal saved video uses its original queue configuration without a pricing request', async () => {
  const receipt = await resolveVideoAdapterReceipt(
    { adapter: 'fal', model: 'KLINGIMGTOVID3PRO', providerRequestId: 'finished-request' },
    { requestId: 'original-queue', result: { remoteUrl: 'https://provider.example/video.mp4' } },
    { lookupGeneration: async () => ({ model: 'KLINGIMGTOVID3PRO', duration: 5, generateAudio: true }),
      fetchImpl: async () => assert.fail('Provider pricing must not be fetched') },
  );
  assert.equal(receipt.submittedQuantity, 5);
  assert.equal(receipt.tariffRateUsd, 0.168);
  assert.equal(receipt.pricingRecovery, 'legacy_queue');
});

test('a durable debit identity rejects a changed settlement amount', async () => {
  const f = fixture();
  await settleCompletedVideoCall(f.options);
  const key = `video:${f.options.id}`;
  assert.ok(f.account.generationCreditDebitReservations[createHash('sha256').update(key).digest('hex')]);
  await assert.rejects(debitVideoOwnerOnce({ Owner: f.Owner, Ledger: f.Ledger, userId: 'owner', credits: 20, idempotencyKey: key }), /conflicts/);
  assert.equal(f.mutations(), 1);
});

test('completed provider receipt survives queue deletion before settlement', async () => {
  const f = fixture();
  await settleCompletedVideoCall({ ...f.options, deferSettlement: true });
  assert.equal(f.mutations(), 0);
  const saved = f.receipts.get(f.options.id);
  assert.equal(saved.status, 'PENDING');
  // Recovery has only the financial receipt; no generation queue is needed.
  await settleCompletedVideoCall({ ...f.options, userId: saved.userId, result: saved.result,
    adapterReceipt: saved.adapterReceipt, context: saved.context });
  assert.equal(f.mutations(), 1);
  assert.equal(f.account.generationCredits, 28);
});

test('an existing saved Sync v3 result settles once from its measured output', async () => {
  const f = fixture();
  let probes = 0;
  const options = { ...f.options, id: 'saved-sync-result',
    result: { remoteUrl: 'https://provider.example/saved.mp4' },
    adapterReceipt: { adapter: 'fal', model: 'SYNCLIPSYNC', providerRequestId: 'existing-request' },
    context: { sessionId: 'existing-session', requestId: 'existing-queue-row' },
    resolveReceipt: (receipt, context) => resolveVideoAdapterReceipt(receipt, context, {
      probeDuration: async () => { probes++; return 5.042; },
      fetchImpl: async () => assert.fail('Fal billing lookup must not run'),
    }),
  };
  await settleCompletedVideoCall({ ...options, deferSettlement: true });
  const saved = f.receipts.get(options.id);
  assert.equal(saved.status, 'PENDING');
  assert.equal(f.mutations(), 0);
  await settleCompletedVideoCall(options);
  await settleCompletedVideoCall(options);
  assert.equal(probes, 1);
  assert.equal(saved.billing.credits, 80.672);
  assert.equal(saved.billing.billableSeconds, 5.042);
  assert.equal(saved.billing.billingBasis, 'outputSeconds');
  assert.equal(saved.billing.tariffVerifiedOn, '2026-10-23');
  assert.equal(f.mutations(), 1);
  assert.equal(f.transactions.size, 1);
});

test('an existing saved Mirelo result settles its two historical samples once', async () => {
  const f = fixture();
  let lookups = 0;
  const options = { ...f.options, id: 'saved-mirelo-result',
    result: { remoteUrl: 'https://provider.example/saved.mp4' },
    adapterReceipt: { adapter: 'fal', model: 'MIRELOAI', providerRequestId: 'existing-request' },
    context: { sessionId: 'existing-session', requestId: 'existing-queue-row' },
    resolveReceipt: (receipt, context) => resolveVideoAdapterReceipt(receipt, context, {
      lookupGeneration: async id => {
        lookups++;
        assert.equal(id, 'existing-queue-row');
        return { duration: 5 };
      },
      probeDuration: async () => assert.fail('The old queue still has submitted duration'),
      fetchImpl: async () => assert.fail('Fal billing or result lookup must not run'),
    }),
  };
  await settleCompletedVideoCall({ ...options, deferSettlement: true });
  await settleCompletedVideoCall({ ...options, context: { requestedSeconds: 99 } });
  await settleCompletedVideoCall(options);
  const saved = f.receipts.get(options.id);
  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.billing.costUsd, 0.1);
  assert.equal(saved.billing.credits, 12);
  assert.equal(saved.billing.sampleCount, 2);
  assert.equal(lookups, 1);
  assert.equal(saved.context.requestId, 'existing-queue-row');
  assert.equal(f.mutations(), 1);
  assert.equal(f.transactions.size, 1);
});
