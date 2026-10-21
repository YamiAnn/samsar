import test from 'node:test';
import assert from 'node:assert/strict';

import { getNextExpressStepStageToRecord } from './ExpressVideoStepState.js';

test('a rendered final video remains the next unrecorded step after narrator avatar', () => {
  const generationStatus = {
    narrator_avatar_generation: 'COMPLETED',
    video_generation: 'COMPLETED',
  };

  assert.equal(
    getNextExpressStepStageToRecord('narrator_avatar_generation', generationStatus, {}),
    'video_generation',
  );
  assert.equal(
    getNextExpressStepStageToRecord('narrator_avatar_generation', generationStatus, {
      video_generation: { status: 'COMPLETED' },
    }),
    null,
  );
});

test('an unfinished final video remains the next step', () => {
  assert.equal(
    getNextExpressStepStageToRecord('narrator_avatar_generation', {
      video_generation: 'PENDING',
    }),
    'video_generation',
  );
});
