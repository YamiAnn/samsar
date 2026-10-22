import test from 'node:test';
import assert from 'node:assert/strict';

import { __testOnly__ } from './ExpressListener.js';

test('audio failure keeps the actionable failed-layer error instead of replacing it with a generic message', () => {
  const message = 'Fal rejected the audio API key (HTTP 401). Update the Fal credential.';
  assert.equal(__testOnly__.resolveAudioGenerationFailureMessage({
    audioLayers: [
      { generationStatus: 'COMPLETED', generationError: 'stale error' },
      { generationStatus: 'FAILED', generationType: 'speech' },
      { generationStatus: 'FAILED', generationType: 'music', generationError: message },
    ],
    expressGenerationError: 'Audio generation failed',
  }), message);
  assert.equal(__testOnly__.resolveAudioGenerationFailureMessage({
    expressGenerationError: 'Audio provider timed out',
  }), 'Audio provider timed out');
  assert.equal(__testOnly__.resolveAudioGenerationFailureMessage({}), 'Audio generation failed');
});

test('delete/reflow visual predicate treats activeGeneratedImage as a valid still visual', () => {
  assert.equal(
    __testOnly__.hasLayerStillVisuals({
      imageSession: {
        activeItemList: [],
        activeGeneratedImage: 'assets_v2/generations/reroll-session/scene.png',
      },
      aiVideoGenerationStatus: 'FAILED',
    }),
    true,
  );
});

test('delete/reflow visual predicate ignores empty image items', () => {
  assert.equal(
    __testOnly__.hasLayerStillVisuals({
      imageSession: {
        activeItemList: [
          { type: 'image', src: '', is_base_image: true },
        ],
      },
    }),
    false,
  );
});

test('exhausted AI-video layers are removed during reflow even when a still image remains', () => {
  const exhaustedLayer = {
    layerAiVideoType: 'narration',
    aiVideoGenerationStatus: 'FAILED',
    processVideoGenerationFailed: true,
    hasAiVideoLayer: false,
    imageSession: {
      activeGeneratedImage: 'assets_v2/generations/session/scene.png',
    },
  };

  assert.equal(__testOnly__.hasLayerStillVisuals(exhaustedLayer), true);
  assert.equal(__testOnly__.shouldRemoveLayerDuringDeleteReflow(exhaustedLayer), true);
});

test('completed AI-video layers are preserved during delete/reflow', () => {
  assert.equal(__testOnly__.shouldRemoveLayerDuringDeleteReflow({
    layerAiVideoType: 'narration',
    aiVideoGenerationStatus: 'COMPLETED',
    hasAiVideoLayer: true,
    aiVideoRemoteLink: 'https://static.samsar.one/video.mp4',
  }), false);
});

test('managed individual AI-video failure continues to delete/reflow instead of failing the session', () => {
  const managedFailure = {
    layerAiVideoType: 'narration',
    aiVideoGenerationStatus: 'FAILED',
    processVideoGenerationFailed: true,
    hasAiVideoLayer: false,
  };
  const unmanagedFailure = {
    layerAiVideoType: 'narration',
    aiVideoGenerationStatus: 'FAILED',
    processVideoGenerationFailed: false,
    hasAiVideoLayer: false,
  };

  assert.equal(__testOnly__.isFailedAiVideoLayerQueuedForDeleteReflow(managedFailure), true);
  assert.equal(__testOnly__.getFailedRequiredAiVideoLayer([managedFailure]), null);
  assert.equal(__testOnly__.getFailedRequiredAiVideoLayer([unmanagedFailure]), unmanagedFailure);
});

test('AI video output predicate accepts remote-only reusable AI videos', () => {
  assert.equal(
    __testOnly__.hasGeneratedAiVideoOutput({
      hasAiVideoLayer: true,
      aiVideoRemoteLink: 'https://static.samsar.one/assets_v2/user_resources/user-1/ai_videos/session/layer/video.mp4',
    }),
    true,
  );
});

test('transcript result helper keeps in-memory generation status synchronized', () => {
  const status = {
    transcript_generation: 'PENDING',
    frame_generation: 'INIT',
  };

  assert.equal(
    __testOnly__.applyTranscriptGenerationResultToStatus(status, true),
    'COMPLETED',
  );
  assert.equal(status.transcript_generation, 'COMPLETED');

  assert.equal(
    __testOnly__.applyTranscriptGenerationResultToStatus(status, false),
    'FAILED',
  );
  assert.equal(status.transcript_generation, 'FAILED');
});

test('disabled and skipped narrator stages advance the step without billing', async () => {
  const calls = [];
  const completeStage = async (...args) => {
    calls.push(args);
    return { ok: true, paused: false };
  };

  await __testOnly__.completeNarratorAvatarStage('session-id', { completeStage });
  await __testOnly__.completeNarratorAvatarStage('session-id', {
    required: true,
    skipped: true,
    completeStage,
  });
  await __testOnly__.completeNarratorAvatarStage('session-id', {
    required: true,
    completeStage,
  });

  assert.deepEqual(calls, [
    ['session-id', 'narrator_avatar_generation', { skipBilling: true }],
    ['session-id', 'narrator_avatar_generation', { skipBilling: true }],
    ['session-id', 'narrator_avatar_generation', { skipBilling: false }],
  ]);
});

test('pipeline finalizer waits when its step charge is deferred or paused', () => {
  assert.equal(__testOnly__.canFinalizeExpressPipelineAfterStage({ ok: true, deferred: true }), false);
  assert.equal(__testOnly__.canFinalizeExpressPipelineAfterStage({ ok: true, paused: true }), false);
  assert.equal(__testOnly__.canFinalizeExpressPipelineAfterStage({ ok: false }), false);
  assert.equal(__testOnly__.canFinalizeExpressPipelineAfterStage({ ok: true, paused: false }), true);
});

test('skipped lip sync advances the step without charging its stage', async () => {
  const calls = [];
  const completeStage = async (...args) => {
    calls.push(args);
    return { ok: true, paused: false };
  };

  await __testOnly__.completeLipSyncStage('session-id', { skipped: true, completeStage });
  await __testOnly__.completeLipSyncStage('session-id', { skipped: false, completeStage });
  await __testOnly__.completeLipSyncStage('session-id', { requiredCount: 0, completeStage });

  assert.deepEqual(calls, [
    ['session-id', 'lip_sync_generation', { skipBilling: true }],
    ['session-id', 'lip_sync_generation', { skipBilling: false }],
    ['session-id', 'lip_sync_generation', { skipBilling: true }],
  ]);
  assert.equal(__testOnly__.isLipSyncStageReadyToComplete('FAILED', 'COMPLETE'), true);
  assert.equal(__testOnly__.isLipSyncStageReadyToComplete('FAILED', 'WAIT'), false);
});

test('lip-sync skip stores one reason without changing character or audio layers', async () => {
  let skipped = false;
  let recordedUpdate;
  const updateSession = async (query, update) => {
    assert.deepEqual(query, { _id: 'session-id', lipSyncGenerationSkipped: { $ne: true } });
    if (skipped) return { modifiedCount: 0 };
    skipped = true;
    recordedUpdate = update;
    return { modifiedCount: 1 };
  };
  const failedAssessment = {
    layerId: 'character-1',
    status: 'FAILED',
    audioLayer: { _id: 'speech-1' },
    layer: { _id: 'character-1', lipSyncVideoGenerationError: 'Provider rejected audio.' },
  };

  await __testOnly__.skipLipSyncGenerationStage(
    'session-id', { lip_sync_generation: 'PENDING', sound_effect_generation: 'INIT' },
    failedAssessment, { updateSession },
  );
  await __testOnly__.skipLipSyncGenerationStage(
    'session-id', { lip_sync_generation: 'PENDING', sound_effect_generation: 'INIT' },
    failedAssessment, { updateSession },
  );

  assert.equal(recordedUpdate.$set.expressGenerationStatus.lip_sync_generation, 'COMPLETED');
  assert.equal(recordedUpdate.$set.expressGenerationStatus.sound_effect_generation, 'INIT');
  assert.equal(recordedUpdate.$set.lipSyncGenerationSkipped, true);
  assert.equal(recordedUpdate.$set.lipSyncGenerationSkipReason, 'Provider rejected audio.');
  assert.equal(recordedUpdate.$set.lipSyncGenerationPending, false);
  assert.equal(recordedUpdate.$set.layers, undefined);
  assert.equal(recordedUpdate.$set.audioLayers, undefined);
});
