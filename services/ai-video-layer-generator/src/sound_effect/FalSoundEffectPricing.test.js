import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSoundEffectMireloVideo, listenToPendingSoundEffectMireloVideoRequest } from './MireloAIVideoListener.js';
import { generateSoundEffectSyncedMMVideo } from './SoundEffectSyncedMMVideoListener.js';

test('new Mirelo calls submit one billed sample and snapshot pricing before POST', async () => {
  const events = [];
  const payload = { _id: 'queue', model: 'MIRELOAI', duration: 5,
    videoLink: 'https://example.test/input.mp4', prompt: 'foley', videoBillingPolicy: 'adapter' };
  const id = await generateSoundEffectMireloVideo(payload, {
    env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    persistNativeReceipt: async (queueId, receipt) => {
      events.push('persist');
      assert.equal(queueId, 'queue');
      assert.deepEqual(receipt, { adapter: 'fal', model: 'MIRELOAI', requestedSeconds: 5,
        submittedSamples: 1 });
    },
    queue: { submit: async (endpoint, request) => {
      events.push('submit');
      assert.equal(endpoint, 'mirelo-ai/sfx1.6/video-to-video');
      assert.equal(request.input.duration, 5);
      assert.equal(request.input.num_samples, 1);
      return { request_id: 'provider-id' };
    } },
  });
  assert.equal(id, 'provider-id');
  assert.deepEqual(events, ['persist', 'submit']);
});

test('Mirelo completion captures every generated sample count while delivering the first', async () => {
  const result = await listenToPendingSoundEffectMireloVideoRequest({ generationId: 'existing' }, {
    queue: { status: async () => ({ status: 'COMPLETED' }),
      result: async () => ({ data: { video: [
        { url: 'https://example.test/first.mp4' }, { url: 'https://example.test/second.mp4' },
      ] } }) },
  });
  assert.equal(result.remoteUrl, 'https://example.test/first.mp4');
  assert.equal(result.videoBillingReceipt.sampleCount, 2);
});

test('MMAudio preserves Fal eight-second default explicitly and snapshots it', async () => {
  const payload = { _id: 'queue', model: 'MMAUDIOV2', duration: 5,
    videoLink: 'https://example.test/input.mp4', prompt: 'foley', videoBillingPolicy: 'adapter' };
  await generateSoundEffectSyncedMMVideo(payload, {
    env: { SAMSAR_DEPLOYMENT_EDITION: 'production' },
    persistNativeReceipt: async (_id, receipt) => {
      assert.equal(receipt.requestedSeconds, 8);
      assert.equal(receipt.submittedSamples, 1);
    },
    queue: { submit: async (endpoint, request) => {
      assert.equal(endpoint, 'fal-ai/mmaudio-v2');
      assert.equal(request.input.duration, 8);
      return { request_id: 'provider-id' };
    } },
  });
});
