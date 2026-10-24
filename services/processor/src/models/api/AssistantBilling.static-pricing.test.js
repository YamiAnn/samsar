import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAssistantCreditsFromUsage, calculateAssistantRequestBilling } from './AssistantBilling.js';
import { NARRATIVE_PRICING_MULTIPLIER } from './NarrativeBilling.js';

const response = () => ({ model: 'gpt-6-astra', usage: { input_tokens: 1000, output_tokens: 100 } });

test('F2P: reported provider money never changes the checked-in token tariff', () => {
  for (const costUsd of [0, 0.001, 999]) {
    const value = response();
    value.usage.cost = costUsd;
    value.samsarBilling = { adapter: 'openrouter', costUsd };
    const billed = calculateAssistantRequestBilling(value);
    assert.equal(billed.costUsd, 0.015);
    assert.equal(billed.credits, 1.8);
    assert.equal(billed.costSource, 'token_tariff');
  }
});

test('F2P: missing or malformed reported costs do not gate valid token usage', () => {
  for (const adapter of ['openrouter', 'samsar', 'gmicloud']) {
    for (const costUsd of [undefined, null, '', -1, Infinity, {}]) {
      const value = response();
      value.samsarBilling = { adapter, costUsd };
      assert.equal(calculateAssistantRequestBilling(value).credits, 1.8);
    }
  }
});

test('F2P: unknown models cannot be priced from a dynamic adapter charge', () => {
  const billed = calculateAssistantCreditsFromUsage({ model: 'unlisted-model',
    usage: { input_tokens: 1000, output_tokens: 100, cost: 0.1 },
    adapter: 'openrouter', adapterCostUsd: 0.1 });
  assert.equal(billed.billable, false);
});

test('F2P: narrative generation uses the shared twenty percent markup', () => {
  assert.equal(NARRATIVE_PRICING_MULTIPLIER, 1.2);
});

test('P2P: native cache and output usage retains its ordinary constant-rate calculation', () => {
  const billed = calculateAssistantRequestBilling({ model: 'gpt-6-astra',
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 } });
  assert.equal(billed.costUsd, 0.0105);
  assert.equal(billed.credits, 1.26);
});


test('P2P: native zero-token usage is retained without using reported money', () => {
  for (const usage of [
    { anthropic_usage: { input_tokens: 0, output_tokens: 0 } },
    { google_usage_metadata: { promptTokenCount: 0, candidatesTokenCount: 0 } },
  ]) {
    const billed = calculateAssistantRequestBilling({ model: 'gpt-6-astra', usage,
      samsarBilling: { adapter: 'samsar', costUsd: 999 } });
    assert.equal(billed.billable, true);
    assert.equal(billed.credits, 0);
  }
});
