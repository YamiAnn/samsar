import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableSyncLipSyncPollError,
  listenToPendingSyncLipSyncRequests,
} from './SyncLipSyncListener.js';

const request = {
  generationId: 'accepted-fal-request',
  model: 'SYNCLIPSYNC',
  requestSubmitAt: new Date(Date.now() - 20 * 60_000),
};
const connect = async () => {};

test('Sync lip sync keeps an accepted FAL job pending after a status timeout', async (t) => {
  t.mock.method(console, 'error', () => {});
  let resultCalls = 0;
  const queue = {
    status: async () => { throw Object.assign(new Error('Gateway Timeout'), { status: 504 }); },
    result: async () => { resultCalls += 1; },
  };
  assert.deepEqual(await listenToPendingSyncLipSyncRequests(request, { connect, queue }), {
    responseStatus: 'PENDING',
  });
  assert.equal(resultCalls, 0);
});

test('Sync lip sync retries a completed FAL job when result fetch times out', async (t) => {
  t.mock.method(console, 'error', () => {});
  let resultCalls = 0;
  const queue = {
    status: async () => ({ status: 'COMPLETED' }),
    result: async () => {
      resultCalls += 1;
      if (resultCalls === 1) throw Object.assign(new Error('Gateway Timeout'), { status: 504 });
      return { data: { video: { url: 'https://media.example.com/result.mp4' } } };
    },
  };
  assert.deepEqual(await listenToPendingSyncLipSyncRequests(request, { connect, queue }), {
    responseStatus: 'PENDING',
  });
  assert.deepEqual(await listenToPendingSyncLipSyncRequests(request, { connect, queue }), {
    responseStatus: 'COMPLETED', remoteUrl: 'https://media.example.com/result.mp4',
  });
  assert.equal(resultCalls, 2);
});

test('Sync lip sync retains definitive provider failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  const providerFailed = await listenToPendingSyncLipSyncRequests(request, {
    connect, queue: { status: async () => ({ status: 'FAILED' }) },
  });
  assert.equal(providerFailed.responseStatus, 'FAILED');
  const rejected = await listenToPendingSyncLipSyncRequests(request, {
    connect, queue: { status: async () => { throw Object.assign(new Error('Invalid request'), { status: 422 }); } },
  });
  assert.equal(rejected.responseStatus, 'FAILED');
  assert.equal(isRetryableSyncLipSyncPollError({ status: 504 }), true);
  assert.equal(isRetryableSyncLipSyncPollError({ status: 422 }), false);
});
