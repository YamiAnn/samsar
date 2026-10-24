import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEmbeddingCredits } from './ExternalEmbeddingAPI.js';

test('F2P: embeddings use the checked-in OpenAI native token price and twenty percent markup', () => {
  const billing = calculateEmbeddingCredits(1_000_000);
  assert.equal(billing.costUsd, 0.02);
  assert.equal(billing.credits, 2.4);
});

test('P2P: embedding cost scales by token usage and zero tokens have no debit', () => {
  const billing = calculateEmbeddingCredits(1000);
  assert.equal(billing.costUsd, 0.00002);
  assert.equal(billing.credits, 0.0024);
  assert.deepEqual(calculateEmbeddingCredits(0), { costUsd: 0, credits: 0 });
});
