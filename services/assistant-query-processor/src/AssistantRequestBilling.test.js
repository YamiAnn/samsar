import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantRequestIdentity, runAssistantRequest, debitAssistantOwnerOnce } from './AssistantRequestBilling.js';
import { calculateAssistantRequestBilling, normalizeAssistantResponseUsage } from './AssistantBilling.js';
import { memoryRequestStore, memoryCreditAccount } from './test_helpers/AssistantBillingHarness.js';

function harness() {
  const store = memoryRequestStore();
  const account = memoryCreditAccount();
  let providerCalls = 0;
  let deliveries = 0;
  const options = { ...assistantRequestIdentity('user', 'assistant', { input: 'hello' }, 'request'),
    userId: 'user', scope: 'assistant', store,
    generate: async () => {
      providerCalls++;
      return { id: 'provider-response', model: 'openai/gpt-6-astra',
        usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 },
        samsarBilling: { adapter: 'openrouter', costUsd: 0.01 } };
    },
    charge: (credits, { idempotencyKey }) => debitAssistantOwnerOnce({
      ...account, ownerId: 'user', credits, idempotencyKey, ledger: { userId: 'user' },
    }),
    finalize: async (response, billing, debit) => {
      deliveries++;
      return { response, creditsCharged: billing.credits, remainingCredits: debit.remainingCredits };
    },
  };
  return { store, account, options, get providerCalls() { return providerCalls; }, get deliveries() { return deliveries; } };
}

test('repeated assistant requests reuse one provider response and one fractional debit', async () => {
  const h = harness();
  const first = await runAssistantRequest(h.options);
  const replay = await runAssistantRequest(h.options);
  assert.deepEqual(replay, first);
  assert.equal(first.creditsCharged, 1.2);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.account.transactions.size, 1);
  assert.equal(h.deliveries, 1);
});

test('concurrent copies of a request cannot dispatch or debit twice', async () => {
  const h = harness();
  const results = await Promise.allSettled([runAssistantRequest(h.options), runAssistantRequest(h.options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ASSISTANT_REQUEST_IN_PROGRESS');
  await runAssistantRequest(h.options);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
});

test('a debit failure retains usage and retries settlement without repeating inference', async () => {
  const h = harness();
  const charge = h.options.charge;
  let attempts = 0;
  h.options.charge = (...args) => { if (++attempts === 1) throw new Error('database unavailable'); return charge(...args); };
  await assert.rejects(runAssistantRequest(h.options), /database unavailable/);
  assert.equal(h.store.records.get(h.options.id).status, 'BILLING_PENDING');
  await runAssistantRequest(h.options);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
});

test('failure between balance debit and ledger insert repairs the ledger without another debit', async () => {
  const h = harness();
  const insert = h.account.Ledger.updateOne;
  let attempts = 0;
  h.account.Ledger.updateOne = (...args) => { if (++attempts === 1) throw new Error('ledger unavailable'); return insert(...args); };
  await assert.rejects(runAssistantRequest(h.options), /ledger unavailable/);
  assert.equal(h.account.debits, 1);
  await runAssistantRequest(h.options);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.account.transactions.size, 1);
});

test('session delivery failure after charging does not lose or duplicate billing on recovery', async () => {
  const h = harness();
  const deliver = h.options.finalize;
  let attempts = 0;
  h.options.finalize = (...args) => { if (++attempts === 1) throw new Error('session unavailable'); return deliver(...args); };
  await assert.rejects(runAssistantRequest(h.options), /session unavailable/);
  await runAssistantRequest(h.options);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.deliveries, 1);
});

test('missing usage never silently becomes free or word-priced inference', async () => {
  const h = harness();
  h.options.generate = async () => ({ id: 'missing-usage', model: 'unknown', output_text: 'hello' });
  await assert.rejects(runAssistantRequest(h.options), { code: 'ASSISTANT_BILLING_USAGE_REQUIRED' });
  assert.equal(h.account.debits, 0);
  const pending = h.store.records.get(h.options.id);
  pending.providerResponse.samsarBilling = { adapter: 'openrouter', costUsd: 0.02 };
  const recovered = await runAssistantRequest(h.options);
  assert.equal(recovered.creditsCharged, 2.4);
  assert.equal(h.account.debits, 1);
});

test('reported free responses are completed without a fallback minimum charge', async () => {
  const h = harness();
  h.options.generate = async () => ({ model: 'unknown', samsarBilling: { adapter: 'openrouter', costUsd: 0 } });
  const result = await runAssistantRequest(h.options);
  assert.equal(result.creditsCharged, 0);
  assert.equal(h.account.debits, 0);
  assert.equal(h.store.records.get(h.options.id).status, 'COMPLETED');
});

test('provider failure or admission rejection produces no debit', async () => {
  for (const point of ['generate', 'admit']) {
    const h = harness();
    h.options[point] = async () => { throw new Error(`${point} failed`); };
    await assert.rejects(runAssistantRequest(h.options), /failed/);
    assert.equal(h.account.debits, 0);
    assert.equal(h.account.transactions.size, 0);
    if (point === 'admit') assert.equal(h.providerCalls, 0);
  }
});

test('different assistant requests settle atomically against the same balance', async () => {
  const h = harness();
  const other = { ...h.options, ...assistantRequestIdentity('user', 'assistant', {}, 'other') };
  await Promise.all([runAssistantRequest(h.options), runAssistantRequest(other)]);
  assert.equal(h.providerCalls, 2);
  assert.equal(h.account.debits, 2);
  assert.equal(h.account.transactions.size, 2);
  assert.ok(Math.abs(h.account.account.generationCredits - 97.6) < 1e-10);
});

test('request identity is owner-scoped and refuses changed payloads under the same key', async () => {
  const h = harness();
  await runAssistantRequest(h.options);
  const changed = assistantRequestIdentity('user', 'assistant', { input: 'changed' }, 'request');
  await assert.rejects(runAssistantRequest({ ...h.options, ...changed }), { code: 'ASSISTANT_IDEMPOTENCY_CONFLICT' });
  assert.notEqual(assistantRequestIdentity('other-user', 'assistant', {}, 'request').id, h.options.id);
  assert.equal(h.account.debits, 1);
});

test('stale provider dispatch with no receipt is retained for reconciliation instead of inferred twice', async () => {
  const h = harness();
  await h.store.ensure(h.options.id, { fingerprint: h.options.fingerprint, status: 'PROCESSING', dispatchStarted: true });
  await assert.rejects(runAssistantRequest(h.options), { code: 'ASSISTANT_PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(h.providerCalls, 0);
  assert.equal(h.account.debits, 0);
  assert.equal(h.store.records.get(h.options.id).status, 'BILLING_PENDING');
});

test('Responses and Chat usage conversions preserve cache counts, reasoning and adapter cost', () => {
  const raw = { input_tokens: 10000, input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1000 },
    output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 }, cost: 0.02 };
  const normalized = normalizeAssistantResponseUsage(normalizeAssistantResponseUsage(raw));
  assert.equal(normalized.input_tokens, 10000);
  assert.equal(normalized.prompt_tokens, 10000);
  assert.equal(normalized.prompt_tokens_details.cached_tokens, 8000);
  assert.equal(normalized.output_tokens, 100);
  assert.equal(normalized.output_tokens_details.reasoning_tokens, 60);
  assert.equal(normalized.cost, 0.02);
});

test('malformed adapter charges are rejected rather than replaced by guessed prices', () => {
  for (const costUsd of [-1, 'invalid', true, Infinity, [], {}, ' ', '', 1e308]) {
    assert.throws(() => calculateAssistantRequestBilling({ model: 'gpt-6-astra',
      usage: { input_tokens: 1000 }, samsarBilling: { adapter: 'openrouter', costUsd } }),
    { code: 'ASSISTANT_BILLING_INVALID_COST' });
  }
});


test('adapter charges never silently fall back to native tariffs when the adapter receipt is missing', () => {
  for (const adapter of ['openrouter', 'samsar', 'gmicloud']) {
    assert.throws(() => calculateAssistantRequestBilling({ model: 'gpt-6-astra',
      usage: { input_tokens: 1000 }, samsarBilling: { adapter } }),
    { code: 'ASSISTANT_BILLING_COST_REQUIRED' });
  }
});

test('an ambiguous provider timeout is retained and never automatically dispatched again', async () => {
  const h = harness();
  let calls = 0;
  h.options.generate = async () => { calls++; throw Object.assign(new Error('provider timed out'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(runAssistantRequest(h.options), { code: 'ETIMEDOUT' });
  assert.equal(h.store.records.get(h.options.id).status, 'BILLING_PENDING');
  await assert.rejects(runAssistantRequest(h.options), { code: 'ASSISTANT_PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
  assert.equal(h.account.debits, 0);
});

test('native image and other paid tool calls cannot complete with only the text portion billed', () => {
  for (const type of ['image_generation_call', 'web_search_call', 'file_search_call', 'code_interpreter_call']) {
    const response = { model: 'gpt-6-astra', usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type }] };
    assert.throws(() => calculateAssistantRequestBilling(response), { code: 'ASSISTANT_BILLING_TOOL_COST_REQUIRED' });
    response.samsarBilling = { adapter: 'openrouter', costUsd: 0.05 };
    assert.equal(calculateAssistantRequestBilling(response).credits, 6);
  }
});

test('malformed native token counts are retained for reconciliation instead of under-billed', () => {
  for (const usage of [{ input_tokens: -1, output_tokens: 10 },
    { input_tokens: 10, output_tokens: 'invalid' },
    { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 },
    { input_tokens: true, output_tokens: 10 }]) {
    assert.throws(() => calculateAssistantRequestBilling({ model: 'gpt-6-astra', usage }),
      { code: 'ASSISTANT_BILLING_INVALID_USAGE' });
  }
});

test('native responses with explicit zero token usage are free without a minimum debit', () => {
  const billing = calculateAssistantRequestBilling({ model: 'gpt-6-astra', usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(billing.credits, 0);
  assert.equal(billing.billable, true);
});


test('native tariff dates are frozen on the receipt across billing recovery', async () => {
  for (const [pricingTimestampMs, expected] of [[Date.UTC(2026, 10, 30), 0.36], [Date.UTC(2026, 11, 1), 0.72]]) {
    const h = harness();
    await h.store.ensure(h.options.id, { fingerprint: h.options.fingerprint, status: 'BILLING_PENDING', pricingTimestampMs,
      providerResponse: { model: 'gemini-4-argon', usage: { input_tokens: 1000, output_tokens: 100 } } });
    const result = await runAssistantRequest(h.options);
    assert.equal(result.creditsCharged, expected);
    assert.equal(h.providerCalls, 0);
  }
});

test('explicit client request ids identify the same work across sync, async and changing HTTP retry keys', () => {
  const payload = { messages: [{ role: 'user', content: 'Hi' }], client_request_id: 'client-key' };
  const sync = assistantRequestIdentity('user', 'external_chat', payload, 'http-key');
  const retry = assistantRequestIdentity('user', 'external_chat', { ...payload, async: true, client_session_id: 'session' }, 'other-http-key');
  const queued = assistantRequestIdentity('user', 'external_chat', { messages: payload.messages }, 'client-key');
  assert.deepEqual(sync, retry);
  assert.deepEqual(sync, queued);
});


test('a pre-dispatch admission rejection can resume under the same key after credits are restored', async () => {
  const h = harness();
  let admitted = false;
  h.options.admit = async () => { if (!admitted) throw new Error('Insufficient credits'); };
  await assert.rejects(runAssistantRequest(h.options), /Insufficient/);
  assert.equal(h.providerCalls, 0);
  admitted = true;
  await runAssistantRequest(h.options);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.account.debits, 1);
});
