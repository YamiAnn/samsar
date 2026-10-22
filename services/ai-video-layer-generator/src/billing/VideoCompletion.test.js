import test from 'node:test';
import assert from 'node:assert/strict';
import { completeVideoOutput } from './VideoCompletion.js';
import { buildFalVideoSubmissionReceipt } from './FalVideoTariffs.js';
import { attachLocalVideoBillingResult, billCompletedVideo } from './VideoRequestBilling.js';
import { resolveVideoAdapterReceipt } from './VideoAdapterReceipt.js';

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

test('completed lip sync retains the submitted pricing duration in its receipt', async () => {
  for (const [model, native, durationField, expected] of [
    ['KLINGLIPSYNC', { inputSeconds: 5.01, costUsd: 0, model: 'other' }, 'inputSeconds', 5.01],
    ['HUMMINGBIRDLIPSYNC', null, 'requestedSeconds', 7],
  ]) {
    let retained;
    await completeVideoOutput({ _id: 'queue', model, duration: 7,
      videoBillingPolicy: 'adapter', submittedAdapter: 'fal', generationId: 'provider-id',
      videoBillingNativeReceipt: native }, { remoteUrl: 'https://provider.example/result.mp4' }, {
      env: {}, retain: async (_job, saved) => { retained = saved; },
      checkpoint: async () => {}, bill: async () => ({}), recordCharge: async () => {},
      download: async () => '/saved/output.mp4', deliver: async () => {},
    });
    assert.equal(retained.videoBillingReceipt[durationField], expected);
    assert.equal(retained.videoBillingReceipt.providerRequestId, 'provider-id');
    assert.equal(Object.hasOwn(retained.videoBillingReceipt, 'costUsd'), false);
    assert.equal(retained.videoBillingReceipt.model, model);
  }
});

test('new and legacy sound completions retain their submitted seconds and sample count', async () => {
  for (const [model, native, responseReceipt, expectedSeconds, expectedSamples, source] of [
    ['MIRELOAI', { requestedSeconds: 5, submittedSamples: 1 }, { sampleCount: 1 }, 5, 1, 'provider_result'],
    ['MIRELOAI', null, { sampleCount: 2 }, 5, 2, 'provider_result'],
    ['MMAUDIOV2', null, null, 8, 1, 'legacy_default'],
  ]) {
    let retained;
    await completeVideoOutput({ _id: 'queue', model, duration: 5,
      videoBillingPolicy: 'adapter', submittedAdapter: 'fal', generationId: 'provider-id',
      videoBillingNativeReceipt: native }, { remoteUrl: 'https://provider.example/result.mp4',
        videoBillingReceipt: responseReceipt }, {
      env: {}, retain: async (_job, saved) => { retained = saved; },
      checkpoint: async () => {}, bill: async () => ({}), recordCharge: async () => {},
      download: async () => '/saved/output.mp4', deliver: async () => {},
    });
    assert.equal(retained.videoBillingReceipt.requestedSeconds, expectedSeconds);
    assert.equal(retained.videoBillingReceipt.sampleCount, expectedSamples);
    assert.equal(retained.videoBillingReceipt.sampleCountSource, source);
    assert.equal(retained.videoBillingReceipt.adapter, 'fal');
    assert.equal(retained.videoBillingReceipt.providerRequestId, 'provider-id');
  }
});

test('completed Fal video carries the pre-submission tariff into its durable output', async () => {
  const native = buildFalVideoSubmissionReceipt({ model: 'KLINGIMGTOVID3PRO',
    duration: 10, generateAudio: true });
  let retained;
  await completeVideoOutput({ _id: 'queue', model: 'KLINGIMGTOVID3PRO',
    videoBillingPolicy: 'adapter', submittedAdapter: 'fal', generationId: 'provider-id',
    videoBillingNativeReceipt: native }, { remoteUrl: 'https://provider.example/result.mp4',
      videoBillingReceipt: { costUsd: 0 } }, {
    env: {}, retain: async (_job, saved) => { retained = saved; },
    checkpoint: async () => {}, bill: async () => ({}), recordCharge: async () => {},
    download: async () => '/saved/output.mp4', deliver: async () => {},
  });
  assert.equal(retained.videoBillingReceipt.tariffRateUsd, 0.168);
  assert.equal(retained.videoBillingReceipt.submittedQuantity, 10);
  assert.equal(retained.videoBillingReceipt.providerRequestId, 'provider-id');
});

test('a paid token video settles from the saved local clip after a retry, even when its remote URL cannot be probed', async () => {
  const receipts = new Map();
  const events = [];
  let debits = 0;
  let downloads = 0;
  let billAttempts = 0;
  const store = {
    async ensure(id, fields) {
      if (!receipts.has(id)) receipts.set(id, { _id: id, ...structuredClone(fields) });
      return structuredClone(receipts.get(id));
    },
    async attachLocalResult(id, identity, path) {
      const receipt = receipts.get(id);
      assert.equal(receipt.userId, identity.userId);
      assert.equal(receipt.result.remoteUrl, identity.remoteUrl);
      assert.equal(receipt.adapterReceipt.adapter, identity.adapter);
      assert.equal(receipt.adapterReceipt.model, identity.model);
      assert.equal(receipt.adapterReceipt.providerRequestId, identity.providerRequestId);
      if (!receipt.result.localVideoLink) receipt.result.localVideoLink = path;
      events.push('financial local checkpoint');
      return structuredClone(receipt);
    },
    async saveBilling(id, billing) {
      const receipt = receipts.get(id);
      receipt.billing ||= structuredClone(billing);
      return structuredClone(receipt);
    },
    async complete(id, fields) {
      const receipt = receipts.get(id);
      Object.assign(receipt, fields, { status: 'COMPLETED' });
      return structuredClone(receipt);
    },
  };
  const payload = { _id: 'token-job', sessionId: 'session', layerId: 'layer', userId: 'owner',
    model: 'SEEDANCE2.0I2V', submittedAdapter: 'fal', generationId: 'upstream-token-job',
    videoBillingPolicy: 'adapter', videoBillingNativeReceipt: buildFalVideoSubmissionReceipt({
      model: 'SEEDANCE2.0I2V', duration: 5 }) };
  const deps = {
    env: {},
    retain: async (job, result) => {
      events.push('retain');
      return billCompletedVideo(job, result, { store, deferSettlement: true });
    },
    checkpoint: async () => events.push('queue checkpoint'),
    download: async () => { downloads++; events.push('download'); return '/saved/token-video.mp4'; },
    attachLocalBillingResult: (job, result) => attachLocalVideoBillingResult(job, result, { store }),
    bill: async (job, result) => {
      billAttempts++;
      events.push('bill');
      if (billAttempts === 1) throw new Error('temporary billing outage');
      return billCompletedVideo(job, result, { store,
        charge: async () => { debits++; return { remainingCredits: 100 }; },
        resolveReceipt: (receipt, context) => resolveVideoAdapterReceipt(receipt, context, {
          probeVideo: async path => {
            assert.equal(path, '/saved/token-video.mp4');
            return { width: 1024, height: 1024, seconds: 5, framesPerSecond: 24 };
          },
        }) });
    },
    recordCharge: async () => {},
    deliver: async (_job, path) => { assert.equal(path, '/saved/token-video.mp4'); events.push('deliver'); },
  };
  await assert.rejects(completeVideoOutput(payload,
    { remoteUrl: 'https://provider.example/expired-signed-url' }, deps),
  error => error.videoBillingPending === true);
  const retained = [...receipts.values()][0];
  assert.equal(retained.result.localVideoLink, '/saved/token-video.mp4');
  assert.equal(retained.status, 'PENDING');
  assert.deepEqual(events.slice(0, 5),
    ['retain', 'queue checkpoint', 'download', 'financial local checkpoint', 'queue checkpoint']);
  await completeVideoOutput(structuredClone(payload), undefined, deps);
  assert.equal(downloads, 1);
  assert.equal(debits, 1);
  assert.equal(retained.status, 'COMPLETED');
  assert.equal(retained.billing.billingBasis, 'thousandVideoTokens');
  assert.equal(retained.billing.costUsd, 1.72032);
  assert.equal(events.at(-1), 'deliver');
});

test('a local billing update rejects another provider receipt with the same call ID', async () => {
  const payload = { _id: 'queue', userId: 'owner', submittedAdapter: 'fal', generationId: 'provider-a' };
  const result = { remoteUrl: 'https://provider.example/a', localVideoLink: '/saved/a.mp4',
    videoBillingReceipt: { adapter: 'fal', model: 'SEEDANCE2.0I2V', providerRequestId: 'provider-a' } };
  await assert.rejects(attachLocalVideoBillingResult(payload, result, {
    store: { attachLocalResult: async () => ({ userId: 'owner', status: 'PENDING', billing: null,
      result: { remoteUrl: 'https://provider.example/a', localVideoLink: '/saved/a.mp4' },
      adapterReceipt: { adapter: 'fal', model: 'SEEDANCE2.0I2V', providerRequestId: 'provider-b' } }) },
  }), /conflicts/);
});

test('a retry uses the matching financial receipt local path when it beat the queue checkpoint', async () => {
  const payload = { _id: 'queue', userId: 'owner', sessionId: 'session', layerId: 'layer',
    submittedAdapter: 'fal', generationId: 'provider-a', model: 'SYNCLIPSYNC',
    videoBillingPolicy: 'adapter', videoBillingSavedResult: {
      remoteUrl: 'https://provider.example/a',
      videoBillingReceipt: { adapter: 'fal', model: 'SYNCLIPSYNC', providerRequestId: 'provider-a' },
    } };
  let billedPath;
  let deliveredPath;
  await completeVideoOutput(payload, undefined, {
    env: {}, download: async () => '/saved/second-download.mp4',
    attachLocalBillingResult: (job, result) => attachLocalVideoBillingResult(job, result, {
      store: { attachLocalResult: async () => ({ userId: 'owner', status: 'PENDING', billing: null,
        result: { remoteUrl: 'https://provider.example/a', localVideoLink: '/saved/first-download.mp4' },
        adapterReceipt: { adapter: 'fal', model: 'SYNCLIPSYNC', providerRequestId: 'provider-a' } }) },
    }),
    checkpoint: async () => {}, bill: async (_job, result) => {
      billedPath = result.localVideoLink;
      return { billing: { credits: 1 } };
    },
    recordCharge: async () => {},
    deliver: async (_job, path) => { deliveredPath = path; },
  });
  assert.equal(billedPath, '/saved/first-download.mp4');
  assert.equal(deliveredPath, '/saved/first-download.mp4');
});
