import assert from 'node:assert/strict';
import test from 'node:test';
import VideoSession from './VideoSession.js';
import { rerollVideoSessionLayersAndQueueGeneration } from '../models/api/VideoSessionRerollAPI.js';

const userId = '507f191e810c19729de860ea';
const sourceId = '507f191e810c19729de860eb';
const cloneId = '507f191e810c19729de860ec';
const layerId = '507f191e810c19729de860ed';

function savedSession(fields = {}) {
  return {
    _id: sourceId, userId, aspectRatio: '9:16', expressGenerationPending: false,
    expressGenerationImageModel: 'SEEDREAM', expressGenerativeVideoModel: 'HAPPYHORSEI2V',
    movieResourceList: { scenes: [{ visual: 'The original commander', type: 'sound_effect', duration: 10 }] },
    layers: [{ _id: layerId, originalImageGenerationPrompt: 'The original commander',
      layerBaseAiImageType: 'sound_effect', duration: 10, frames: ['original/0.png'],
      imageSession: { userId, activeGeneratedImage: 'original/clean.png', generationStatus: 'COMPLETED', activeItemList: [] } }],
    expressGenerationStatus: { status: 'COMPLETED', image_generation: 'COMPLETED' },
    videoLink: 'original/render.mp4', ...fields,
  };
}

function captureSaves(t) {
  const writes = [];
  t.mock.method(VideoSession.collection, 'updateOne', async (filter, update) => {
    writes.push({ filter, update });
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  return writes;
}

for (const apiKeyId of ['507f191e810c19729de860ee', undefined]) {
  test(`F2P: hydrated reroll persists completion billing and resets cloned receipts (${apiKeyId ? 'API key' : 'no API key'})`, async t => {
    const source = savedSession();
    const clone = VideoSession.hydrate({ ...savedSession({
      videoBillingPolicy: 'pipeline', videoBillingAPIKeyUsage: { apiKeyId: 'old-key' },
      videoBillingDebits: { old: { credits: 25 } }, videoCreditsCharged: 25,
    }), _id: cloneId });
    const writes = captureSaves(t);
    await rerollVideoSessionLayersAndQueueGeneration(userId,
      { videoSessionId: sourceId, layerIndexes: [1], apiKeyId }, {
        loadOwnedSession: async (_user, id) => id === sourceId ? source : clone,
        prepareImageRequestBilling: async () => ({}),
        copyVideoSession: async () => ({ sessionId: cloneId }),
        buildMovieResourceListVisualPrompts: async () => ({ promptList: [{ prompt: 'Regenerated commander prompt' }] }),
        deleteStaleQueuedWork: async () => {}, queueImageRerollRequests: async () => {},
        upsertGlobalSessionMapping: async () => {},
      });
    assert.equal(writes.length, 1);
    const persisted = writes[0].update.$set;
    assert.equal(persisted.videoBillingPolicy, 'adapter');
    assert.deepEqual(persisted.videoBillingAPIKeyUsage, apiKeyId ? { apiKeyId } : null);
    // Mongoose minimizes an empty mixed-object reset into $unset on save.
    // Either representation must clear the receipt inherited from the clone.
    assert.ok((persisted.videoBillingDebits && Object.keys(persisted.videoBillingDebits).length === 0) ||
      writes[0].update.$unset?.videoBillingDebits === 1);
    assert.equal(persisted.videoCreditsCharged, 0);
    const serialized = clone.toObject({ minimize: false });
    assert.equal(serialized.videoBillingPolicy, 'adapter');
    assert.deepEqual(serialized.videoBillingDebits, {});
    assert.equal(source.videoLink, 'original/render.mp4');
  });
}

test('P2P: an ordinary hydrated render does not acquire completion-billing fields', async t => {
  const session = VideoSession.hydrate(savedSession());
  const writes = captureSaves(t);
  session.layers[0].prompt = 'Normal render prompt';
  await session.save();
  const serialized = session.toObject({ minimize: false });
  for (const field of ['videoBillingPolicy', 'videoBillingAPIKeyUsage', 'videoBillingDebits', 'videoCreditsCharged', 'videoRemainingCredits']) {
    assert.equal(Object.hasOwn(serialized, field), false, field);
    assert.equal(Object.hasOwn(writes[0].update.$set, field), false, field);
  }
});

test('P2P: ordinary pipeline saves preserve their existing receipt without resetting charges', async t => {
  const original = { videoBillingPolicy: 'pipeline', videoBillingAPIKeyUsage: { apiKeyId: 'historical-key' },
    videoBillingDebits: { old: { credits: 25 } }, videoCreditsCharged: 25, videoRemainingCredits: 75 };
  const session = VideoSession.hydrate(savedSession(original));
  const writes = captureSaves(t);
  session.layers[0].prompt = 'Normal render prompt';
  await session.save();
  const serialized = session.toObject({ minimize: false });
  for (const [field, value] of Object.entries(original)) {
    assert.deepEqual(serialized[field], value, field);
    assert.equal(Object.hasOwn(writes[0].update.$set, field), false, field);
  }
});

test('P2P: hydrated adapter status exposes the persisted charged and remaining credits', () => {
  const session = VideoSession.hydrate(savedSession({ videoBillingPolicy: 'adapter',
    videoCreditsCharged: 12, videoRemainingCredits: 88 }));
  assert.equal(session.videoBillingPolicy, 'adapter');
  assert.equal(session.videoCreditsCharged, 12);
  assert.equal(session.videoRemainingCredits, 88);
});
