import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import VideoSession from './VideoSession.js';
import AIVideoLayerGeneration from './AIVideoLayerGeneration.js';
import { processVideoGenerationFailed } from '../VideoGenerationListener.js';

test('terminal lip sync failure persists its reason and keeps the base AI video', async (t) => {
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
  t.after(() => { delete mongoose.connection.readyState; });
  t.mock.method(console, 'error', () => {});

  const sessionId = new mongoose.Types.ObjectId();
  const layerId = new mongoose.Types.ObjectId();
  const generationId = new mongoose.Types.ObjectId();
  const session = new VideoSession({
    _id: sessionId,
    layers: [{
      _id: layerId,
      layerAiVideoType: 'character',
      hasAiVideoLayer: true,
      aiVideoLayer: '/assets/base.mp4',
      aiVideoRemoteLink: 'https://static.example/base.mp4',
      aiVideoGenerationStatus: 'COMPLETED',
      lipSyncGenerationPending: true,
      lipSyncVideoGenerationStatus: 'PENDING',
    }],
  });
  let savedSession;
  let deletedGenerationId;
  t.mock.method(VideoSession, 'findById', async () => session);
  t.mock.method(session, 'save', async () => {
    savedSession = session.toObject();
    return session;
  });
  t.mock.method(AIVideoLayerGeneration, 'findByIdAndDelete', async (id) => {
    deletedGenerationId = id;
  });

  await processVideoGenerationFailed({
    _id: generationId,
    sessionId: sessionId.toString(),
    layerId: layerId.toString(),
    model: 'HUMMINGBIRDLIPSYNC',
    generationType: 'lip_sync',
    numRetries: 3,
    retryOnFail: true,
    lastProviderFailureMessage: 'Fal rejected the lip sync request',
    createdAt: new Date(),
  });

  assert.equal(savedSession.layers.length, 1);
  assert.equal(savedSession.layers[0].lipSyncVideoGenerationStatus, 'FAILED');
  assert.equal(savedSession.layers[0].lipSyncGenerationPending, false);
  assert.equal(savedSession.layers[0].lipSyncVideoGenerationError, 'Fal rejected the lip sync request');
  assert.equal(savedSession.layers[0].hasAiVideoLayer, true);
  assert.equal(savedSession.layers[0].aiVideoGenerationStatus, 'COMPLETED');
  assert.equal(savedSession.layers[0].aiVideoLayer, '/assets/base.mp4');
  assert.equal(savedSession.layers[0].aiVideoRemoteLink, 'https://static.example/base.mp4');
  assert.equal(savedSession.layers[0].layerAiVideoType, 'character');
  assert.equal(deletedGenerationId.toString(), generationId.toString());
});
