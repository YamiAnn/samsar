import test from 'node:test';
import assert from 'node:assert/strict';
import { completeVideoOutput } from './VideoCompletion.js';

for (const phase of ['bill', 'recordCharge', 'deliver']) {
  test(`${phase} failure resumes the original clip without another provider call or download`, async () => {
    const payload = { _id: 'job', sessionId: 'session', layerId: 'layer', userId: 'owner',
      videoBillingPolicy: 'adapter', submittedAdapter: 'fal', generationId: 'upstream' };
    let downloads = 0, checkpoints = 0, failed = false;
    const deps = { env: {}, download: async () => { downloads++; return '/clip.mp4'; },
      checkpoint: async () => { checkpoints++; }, bill: async () => ({ billing: { credits: 12 } }),
      recordCharge: async () => {}, deliver: async () => {} };
    const normal = deps[phase];
    deps[phase] = async (...args) => { if (!failed) { failed = true; throw new Error('temporary outage'); } return normal(...args); };
    await assert.rejects(completeVideoOutput(payload, { remoteUrl: 'https://provider/clip' }, deps),
      error => error.videoBillingPending === true);
    const restarted = structuredClone(payload);
    await completeVideoOutput(restarted, undefined, deps);
    assert.equal(downloads, 1);
    assert.equal(checkpoints, 2);
  });
}

test('checkpoint failure cannot debit or deliver and does not mark generation failed', async () => {
  let charged = false;
  await assert.rejects(completeVideoOutput({ videoBillingPolicy: 'adapter' }, { remoteUrl: 'clip' }, {
    env: {}, download: async () => '/clip.mp4', checkpoint: async () => { throw new Error('database outage'); },
    bill: async () => { charged = true; }, deliver: async () => assert.fail('unbilled delivery'),
  }), error => error.videoBillingPending === true);
  assert.equal(charged, false);
});

test('financial retention precedes queue checkpoint, debit, download and delivery', async () => {
  const events = [];
  await completeVideoOutput({ videoBillingPolicy: 'adapter' }, { remoteUrl: 'https://provider/clip' }, {
    env: {}, retain: async () => events.push('retain'), checkpoint: async () => events.push('checkpoint'),
    bill: async () => { events.push('debit'); return {}; }, recordCharge: async () => {},
    download: async () => { events.push('download'); return '/clip.mp4'; },
    deliver: async () => events.push('deliver'),
  });
  assert.deepEqual(events, ['retain', 'checkpoint', 'debit', 'download', 'checkpoint', 'deliver']);
});
