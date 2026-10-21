import assert from 'node:assert/strict';
import test from 'node:test';
import { listenToAssistantQueryRequests } from './AssistantQueryListener.js';
import AssistantBillingRequest from './schema/AssistantBillingRequest.js';
import GenerationCreditTransaction from './schema/GenerationCreditTransaction.js';
import User from './schema/User.js';

test('the deployed assistant worker loads its real billing models without connecting or starting inference', () => {
  assert.equal(typeof listenToAssistantQueryRequests, 'function');
  assert.equal(AssistantBillingRequest.collection.name, 'assistant_billing_requests');
  assert.ok(User.schema.path('generationCreditDebitReservations'));
  assert.ok(GenerationCreditTransaction.schema.indexes().some(([fields, options]) => fields.idempotencyKey && options.unique));
});
