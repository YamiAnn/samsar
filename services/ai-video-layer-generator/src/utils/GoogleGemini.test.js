import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleAuth } from 'google-auth-library';

import { createGoogleGeminiChatCompletion } from './GoogleGemini.js';

test('versioned Argon environment model trims trailing model turns', async (t) => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  const previousModel = process.env.GOOGLE_GEMINI_4_ARGON_MODEL;
  const previousThinkingLevel = process.env.GOOGLE_GEMINI_THINKING_LEVEL;
  process.env.GOOGLE_CLOUD_PROJECT = 'argon-shape-project';
  process.env.GOOGLE_GEMINI_4_ARGON_MODEL = 'gemini-4-argon-20261013';
  process.env.GOOGLE_GEMINI_THINKING_LEVEL = 'MEDIUM';
  t.after(() => {
    if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    if (previousModel === undefined) delete process.env.GOOGLE_GEMINI_4_ARGON_MODEL;
    else process.env.GOOGLE_GEMINI_4_ARGON_MODEL = previousModel;
    if (previousThinkingLevel === undefined) delete process.env.GOOGLE_GEMINI_THINKING_LEVEL;
    else process.env.GOOGLE_GEMINI_THINKING_LEVEL = previousThinkingLevel;
  });

  let capturedUrl;
  let capturedBody;
  t.mock.method(GoogleAuth.prototype, 'getClient', async () => ({
    getAccessToken: async () => ({ token: 'test-token' }),
  }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  });

  await createGoogleGeminiChatCompletion([
    { role: 'user', content: 'First prompt' },
    { role: 'assistant', content: 'Previous answer' },
  ]);

  assert.match(capturedUrl, /models\/gemini-4-argon-20261013:generateContent$/);
  assert.deepEqual(capturedBody.contents.map(({ role }) => role), ['user']);
  assert.deepEqual(capturedBody.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });
});
