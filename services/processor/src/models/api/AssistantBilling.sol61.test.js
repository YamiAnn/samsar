import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAssistantCreditsFromUsage } from './AssistantBilling.js';

test('prices Sol 6.1 cached input and long context independently of historical Astra receipts', () => {
  for (const model of ['gpt-6.1-sol', 'openai/gpt-6.1-sol']) {
    const regular = calculateAssistantCreditsFromUsage({ model, usage: {
      input_tokens: 100_000, input_tokens_details: { cached_tokens: 20_000 }, output_tokens: 10_000,
    }, pricingMultiplier: 1 });
    assert.equal(regular.pricingModel, 'gpt-6.1-sol');
    assert.equal(regular.costUsd, 0.262);
    const long = calculateAssistantCreditsFromUsage({ model, usage: {
      input_tokens: 300_000, input_tokens_details: { cached_tokens: 100_000 }, output_tokens: 100_000,
    }, pricingMultiplier: 1 });
    assert.equal(long.costUsd, 2.32);
    assert.equal(long.tokenPricingUsdPerMillion.longContext, true);
  }
  const historical = calculateAssistantCreditsFromUsage({ model: 'gpt-6-astra',
    usage: { input_tokens: 100_000, output_tokens: 100_000 }, pricingMultiplier: 1 });
  assert.equal(historical.costUsd, 6);
});
