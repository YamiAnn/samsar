import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { assistantRequestIdentity, runAssistantRequest, debitAssistantOwnerOnce } from './AssistantRequestBilling.js';
import { memoryCreditAccount, memoryRequestStore } from './test_helpers/AssistantBillingHarness.js';

const source = fs.readFileSync(new URL('./AssistantQueryListener.js', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;[^\n]*$/gm, '').replace(/export /g, '');

function harness({ standalone = false } = {}) {
  const store = memoryRequestStore();
  const account = memoryCreditAccount();
  const state = { providerCalls: 0, deliveries: 0, jobs: [{ _id: 'job', sessionId: 'session', queryId: 'query', rowLocked: false }] };
  const session = { userId: 'user', sessionMessages: [{ role: 'user', id: 'query', content: 'Hello' }], async save() {} };
  const context = vm.createContext({
    assistantRequestIdentity, runAssistantRequest, debitAssistantOwnerOnce,
    AssistantBillingRequest: { find: () => ({ limit: () => ({ lean: async () => [...store.records.values()]
      .filter(r => r.providerResponse && r.status !== 'COMPLETED') }) }) },
    createMongoAssistantRequestStore: () => store,
    GenerationCreditTransaction: account.Ledger,
    AssistantQueryGeneration: {
      find: async () => structuredClone(state.jobs.filter(j => !j.rowLocked || Number(j.workerLeaseExpiresAt) <= Date.now())),
      updateOne: async (filter, update) => {
        const job = state.jobs.find(j => j._id === filter._id);
        if (!job) return { modifiedCount: 0 };
        if (filter.$or && job.rowLocked && Number(job.workerLeaseExpiresAt) > Date.now()) return { modifiedCount: 0 };
        Object.assign(job, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) delete job[key];
        return { modifiedCount: 1 };
      },
      deleteOne: async ({ _id }) => { state.jobs = state.jobs.filter(j => j._id !== _id); },
    },
    VideoSession: {
      findOne: async () => session,
      updateOne: async (_query, update) => {
        const message = update.$push?.sessionMessages;
        if (message && !session.sessionMessages.some(m => m.role === 'assistant' && m.id === message.id)) {
          state.deliveries++;
          session.sessionMessages.push(message);
        }
        Object.assign(session, update.$set || {});
        return { modifiedCount: 1 };
      },
    },
    User: { ...account.Owner, findOne: () => Object.assign(Promise.resolve(structuredClone(account.account)),
      { lean: async () => structuredClone(account.account) }) },
    sendAssistantCompletionRequest: async (_messages, _model, options) => {
      assert.equal(options.maxRetries, 0);
      assert.ok(options.assistantBillingRequestId);
      state.providerCalls++;
      return { response: { id: 'provider-response', model: 'any/model', usage: { cost: 0.025 },
        samsarBilling: { adapter: 'openrouter', costUsd: 0.025 } }, outputText: 'Hello', outputContent: ['Hello'] };
    },
    getSystemPrompt: () => ({ role: 'system', content: 'System' }),
    isStandaloneEdition: () => standalone,
    isGeminiInferenceModel: () => false, isKimiK3InferenceModel: () => false,
    normalizeInferenceModel: () => 'model', console: { error() {} },
  });
  vm.runInContext(source, context);
  const processPending = () => vm.runInContext('processPendingAssistantRequests()', context);
  const recover = () => vm.runInContext('recoverPendingAssistantBilling()', context);
  return { store, account, state, session, processPending, recover, context };
}

test('two hosted assistant workers claim one job, invoke once, debit once and deliver once', async () => {
  const h = harness();
  await Promise.all([h.processPending(), h.processPending()]);
  assert.equal(h.state.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.account.account.generationCredits, 97);
  assert.equal(h.account.transactions.size, 1);
  assert.equal(h.state.deliveries, 1);
  assert.equal(h.state.jobs.length, 0);
});

test('queued billing survives a ledger outage and restarts without another provider call or debit', async () => {
  const h = harness();
  const insert = h.account.Ledger.updateOne;
  let attempts = 0;
  h.account.Ledger.updateOne = (...args) => { if (++attempts === 1) throw new Error('ledger outage'); return insert(...args); };
  await h.processPending();
  assert.equal(h.account.debits, 1);
  assert.equal(h.state.jobs.length, 1);
  assert.equal(h.state.jobs[0].rowLocked, false);
  assert.equal(h.state.jobs[0].expireAt, undefined);
  await h.processPending();
  assert.equal(h.state.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.account.transactions.size, 1);
  assert.equal(h.state.deliveries, 1);
});

test('the saved billing receipt can settle without the old TTL queue document', async () => {
  const h = harness();
  const insert = h.account.Ledger.updateOne;
  h.account.Ledger.updateOne = async () => { throw new Error('outage'); };
  await h.processPending();
  h.state.jobs = [];
  h.account.Ledger.updateOne = insert;
  await h.recover();
  assert.equal(h.state.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.account.transactions.size, 1);
  assert.equal(h.state.deliveries, 1);
});

test('session delivery failure recovers one queued debit and one output message', async () => {
  const h = harness();
  const update = h.context.VideoSession.updateOne;
  let attempts = 0;
  h.context.VideoSession.updateOne = (...args) => { if (++attempts === 1) throw new Error('session outage'); return update(...args); };
  await h.processPending();
  await h.recover();
  await h.processPending();
  assert.equal(h.state.providerCalls, 1);
  assert.equal(h.account.debits, 1);
  assert.equal(h.state.deliveries, 1);
});

test('an empty account is rejected before queued provider work', async () => {
  const h = harness();
  h.account.account.generationCredits = 0;
  await h.processPending();
  assert.equal(h.state.providerCalls, 0);
  assert.equal(h.account.debits, 0);
  assert.equal(h.state.jobs.length, 0);
  assert.equal(h.session.sessionMessageGenerationError, 'Insufficient credits');
});

test('standalone queued assistants retain their no-local-debit policy', async () => {
  const h = harness({ standalone: true });
  h.account.account.generationCredits = 0;
  await h.processPending();
  assert.equal(h.state.providerCalls, 1);
  assert.equal(h.account.debits, 0);
  assert.equal(h.state.deliveries, 1);
});
