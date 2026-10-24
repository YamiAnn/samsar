import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getVideoRequestListSessionIds,
  resolveVideoRequestListResult,
} from './VideoRequestListStatus.js';

const sessionId = '6ada34791c392379bf19fff2';
const userId = '6ada34791c392379bf19fff3';
const finalLink = `assets_v2/video/output/${sessionId}/final.mp4`;

function globalSession(overrides = {}) {
  return { sessionId, sessionType: 'video', userId, status: 'PENDING', ...overrides };
}

function videoSession(overrides = {}) {
  return {
    _id: sessionId,
    userId,
    videoGenerationPending: false,
    expressGenerationFailed: false,
    expressGenerationCancelled: false,
    expressGenerationStatus: { status: 'COMPLETED', video_generation: 'COMPLETED' },
    videoLink: finalLink,
    remoteURL: `https://static.samsar.one/${finalLink}?Expires=1&Signature=private`,
    ...overrides,
  };
}

function withDockerLocalMedia(callback) {
  const previousMode = process.env.SAMSAR_MEDIA_DELIVERY_MODE;
  const previousProcessorApi = process.env.PROCESSOR_API;
  process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
  process.env.PROCESSOR_API = 'http://localhost:3002';
  try {
    callback();
  } finally {
    if (previousMode === undefined) delete process.env.SAMSAR_MEDIA_DELIVERY_MODE;
    else process.env.SAMSAR_MEDIA_DELIVERY_MODE = previousMode;
    if (previousProcessorApi === undefined) delete process.env.PROCESSOR_API;
    else process.env.PROCESSOR_API = previousProcessorApi;
  }
}

test('collects only unresolved video IDs once for a batched owned lookup', () => {
  assert.deepEqual(getVideoRequestListSessionIds([
    globalSession(),
    globalSession({ status: 'PROCESSING' }),
    globalSession({ status: 'ARCHIVED' }),
    globalSession({ sessionType: 'image' }),
    globalSession({ sessionId: 'provider-id' }),
  ]), [sessionId]);
});

test('reconciles an old pending video mapping from completed output without exposing a signed URL', () => {
  withDockerLocalMedia(() => {
    const result = resolveVideoRequestListResult(globalSession(), videoSession());
    assert.deepEqual(result, {
      status: 'COMPLETED',
      resultUrl: `http://localhost:3002/${finalLink}`,
      resultUrls: [`http://localhost:3002/${finalLink}`],
    });
    assert.equal(JSON.stringify(result).includes('Signature=private'), false);
  });
});

test('leaves active, ambiguous, archived, and cross-owner sessions unchanged', () => {
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    videoGenerationPending: true,
  })), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    expressGenerationPending: true,
  })), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    expressGenerationStatus: { status: 'PENDING', video_generation: 'PENDING' },
  })), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    expressGenerationStatus: {},
  })), null);
  assert.equal(resolveVideoRequestListResult(globalSession({ status: 'ARCHIVED' }), videoSession()), null);
  assert.equal(resolveVideoRequestListResult(globalSession({ status: 'FAILED' }), videoSession()), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({ userId: 'other-user' })), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    videoLink: 'https://private-provider.example/video.mp4?token=secret',
  })), null);
  assert.equal(resolveVideoRequestListResult(globalSession(), videoSession({
    videoLink: `${finalLink}?token=secret`,
  })), null);
});

test('reports explicit final failure and cancellation for stale pending mappings', () => {
  assert.deepEqual(resolveVideoRequestListResult(globalSession(), videoSession({
    expressGenerationFailed: true,
    expressGenerationStatus: { status: 'FAILED', video_generation: 'FAILED' },
  })), { status: 'FAILED' });
  assert.deepEqual(resolveVideoRequestListResult(globalSession(), videoSession({
    expressGenerationCancelled: true,
    expressGenerationStatus: { status: 'CANCELLED', video_generation: 'CANCELLED' },
  })), { status: 'CANCELLED' });
});

test('requires every branch video output before reconciling a branched session', () => {
  const branch = videoSession({
    narrativeType: 'branched',
    defaultBranchPathId: 'first',
    branchRenderPaths: [
      {
        pathId: 'first',
        frameGenerationStatus: 'COMPLETED',
        videoGenerationStatus: 'COMPLETED',
        videoLink: `assets_v2/video/output/${sessionId}/first.mp4`,
      },
      {
        pathId: 'second',
        frameGenerationStatus: 'COMPLETED',
        videoGenerationStatus: 'PENDING',
        videoLink: null,
      },
    ],
  });
  assert.equal(resolveVideoRequestListResult(globalSession(), branch), null);
  branch.branchRenderPaths[1].videoGenerationStatus = 'COMPLETED';
  branch.branchRenderPaths[1].videoLink = `assets_v2/video/output/${sessionId}/second.mp4`;
  withDockerLocalMedia(() => {
    const result = resolveVideoRequestListResult(globalSession(), branch);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.resultUrl, `http://localhost:3002/assets_v2/video/output/${sessionId}/first.mp4`);
    assert.equal(result.resultUrls.length, 2);
  });
});

test('malformed branch entries cannot complete or break request listing', () => {
  const malformed = videoSession({
    narrativeType: 'branched',
    branchRenderPaths: [
      {
        pathId: 'first',
        frameGenerationStatus: 'COMPLETED',
        videoGenerationStatus: 'COMPLETED',
        videoLink: `assets_v2/video/output/${sessionId}/first.mp4`,
      },
      null,
    ],
  });
  assert.doesNotThrow(() => resolveVideoRequestListResult(globalSession(), malformed));
  assert.equal(resolveVideoRequestListResult(globalSession(), malformed), null);
});
