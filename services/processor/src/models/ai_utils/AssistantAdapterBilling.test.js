import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenRouterChatCompletion, shouldUseSamsarExternalInference,
  unwrapSamsarExternalChatCompletionResponse } from './SamsarExternalInferenceAdapter.js';
import { calculateAssistantRequestBilling } from '../api/AssistantBilling.js';

for (const model of ['gpt-6-astra', 'gemini-4-argon', 'qwen3.8-max', 'claude-opus-5.5']) {
  test(`OpenRouter ${model} preserves its actual charge and cache usage for 20% billing`, async () => {
    const response = await createOpenRouterChatCompletion({ model, maxRetries: 0,
      messages: [{ role: 'user', content: 'Hello' }], assistantBillingRequestId: 'request' }, {
      openRouterClient: { chat: { completions: { create: async (payload, options) => {
        assert.equal(payload.assistantBillingRequestId, undefined);
        assert.equal(options.maxRetries, 0);
        return { model, choices: [], usage: { cost: 0.0325, prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
          completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 80 } } };
      } } } },
    });
    assert.equal(response.samsarBilling.costUsd, 0.0325);
    assert.equal(response.usage.prompt_tokens_details.cached_tokens, 800);
    assert.equal(calculateAssistantRequestBilling(response).credits, 3.9);
  });
}

test('the public assistant routing bypass permits an explicit third-party adapter and prevents Samsar recursion', () => {
  assert.equal(shouldUseSamsarExternalInference({ model: 'gpt-6-astra', authorization: 'openrouter',
    bypassSamsarExternalInference: true, assistantBillingRequestId: 'request' }), true);
  assert.equal(shouldUseSamsarExternalInference({ model: 'gpt-6-astra', authorization: 'openrouter',
    bypassSamsarExternalInference: true }), false);
  assert.equal(shouldUseSamsarExternalInference({ model: 'gpt-6-astra', authorization: 'deployed',
    bypassSamsarExternalInference: true }), false);
});

test('Samsar SDK sync headers, async bodies and zero-cost receipts all preserve the adapter charge', () => {
  const completion = { id: 'chat', model: 'unknown/model', choices: [], usage: { prompt_tokens: 999 } };
  for (const envelope of [
    { data: completion, headers: { 'x-credits-charged': '3.25' } },
    { data: { response: completion, creditsCharged: 3.25 } },
    { response: completion, creditsCharged: 3.25 },
  ]) {
    assert.equal(calculateAssistantRequestBilling(unwrapSamsarExternalChatCompletionResponse(envelope)).credits, 3.9);
  }
  assert.equal(calculateAssistantRequestBilling(unwrapSamsarExternalChatCompletionResponse({ data: completion,
    headers: { 'x-credits-charged': '0' } })).credits, 0);
});
