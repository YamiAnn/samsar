import assert from 'node:assert/strict';
import test from 'node:test';
import { admitAssistantRequest, chargeAssistantRequest } from './AssistantBillingStore.js';
import { debitAssistantOwnerOnce } from './AssistantRequestBilling.js';
import { memoryCreditAccount } from '../../test_helpers/AssistantBillingHarness.js';

function harness() {
  const internal = memoryCreditAccount(100);
  const external = memoryCreditAccount(50);
  const budget = memoryCreditAccount(20);
  const dependencies = {
    User: internal.Owner, ExternalUser: external.Owner, CustomerSubAccount: budget.Owner,
    ExternalUserGenerationCreditTransaction: external.Ledger,
    assertAPIKeyUsageLimitForDebit: async () => {},
    deductGenerationCreditsIdempotently: async (ownerId, credits, options) => {
      assert.equal(options.settleIncurredUsage, true);
      return debitAssistantOwnerOnce({ ...internal, ownerId, credits,
        idempotencyKey: options.idempotencyKey, ledger: { metadata: options.metadata } });
    },
  };
  const options = { idempotencyKey: 'assistant:test', billing: { costUsd: 0.01, costSource: 'adapter_reported' },
    response: { model: 'any/model' } };
  return { internal, external, budget, dependencies, options };
}

test('internal assistant billing uses the existing idempotent owner ledger with 20% audit metadata', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await chargeAssistantRequest('user', 1.2, h.options, h.dependencies);
  assert.equal(h.internal.debits, 1);
  assert.equal(h.internal.transactions.size, 1);
  assert.equal(h.internal.account.generationCredits, 98.8);
  assert.equal(h.internal.transactions.get('assistant:test').metadata.pricingMultiplier, 1.2);
  assert.equal(h.external.debits, 0);
});

test('external-pool assistant billing preserves fractional credits without charging the internal owner', async () => {
  const h = harness();
  h.options.externalUser = { _id: 'external', provider: 'shopify', externalUserId: 'customer' };
  await Promise.all(Array.from({ length: 5 }, () => chargeAssistantRequest('user', 0.0012, h.options, h.dependencies)));
  assert.equal(h.internal.debits, 0);
  assert.equal(h.external.debits, 1);
  assert.equal(h.external.account.generationCredits, 49.9988);
  assert.equal(h.external.account.totalRequests, 1);
  assert.equal(h.external.account.totalCreditsUsed, 0.0012);
  assert.equal(h.external.transactions.size, 1);
  assert.equal(h.external.transactions.get('assistant:test').externalUserExternalId, 'customer');
});

test('mirrored internal external-users charge the owner once and count usage once', async () => {
  const h = harness();
  h.options.externalUser = { _id: 'external', provider: 'samsar_internal', userType: 'internal_user' };
  for (let i = 0; i < 3; i++) await chargeAssistantRequest('user', 1.2, h.options, h.dependencies);
  assert.equal(h.internal.debits, 1);
  assert.equal(h.external.debits, 0);
  assert.equal(h.external.account.generationCredits, 98.8);
  assert.equal(h.external.account.totalRequests, 1);
  assert.equal(h.external.transactions.size, 1);
});

test('customer budgets settle once alongside the real owner without a second owner debit', async () => {
  const h = harness();
  h.options.externalUser = { _id: 'external', customerSubAccountId: 'budget' };
  for (let i = 0; i < 3; i++) await chargeAssistantRequest('user', 1.2, h.options, h.dependencies);
  assert.equal(h.internal.debits, 1);
  assert.equal(h.budget.debits, 1);
  assert.equal(h.budget.account.generationCredits, 18.8);
  assert.equal(h.external.debits, 0);
  assert.equal(h.external.account.totalRequests, 1);
});

for (const failure of ['budget', 'external-ledger']) {
  test(`a partial ${failure} failure recovers all balances and counters once`, async () => {
    const h = harness();
    h.options.externalUser = { _id: 'external', customerSubAccountId: 'budget' };
    const target = failure === 'budget' ? h.budget.Owner : h.external.Ledger;
    const method = failure === 'budget' ? 'findOneAndUpdate' : 'updateOne';
    const original = target[method];
    let attempts = 0;
    target[method] = (...args) => { if (++attempts === 1) throw new Error('outage'); return original(...args); };
    await assert.rejects(chargeAssistantRequest('user', 1.2, h.options, h.dependencies), /outage/);
    await chargeAssistantRequest('user', 1.2, h.options, h.dependencies);
    assert.equal(h.internal.debits, 1);
    assert.equal(h.budget.debits, 1);
    assert.equal(h.external.account.totalRequests, 1);
    assert.equal(h.external.transactions.size, 1);
  });
}

test('incurred usage is settled in full even if it exceeds the pre-dispatch balance', async () => {
  const h = harness();
  h.internal.account.generationCredits = 0.1;
  await admitAssistantRequest('user', null, h.dependencies);
  await chargeAssistantRequest('user', 1.2, h.options, h.dependencies);
  assert.ok(Math.abs(h.internal.account.generationCredits + 1.1) < 1e-10);
  await assert.rejects(admitAssistantRequest('user', null, h.dependencies), { code: 'INSUFFICIENT_CREDITS' });
});

test('admission checks the correct balance, customer budget and API-key limit before dispatch', async () => {
  const h = harness();
  h.internal.account.generationCredits = 0;
  await assert.rejects(admitAssistantRequest('user', null, h.dependencies), { code: 'INSUFFICIENT_CREDITS' });
  await admitAssistantRequest('user', { _id: 'external', provider: 'shopify' }, h.dependencies);
  h.internal.account.generationCredits = 100;
  h.budget.account.generationCredits = 0;
  await assert.rejects(admitAssistantRequest('user', { _id: 'external', customerSubAccountId: 'budget' }, h.dependencies),
    { code: 'INSUFFICIENT_CREDITS' });
  h.dependencies.assertAPIKeyUsageLimitForDebit = async () => { throw Object.assign(new Error('limit'), { code: 'API_KEY_USAGE_LIMIT_EXCEEDED' }); };
  await assert.rejects(admitAssistantRequest('user', null, h.dependencies), { code: 'API_KEY_USAGE_LIMIT_EXCEEDED' });
  assert.equal(h.internal.debits + h.external.debits, 0);
});
