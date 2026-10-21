import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.SAMSAR_PROCESSOR_ENV_FILE = '/dev/null';
process.env.MONGO_URL = 'mongodb://127.0.0.1:1/private-asset-ownership-test';
const { createPrivateAssetOwnershipPolicy } = await import('./PrivateAssetOwnership.js');

const ids = {
  owner: '507f191e810c19729de860ea',
  other: '507f191e810c19729de860eb',
  session: '507f191e810c19729de860ec',
  foreign: '507f191e810c19729de860ed',
  external: '507f191e810c19729de860ee',
  sibling: '507f191e810c19729de860ef',
  sub: '507f191e810c19729de860fa',
  generation: '507f191e810c19729de860fb',
};
const owner = { authType: 'auth_token', internalUserId: ids.owner };
const stranger = { authType: 'auth_token', internalUserId: ids.other };
const external = { authType: 'external_auth', internalUserId: ids.owner, externalUserId: ids.external };
const subAccount = { authType: 'customer_sub_account_api_key', internalUserId: ids.owner, customerSubAccountId: ids.sub };
const flatImage = 'assets/generations/4e939419-d566-46a2-8f82-e165b4068c70.png';
const models = ['VideoSession', 'Session', 'GlobalSession', 'ExternalUserRequest',
  'ImageGeneration', 'GeneratedImage', 'GeneratedAIVideo', 'GeneratedMusic'];

function valuesAt(value, parts) {
  if (Array.isArray(value)) return value.flatMap((entry) => valuesAt(entry, parts));
  if (!parts.length) return [value];
  return value && typeof value === 'object' ? valuesAt(value[parts[0]], parts.slice(1)) : [];
}

function matches(record, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((entry) => matches(record, entry));
    return valuesAt(record, field.split('.')).some((value) =>
      expected instanceof RegExp ? typeof value === 'string' && expected.test(value) : String(value) === String(expected));
  });
}

function fixture(initial = {}) {
  const records = Object.fromEntries(models.map((name) => [name, [...(initial[name] || [])]]));
  const queries = [];
  let connected = 0;
  const modelStubs = Object.fromEntries(models.map((name) => [name, {
    findOne(filter) { queries.push({ name, filter }); return Promise.resolve(records[name].find((record) => matches(record, filter)) || null); },
    find(filter) {
      queries.push({ name, filter });
      let limit = Infinity;
      return { limit(value) { limit = value; return this; },
        lean: async () => records[name].filter((record) => matches(record, filter)).slice(0, limit) };
    },
  }]));
  const canAccess = createPrivateAssetOwnershipPolicy({ models: modelStubs, ensureConnected: async () => { connected += 1; } });
  return { canAccess, records, queries, connected: () => connected };
}

function sessionFixture(fields = {}) {
  return fixture({ VideoSession: [{ _id: ids.session, userId: ids.owner, ...fields }] });
}

test('internal credentials read their own user resource directories under both roots', async () => {
  const { canAccess } = fixture();
  for (const authType of ['auth_token', 'api_key', 'app_key']) {
    for (const root of ['assets', 'assets_v2']) {
      assert.equal(await canAccess({ ...owner, authType }, `${root}/user_resources/${ids.owner}/audio/upload.mp3`), true);
      assert.equal(await canAccess({ ...owner, authType }, `${root}/user_resources/${ids.other}/audio/upload.mp3`), false);
    }
  }
});

test('unknown, anonymous, incomplete and conflicting actor scopes fail closed', async () => {
  const { canAccess, connected } = fixture();
  for (const actor of [null, {}, { internalUserId: ids.owner }, { ...owner, authType: 'guest' },
    { ...external, externalUserId: '' }, { ...subAccount, customerSubAccountId: '' },
    { ...external, externalUser: { _id: ids.sibling } },
    { ...subAccount, customerSubAccount: { _id: ids.sibling } },
    { ...owner, externalUserId: '../invalid' }, { ...owner, customerSubAccountId: '' }]) {
    assert.equal(await canAccess(actor, `assets_v2/user_resources/${ids.owner}/video.mp4`), false);
  }
  assert.equal(connected(), 0);
});

test('only canonical assets and assets_v2 keys reach persistence', async () => {
  const { canAccess, connected } = fixture();
  for (const path of ['/assets_v2/private.png', 'generations/private.png',
    'assets_v2/../private.png', 'assets_v2/a/./private.png', 'assets_v2//private.png',
    'assets_v2/a%2Fb/private.png', 'assets_v2/a\\b/private.png', 'assets_v2/a/private.png?shareToken=one',
    'assets_v2/a/private.png#one', 'assets_v2/a/\u0000.png', 'assets_v2/a/']) {
    assert.equal(await canAccess(owner, path), false, path);
  }
  assert.equal(connected(), 0);
});

test('known session folders require persisted ownership rather than a matching-looking ID', async () => {
  const { canAccess } = sessionFixture();
  for (const path of [`generations/${ids.session}/image.png`, `video/output/${ids.session}/video.mp4`,
    `video/frames/${ids.session}/layer/frame.png`, `video/audio/${ids.session}/speech.mp3`,
    `ai_video/edits/${ids.session}/layer/video.mp4`, `temp/${ids.session}/input.png`,
    `global_videos/frames/${ids.session}/layer/frame.png`]) {
    assert.equal(await canAccess(owner, `assets_v2/${path}`), true, path);
    assert.equal(await canAccess(stranger, `assets_v2/${path}`), false, path);
  }
  assert.equal(await canAccess(owner, `assets_v2/video/output/${ids.foreign}/video.mp4`), false);
});

test('legacy root alias canonicalized as assets/ keeps the same owner policy', async () => {
  const { canAccess } = sessionFixture();
  assert.equal(await canAccess(owner, `assets/video/output/${ids.session}/final.mp4`), true);
  assert.equal(await canAccess(stranger, `assets/video/output/${ids.session}/final.mp4`), false);
});

test('legacy renderer, narrator-avatar and session image-intermediate layouts preserve ownership', async () => {
  const { canAccess } = sessionFixture();
  for (const path of [`video/${ids.session}/final.mp4`, `video/footer_qr/${ids.session}/qr.png`,
    `video/narrator_avatar/audio/${ids.session}/speech.mp3`, `video/narrator_avatar/video/${ids.session}/avatar.mp4`,
    `video/narrator_avatar/frames/${ids.session}/frame.png`, `video/narrator_avatar/joined_frames/${ids.session}/frame.png`,
    `video/audio_visualizers/${ids.session}.json`, `intermediates/${ids.session}/frame.png`,
    `twitter/${ids.session}/frame.png`]) {
    for (const root of ['assets', 'assets_v2']) {
      assert.equal(await canAccess(owner, `${root}/${path}`), true, path);
      assert.equal(await canAccess(stranger, `${root}/${path}`), false, path);
    }
  }
});

test('image Session and GlobalSession UUID mappings prove owned paths', async () => {
  const { canAccess } = fixture({
    Session: [{ _id: ids.session, userId: ids.owner }],
    GlobalSession: [{ sessionId: '044c158d-8d50-4eef-bfd3-032e7c6e7790', userId: ids.owner }],
  });
  assert.equal(await canAccess(owner, `assets_v2/generations/${ids.session}/image.png`), true);
  assert.equal(await canAccess(owner, 'assets_v2/generations/044c158d-8d50-4eef-bfd3-032e7c6e7790/image.png'), true);
  assert.equal(await canAccess(stranger, 'assets_v2/generations/044c158d-8d50-4eef-bfd3-032e7c6e7790/image.png'), false);
});

test('explicit shared-session collaborators read session assets while sharing remains enabled', async () => {
  const { canAccess, records } = sessionFixture({ editableShareEnabled: true, editableShareImportedUserIds: [ids.other] });
  assert.equal(await canAccess(stranger, `assets_v2/video/output/${ids.session}/final.mp4`), true);
  records.VideoSession[0].editableShareEnabled = false;
  assert.equal(await canAccess(stranger, `assets_v2/video/output/${ids.session}/final.mp4`), false);
});

test('readonly bearer shares and public flags never grant raw private asset access', async () => {
  const { canAccess } = sessionFixture({ shareEnabled: true, shareToken: 'readonly',
    isPublic: true, editableShareEnabled: true, editableShareCollaborators: [{ userId: ids.other }] });
  assert.equal(await canAccess({ ...stranger, shareToken: 'readonly' }, `assets_v2/video/output/${ids.session}/final.mp4`), false);
});

const readOnlyActor = () => ({ ...stranger, readOnlyShareSessionId: ids.session,
  readOnlyShareTokenHash: createHash('sha256').update('current-readonly-share').digest('hex') });

test('authenticated readonly share grants read only the matching current shared session', async () => {
  const { canAccess, records } = sessionFixture({ shareEnabled: true, shareToken: 'current-readonly-share' });
  records.VideoSession.push({ _id: ids.foreign, userId: ids.owner, shareEnabled: true, shareToken: 'other-share' });
  const path = `assets_v2/video/output/${ids.session}/final.mp4`;
  assert.equal(await canAccess(readOnlyActor(), path), true);
  assert.equal(await canAccess(stranger, path), false);
  assert.equal(await canAccess(readOnlyActor(), `assets_v2/video/output/${ids.foreign}/final.mp4`), false);
  records.VideoSession[0].shareToken = 'rotated-readonly-share';
  assert.equal(await canAccess(readOnlyActor(), path), false);
  records.VideoSession[0].shareToken = 'current-readonly-share';
  records.VideoSession[0].shareEnabled = false;
  assert.equal(await canAccess(readOnlyActor(), path), false);
});

test('malformed or unpaired readonly grants fail closed', async () => {
  const { canAccess } = sessionFixture({ shareEnabled: true, shareToken: 'current-readonly-share' });
  for (const grant of [{ readOnlyShareSessionId: ids.session }, { readOnlyShareTokenHash: 'a'.repeat(64) },
    { readOnlyShareSessionId: 'invalid', readOnlyShareTokenHash: 'a'.repeat(64) },
    { readOnlyShareSessionId: ids.session, readOnlyShareTokenHash: 'invalid' }]) {
    assert.equal(await canAccess({ ...stranger, ...grant }, `assets_v2/video/output/${ids.session}/final.mp4`), false);
  }
});

test('readonly flat output grants require the true owner and an exact reference in the shared session', async () => {
  const { canAccess, records } = sessionFixture({ shareEnabled: true, shareToken: 'current-readonly-share',
    layers: [{ imageSession: { activeGeneratedImage: flatImage } }] });
  records.GeneratedImage.push({ userId: ids.owner, url: flatImage });
  assert.equal(await canAccess(readOnlyActor(), flatImage), true);
  assert.equal(await canAccess(readOnlyActor(), 'assets/generations/unshared.png'), false);
  records.VideoSession[0].layers[0].imageSession.activeGeneratedImage = 'assets/generations/different.png';
  assert.equal(await canAccess(readOnlyActor(), flatImage), false);
  records.VideoSession[0].layers[0].imageSession.activeGeneratedImage = flatImage;
  records.GeneratedImage[0].userId = ids.foreign;
  assert.equal(await canAccess(readOnlyActor(), flatImage), false);
});

test('a readonly grant can read an exact shared resource of the true session owner without a session subdirectory', async () => {
  const path = `assets_v2/user_resources/${ids.owner}/audio/upload.mp3`;
  const { canAccess, records } = sessionFixture({ shareEnabled: true, shareToken: 'current-readonly-share',
    audioLayers: [{ selectedLocalAudioLink: path }] });
  assert.equal(await canAccess(readOnlyActor(), path), true);
  assert.equal(await canAccess(readOnlyActor(), path.replace('upload.mp3', 'unshared.mp3')), false);
  records.VideoSession[0].userId = ids.other;
  assert.equal(await canAccess(readOnlyActor(), path), false);
});

test('readonly grants never broaden external or customer-subaccount parent scope', async () => {
  const { canAccess } = sessionFixture({ shareEnabled: true, shareToken: 'current-readonly-share' });
  const grant = readOnlyActor();
  for (const actor of [external, subAccount]) {
    assert.equal(await canAccess({ ...grant, ...actor }, `assets_v2/video/output/${ids.session}/final.mp4`), false);
  }
});

test('foreign user resource proof cannot be overridden by poisoned output or session references', async () => {
  const path = `assets_v2/user_resources/${ids.other}/ai_videos/${ids.session}/layer/secret.mp4`;
  const { canAccess } = fixture({ VideoSession: [{ _id: ids.session, userId: ids.owner, videoLink: path }],
    GeneratedAIVideo: [{ userId: ids.owner, sessionId: ids.session, url: path }] });
  assert.equal(await canAccess(owner, path), false);
});

test('a collaborator can read a shared-session user-resource video only under its actual owner', async () => {
  const { canAccess } = sessionFixture({ editableShareEnabled: true, editableShareImportedUserIds: [ids.other] });
  assert.equal(await canAccess(stranger, `assets_v2/user_resources/${ids.owner}/ai_videos/${ids.session}/layer/scene.mp4`), true);
});

test('delegated credentials cannot read all of their parent resource tree', async () => {
  const { canAccess } = sessionFixture();
  for (const actor of [external, subAccount, { ...owner, externalUser: { _id: ids.external } }]) {
    assert.equal(await canAccess(actor, `assets_v2/user_resources/${ids.owner}/audio/secret.mp3`), false);
    assert.equal(await canAccess(actor, `assets_v2/video/output/${ids.session}/final.mp4`), false);
  }
});

test('external and customer credentials require authoritative exact request scope', async () => {
  const { canAccess, records, queries } = sessionFixture();
  records.ExternalUserRequest.push({ internalUserId: ids.owner, externalUserId: ids.external,
    customerSubAccountId: ids.sub, upstreamSessionId: ids.session });
  for (const actor of [external, subAccount, { ...external, customerSubAccountId: ids.sub },
    { authType: 'external_auth', internalUserId: ids.owner, externalUser: { _id: ids.external } },
    { authType: 'customer_sub_account_api_key', internalUserId: ids.owner, customerSubAccount: { _id: ids.sub } }]) {
    assert.equal(await canAccess(actor, `assets_v2/video/output/${ids.session}/final.mp4`), true);
  }
  assert.equal(await canAccess({ ...external, externalUserId: ids.sibling }, `assets_v2/video/output/${ids.session}/final.mp4`), false);
  assert.equal(await canAccess({ ...external, customerSubAccountId: ids.sibling }, `assets_v2/video/output/${ids.session}/final.mp4`), false);
  assert.equal(queries.some(({ name, filter }) => name === 'ExternalUserRequest' && filter.externalUserId === ids.external), true);
});

test('delegated actors cannot inherit their parent sharing permissions', async () => {
  const { canAccess } = fixture({ VideoSession: [{ _id: ids.session, userId: ids.other,
    editableShareEnabled: true, editableShareImportedUserIds: [ids.owner] }] });
  assert.equal(await canAccess(external, `assets_v2/video/output/${ids.session}/final.mp4`), false);
});

test('GlobalSession client metadata cannot assert delegated ownership', async () => {
  const { canAccess } = fixture({ GlobalSession: [{ sessionId: 'provider-session', userId: ids.owner,
    metadata: { externalUserId: ids.external, customerSubAccountId: ids.sub } }] });
  assert.equal(await canAccess(external, 'assets_v2/generations/provider-session/image.png'), false);
  assert.equal(await canAccess(subAccount, 'assets_v2/generations/provider-session/image.png'), false);
});

test('legacy flat UUID image outputs use worker records and preserve root separation', async () => {
  const { canAccess } = fixture({ GeneratedImage: [{ userId: ids.owner,
    url: `https://static.samsar.one/${flatImage.slice('assets/'.length)}?Expires=1&Signature=old` }] });
  assert.equal(await canAccess(owner, flatImage), true);
  assert.equal(await canAccess(stranger, flatImage), false);
  assert.equal(await canAccess(owner, flatImage.replace('assets/', 'assets_v2/')), false);
});

test('a basename output in GeneratedImage identifies its exact legacy generations path', async () => {
  const { canAccess } = fixture({ GeneratedImage: [{ userId: ids.owner, url: flatImage.split('/').at(-1) }] });
  assert.equal(await canAccess(owner, flatImage), true);
  assert.equal(await canAccess(owner, `assets/temp/${flatImage.split('/').at(-1)}`), false);
});

test('arbitrary mutable session payload references never independently prove ownership', async () => {
  const { canAccess } = sessionFixture({ videoLink: flatImage,
    layers: [{ imageSession: { activeGeneratedImage: flatImage } }] });
  assert.equal(await canAccess(owner, flatImage), false);
});

test('flat shared assets require both true generated-output owner and an allowed shared-session reference', async () => {
  const { canAccess, records } = fixture({
    GeneratedImage: [{ userId: ids.owner, url: flatImage }],
    VideoSession: [{ _id: ids.session, userId: ids.owner, editableShareEnabled: true,
      editableShareImportedUserIds: [ids.other], layers: [{ imageSession: { activeGeneratedImage: flatImage } }] }],
  });
  assert.equal(await canAccess(stranger, flatImage), true);
  records.VideoSession[0].userId = ids.other;
  assert.equal(await canAccess(stranger, flatImage), false, 'a foreign asset cannot become owned by changing a session reference');
});

test('a shared-session bare image filename is usable only after true output ownership is established', async () => {
  const { canAccess } = fixture({
    GeneratedImage: [{ userId: ids.owner, url: flatImage }],
    VideoSession: [{ _id: ids.session, userId: ids.owner, editableShareEnabled: true,
      editableShareImportedUserIds: [ids.other], layers: [{ imageSession: { activeGeneratedImage: flatImage.split('/').at(-1) } }] }],
  });
  assert.equal(await canAccess(stranger, flatImage), true);
});

test('flat generated files for delegated users require the exact authoritative upstream request', async () => {
  const { canAccess, records } = sessionFixture();
  records.GeneratedImage.push({ userId: ids.owner, sessionId: ids.session, url: flatImage });
  records.ExternalUserRequest.push({ internalUserId: ids.owner, externalUserId: ids.external, upstreamSessionId: ids.session });
  assert.equal(await canAccess(external, flatImage), true);
  records.ExternalUserRequest[0].externalUserId = ids.sibling;
  assert.equal(await canAccess(external, flatImage), false);
});

test('foreign authoritative session ownership cannot be overridden by a forged GlobalSession mapping', async () => {
  const { canAccess } = fixture({ VideoSession: [{ _id: ids.session, userId: ids.other }],
    GlobalSession: [{ sessionId: ids.session, userId: ids.owner }],
    GeneratedImage: [{ userId: ids.owner, url: `assets_v2/generations/${ids.session}/image.png` }] });
  assert.equal(await canAccess(owner, `assets_v2/generations/${ids.session}/image.png`), false);
});

test('completed ImageGeneration output requires an authoritative session or global mapping', async () => {
  const { canAccess, records } = fixture({
    ImageGeneration: [{ _id: ids.generation, userId: ids.owner, generationStatus: 'COMPLETED',
      apiGenerationStatus: 'COMPLETED', resultUrl: flatImage }],
    GlobalSession: [{ sessionId: ids.generation, userId: ids.owner }],
  });
  assert.equal(await canAccess(owner, flatImage), true);
  records.GlobalSession.length = 0;
  assert.equal(await canAccess(owner, flatImage), false);
});

test('input URLs, queued result fields and metadata do not become output ownership', async () => {
  const { canAccess } = fixture({
    ImageGeneration: [{ _id: ids.generation, userId: ids.owner, image: flatImage,
      image_urls: [flatImage], generationStatus: 'PENDING', apiGenerationStatus: 'COMPLETED', resultUrl: flatImage }],
    GlobalSession: [{ sessionId: ids.generation, userId: ids.owner, inputUrl: flatImage,
      inputUrls: [flatImage], status: 'PENDING', metadata: { resultUrl: flatImage } }],
  });
  assert.equal(await canAccess(owner, flatImage), false);
});

test('completed GlobalSession outputs preserve delegated request scope through provider IDs', async () => {
  const { canAccess, records } = fixture({ GlobalSession: [{ sessionId: 'provider-session', requestId: ids.session,
    userId: ids.owner, status: 'COMPLETED', resultUrls: [flatImage] }],
    ExternalUserRequest: [{ internalUserId: ids.owner, externalUserId: ids.external, upstreamSessionId: ids.session }],
  });
  assert.equal(await canAccess(external, flatImage), true);
  records.ExternalUserRequest[0].externalUserId = ids.sibling;
  assert.equal(await canAccess(external, flatImage), false);
});

test('GeneratedAIVideo and GeneratedMusic primary outputs retain exact ownership', async () => {
  const { canAccess } = fixture({
    GeneratedAIVideo: [{ userId: ids.owner, url: 'assets/legacy-output.mp4', thumbnailPath: flatImage }],
    GeneratedMusic: [{ userId: ids.owner, url: 'assets/legacy-speech.mp3' }],
  });
  assert.equal(await canAccess(owner, 'assets/legacy-output.mp4'), true);
  assert.equal(await canAccess(owner, 'assets/legacy-speech.mp3'), true);
  assert.equal(await canAccess(stranger, 'assets/legacy-output.mp4'), false);
  assert.equal(await canAccess(owner, flatImage), false, 'a selected input thumbnail cannot confer output ownership');
});

test('database errors deny access instead of allowing static middleware to disclose bytes', async () => {
  const canAccess = createPrivateAssetOwnershipPolicy({ ensureConnected: async () => { throw new Error('unavailable'); } });
  assert.equal(await canAccess(owner, `assets_v2/video/output/${ids.session}/final.mp4`), false);
});
