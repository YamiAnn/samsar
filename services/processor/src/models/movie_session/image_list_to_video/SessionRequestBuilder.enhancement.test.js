import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImageListLayerSourceSceneFields,
  resolveImageListItemRequiresEnhancement,
} from './SessionRequestBuilder.js';
import VideoSession from '../../../schema/VideoSession.js';

test('supplied image-list inputs never opt into AI image editing implicitly', () => {
  assert.equal(resolveImageListItemRequiresEnhancement(), false);
  assert.equal(resolveImageListItemRequiresEnhancement({}), false);
  assert.equal(resolveImageListItemRequiresEnhancement({
    prepared_width: 512,
    required_width: 1080,
  }), false);
  assert.equal(resolveImageListItemRequiresEnhancement({
    requires_enhancement: true,
  }), true);
  assert.equal(resolveImageListItemRequiresEnhancement({
    requiresEnhancement: false,
  }), false);
});

test('image-list source identity survives persistence alongside an outro without changing render inputs', () => {
  const movieResourceList = {
    scenes: [{ visual: 'Keep the supplied photograph.', duration: 5, type: 'base' }],
    sounds: [],
  };
  const fields = buildImageListLayerSourceSceneFields({
    sourceSessionId: 'image-list-origin', sceneIndex: 0, movieResourceList,
    themeJson: { style: ['photographic'] },
  });
  const activeItemList = [{ id: 'item_0', type: 'image', image: 'supplied-photo.png', is_base_image: true }];
  const session = new VideoSession({
    userId: 'owner',
    layers: [
      {
        ...fields, prompt: 'Keep the supplied photograph.', duration: 5,
        layerBaseAiImageType: 'scene',
        imageSession: { ...fields, userId: 'owner', generationStatus: 'COMPLETED', activeItemList },
      },
      {
        sourceSceneIndex: null, sourceSceneRef: null, layerBaseAiImageType: 'none',
        skipAiVideoGeneration: true, imageSession: { sourceSceneIndex: null, sourceSceneRef: null },
      },
    ],
  }).toObject();

  assert.equal(session.layers.length, 2);
  assert.equal(session.layers[0].sourceSceneIndex, 0);
  assert.equal(session.layers[0].sourceSceneRef.scene.visual, 'Keep the supplied photograph.');
  assert.equal(session.layers[0].imageSession.sourceSceneRef.sourceSessionId, 'image-list-origin');
  assert.equal(session.layers[0].imageSession.generationStatus, 'COMPLETED');
  assert.deepEqual(session.layers[0].imageSession.activeItemList.map(({ _id, ...item }) => item), activeItemList);
  assert.equal(session.layers[1].sourceSceneRef, null);
  assert.equal(session.layers[1].skipAiVideoGeneration, true);
});
