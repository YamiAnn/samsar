import test from 'node:test';
import assert from 'node:assert/strict';
import { readVideoModelCreditTotal } from './VideoModelStatusBilling.js';

test('reroll status combines only this session image/video debits without inherited pipeline charges', async () => {
  const session = { _id: 'reroll', userId: 'owner', videoBillingPolicy: 'adapter',
    expressGenerationCreditCharges: { totalCharged: 500 } };
  const Ledger = { find(query) {
    assert.equal(query['metadata.sessionId'], 'reroll');
    assert.equal(query.userId, 'owner');
    assert.equal(query.direction, 'debit');
    assert.deepEqual(query.source.$in, ['image_model_completion', 'video_model_completion']);
    return { select: () => ({ lean: async () => [{ amount: 4.8 }, { amount: 72 }, { amount: 1.2 }] }) };
  } };
  assert.equal(await readVideoModelCreditTotal(session, Ledger), 78);
});

test('production agent status retains its flat receipt without reading per-call debits', async () => {
  assert.equal(await readVideoModelCreditTotal({ expressGenerationCreditCharges: { totalCharged: 500 } },
    { find: () => assert.fail('fixed pricing must remain unchanged') }), null);
});
