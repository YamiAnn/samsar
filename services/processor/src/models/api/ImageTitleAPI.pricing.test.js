import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAssignTitleBilling } from './ImageTitleAPI.js';

const step = (usage, extra = {}) => ({ step: 'title_generation',
  response: { model: 'gpt-6-astra', usage, ...extra } });

test('F2P: image title requests price measured tokens with twenty percent markup', () => {
  const billing = calculateAssignTitleBilling([
    step({ input_tokens: 1000, output_tokens: 100, cost: 999 }, { samsarBilling: { costUsd: 999 } }),
    step({ input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 }),
  ]);
  assert.equal(billing.costUsd, 0.0255);
  assert.equal(billing.credits, 3.06);
  assert.equal(billing.pricingMultiplier, 1.2);
});

test('F2P: a title receipt without measured usage cannot invent a flat charge', () => {
  assert.throws(() => calculateAssignTitleBilling([step(undefined)]), /no billable token usage/);
  assert.throws(() => calculateAssignTitleBilling([step({ input_tokens: 1000 }, { model: 'unlisted-model' })]),
    { code: 'ASSISTANT_BILLING_TARIFF_UNAVAILABLE' });
});

test('P2P: explicit zero-token title receipts remain free without a minimum charge', () => {
  const billing = calculateAssignTitleBilling([step({ input_tokens: 0, output_tokens: 0 })]);
  assert.equal(billing.credits, 0);
  assert.equal(billing.fallbackApplied, false);
});
