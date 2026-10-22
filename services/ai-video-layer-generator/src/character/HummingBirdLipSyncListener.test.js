import test from 'node:test';
import assert from 'node:assert/strict';
import { fal } from '@fal-ai/client';

import { generateHummingBirdLipSyncLayer } from './HummingBirdLipSyncListener.js';

test('HummingBird submit preserves the provider error for worker failure handling', async (t) => {
  const providerError = Object.assign(new Error('Fal rejected the lip sync request'), {
    status: 422,
    body: { detail: 'Invalid video input' },
  });
  t.mock.method(fal.queue, 'submit', async (endpoint, request) => {
    assert.equal(endpoint, 'fal-ai/tavus/hummingbird-lipsync/v0');
    assert.deepEqual(request.input, {
      video_url: 'https://example.com/video.mp4',
      audio_url: 'https://example.com/audio.wav',
    });
    throw providerError;
  });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));

  await assert.rejects(generateHummingBirdLipSyncLayer({
    sessionId: 'session-1',
    layerId: 'layer-1',
    model: 'HUMMINGBIRDLIPSYNC',
    videoLink: 'https://example.com/video.mp4',
    audioLink: 'https://example.com/audio.wav',
  }), (error) => error === providerError);

  assert.match(logs[0][0], /hummingbird.*submit_failed/);
  assert.equal(logs[0][1].error.status, 422);
  assert.deepEqual(logs[0][1].error.body, providerError.body);
});
