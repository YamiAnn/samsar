import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getStoredSessionInferenceModel,
  resolvePublicationMetadataInferenceModel,
} from './InferenceModel.js';

test('prefers the inference model persisted for express generation', () => {
  const sessionData = {
    expressGenerationInferenceModel: 'QWEN3.8',
    inferenceModel: 'gemini-4-argon',
  };

  assert.equal(getStoredSessionInferenceModel(sessionData), 'QWEN3.8');
  assert.equal(
    resolvePublicationMetadataInferenceModel(sessionData, 'gpt-6.1-sol'),
    'QWEN3.8',
  );
});

test('uses the standard or legacy persisted session inference model', () => {
  assert.equal(
    resolvePublicationMetadataInferenceModel({ inferenceModel: 'gemini-4-argon' }),
    'gemini-4-argon',
  );
  assert.equal(
    resolvePublicationMetadataInferenceModel({
      metadata: { inference_model: 'qwen3.8-max' },
    }),
    'QWEN3.8',
  );
});

test('falls back to the user inference model for older sessions', () => {
  assert.equal(
    resolvePublicationMetadataInferenceModel({}, 'gemini-4-argon'),
    'gemini-4-argon',
  );
  assert.equal(resolvePublicationMetadataInferenceModel({}), 'gpt-6.1-sol');
});
