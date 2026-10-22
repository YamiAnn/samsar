import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKlingLipSyncLayer } from './KlingLipSyncListener.js';

const payload = () => ({ _id: 'queued-request', model: 'KLINGLIPSYNC',
  videoBillingPolicy: 'adapter', videoLink: 'https://media.example/input.mp4',
  audioLink: 'https://media.example/audio.wav' });
const env = { SAMSAR_DEPLOYMENT_EDITION: 'production' };

test('Kling persists billable input duration before provider submission', async () => {
  const events = [];
  const job = payload();
  const requestId = await generateKlingLipSyncLayer(job, { env,
    probeDuration: async video => { assert.equal(video, job.videoLink); events.push('probe'); return 5.01; },
    persistNativeReceipt: async (id, receipt) => {
      assert.equal(id, job._id);
      assert.deepEqual(receipt, { adapter: 'fal', model: 'KLINGLIPSYNC', inputSeconds: 5.01 });
      events.push('persist');
    },
    queue: { submit: async endpoint => {
      assert.equal(endpoint, 'fal-ai/kling-video/lipsync/audio-to-video');
      events.push('submit');
      return { request_id: 'provider-request' };
    } },
  });
  assert.equal(requestId, 'provider-request');
  assert.deepEqual(events, ['probe', 'persist', 'submit']);
  assert.equal(job.videoBillingNativeReceipt.inputSeconds, 5.01);
});

test('Kling does not submit when pricing duration cannot be made durable', async () => {
  let submissions = 0;
  await assert.rejects(generateKlingLipSyncLayer(payload(), { env,
    probeDuration: async () => 5.01,
    persistNativeReceipt: async () => { throw new Error('database unavailable'); },
    queue: { submit: async () => { submissions++; return { request_id: 'should-not-exist' }; } },
  }), /database unavailable/);
  assert.equal(submissions, 0);
});

test('fixed-price pipeline requests retain their existing Kling submission path', async () => {
  const job = { ...payload(), videoBillingPolicy: 'pipeline' };
  const requestId = await generateKlingLipSyncLayer(job, { env,
    probeDuration: async () => assert.fail('No adapter-billed duration probe'),
    persistNativeReceipt: async () => assert.fail('No adapter-billed receipt'),
    queue: { submit: async () => ({ request_id: 'pipeline-request' }) },
  });
  assert.equal(requestId, 'pipeline-request');
});
