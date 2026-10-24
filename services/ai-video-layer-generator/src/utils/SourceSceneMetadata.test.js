import test from 'node:test';
import assert from 'node:assert/strict';

import { getSourceSceneMetadata } from './SourceSceneMetadata.js';
import VideoSession from '../schema/VideoSession.js';
import AIVideoLayerGeneration from '../schema/AIVideoLayerGeneration.js';

test('immutable scene identity takes precedence over stale scalar and mutable timeline positions', () => {
  const sourceSceneRef = {
    version: 1, sourceSessionId: 'original', sceneIndex: 7,
    scene: { visual: 'Original seventh scene.' }, sounds: [], themeJson: {},
  };
  const metadata = getSourceSceneMetadata({
    sourceSceneRef, sourceSceneIndex: 2, connectedLayerIndex: 0,
  });
  assert.equal(metadata.sourceSceneIndex, 7);
  metadata.sourceSceneRef.scene.visual = 'Updated copy';
  assert.equal(sourceSceneRef.scene.visual, 'Original seventh scene.');
});

test('legacy numeric scene zero and image-session references survive metadata propagation', () => {
  assert.deepEqual(getSourceSceneMetadata({ sourceSceneIndex: '0' }), { sourceSceneIndex: 0 });
  const sourceSceneRef = { version: 1, sourceSessionId: 'original', sceneIndex: 0, scene: { visual: 'First' } };
  assert.deepEqual(getSourceSceneMetadata({ imageSession: { sourceSceneRef } }), {
    sourceSceneIndex: 0, sourceSceneRef,
  });
});

test('usual layers without provenance are unchanged and timeline indices never become source indices', () => {
  assert.deepEqual(getSourceSceneMetadata({ connectedLayerIndex: 4 }), {});
  assert.deepEqual(getSourceSceneMetadata({ sourceSceneIndex: -1, sourceSceneRef: [] }), {});
  assert.deepEqual(getSourceSceneMetadata({ sourceSceneIndex: '0garbage' }), {});
  assert.deepEqual(getSourceSceneMetadata({ sourceSceneIndex: null }), {});
});

test('queue and session schemas retain the complete source scene reference without affecting timeline fields', () => {
  const sourceSceneRef = {
    version: 1, sourceSessionId: 'original', sceneIndex: 0,
    scene: { visual: 'Gate', type: 'sound_effect' },
    sounds: [{ sceneIndex: 0, audio: 'Wind' }], themeJson: { setting: 'Coast' },
    branchAssetKey: 'branch-a:scene-0',
  };
  const metadata = getSourceSceneMetadata({ sourceSceneRef });
  const queued = new AIVideoLayerGeneration({ sourceSceneRef, sourceSceneIndex: 0 }).toObject();
  assert.deepEqual(queued.sourceSceneRef, sourceSceneRef);
  assert.equal(queued.sourceSceneIndex, 0);
  const session = new VideoSession({
    layers: [{ ...metadata, imageSession: metadata, duration: 10 }],
    audioLayers: [{ ...metadata, connectedLayerIndex: 4, duration: 10, generationType: 'sound_effect' }],
  }).toObject();
  assert.deepEqual(session.layers[0].sourceSceneRef, sourceSceneRef);
  assert.deepEqual(session.layers[0].imageSession.sourceSceneRef, sourceSceneRef);
  assert.deepEqual(session.audioLayers[0].sourceSceneRef, sourceSceneRef);
  assert.equal(session.audioLayers[0].sourceSceneIndex, 0);
  assert.equal(session.audioLayers[0].connectedLayerIndex, 4);
  assert.equal(session.audioLayers[0].duration, 10);
});
