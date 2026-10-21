import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const secret = 'private-asset-real-auth-fixture-secret-at-least-32-bytes';
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SAMSAR_PROCESSOR_ENV_FILE: '/dev/null',
  TOKEN_SECRET: secret, APP_KEY_HASH_SECRET: secret,
  STRIPE_SECRET_KEY: 'sk_test_private_asset_auth', OPENAI_API_KEY: 'sk-test-private-asset-auth',
  MONGO_URL: 'mongodb://127.0.0.1:1/private-asset-auth-fixture',
});
const [
  { installPrivateAssetAccess }, { privateAssetResponseMiddleware },
  { resolveRequestActorFromAuthHeaders }, { createPrivateAssetOwnershipPolicy },
  { default: User }, { default: ExternalUser },
] = await Promise.all([
  import('./PrivateAssetAccess.js'), import('./PrivateAssetResponse.js'),
  import('../models/external/User.js'), import('../models/PrivateAssetOwnership.js'),
  import('../schema/User.js'), import('../schema/ExternalUser.js'),
]);
const ownerId = '507f191e810c19729de860ea';
const strangerId = '507f191e810c19729de860eb';
const query = (value) => ({ select() { return this; }, lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

test('real account authentication and signed JSON media enforce ownership through HTTP', async t => {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previous; });
  t.mock.method(mongoose, 'connect', () => assert.fail('No database connections in security tests.'));
  t.mock.method(ExternalUser, 'findOne', () => query(null));
  t.mock.method(User, 'findOne', ({ _id }) => query([ownerId, strangerId].includes(_id)
    ? { _id, preferredTextModel: 'GPT_4O', preferredVideoPromptModel: 'GPT_4O', preferredTextModelActual: 'GPT_4O', save: async () => {} } : null));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-real-asset-auth-'));
  const assetsPath = path.join(directory, 'assets');
  const assetsV2Path = path.join(directory, 'assets_v2');
  await fs.mkdir(assetsPath);
  await fs.mkdir(path.join(assetsV2Path, 'user_resources', ownerId), { recursive: true });
  await fs.writeFile(path.join(assetsV2Path, 'user_resources', ownerId, 'clip.mp4'), 'private clip');
  const assetPath = `/assets_v2/user_resources/${ownerId}/clip.mp4`;
  const ownership = createPrivateAssetOwnershipPolicy({ ensureConnected: () => assert.fail('User directory must not query sessions.') });
  const app = express();
  app.use(express.json());
  app.use(privateAssetResponseMiddleware({ resolveActor: resolveRequestActorFromAuthHeaders }));
  app.get('/session', (_req, res) => res.json({ video_url: assetPath }));
  app.get('/serialized_session', (_req, res) => res.type('application/json').send(JSON.stringify({
    status: 'COMPLETED', result_url: assetPath,
  })));
  installPrivateAssetAccess({ app, assetsPath, assetsV2Path,
    resolveActor: resolveRequestActorFromAuthHeaders, canAccessAsset: ownership });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = jwt.sign({ _id: ownerId }, secret, { expiresIn: 60 });
  const stranger = jwt.sign({ _id: strangerId }, secret, { expiresIn: 60 });
  const headers = (token) => ({ authorization: `Bearer ${token}` });
  for (const credential of [null, 'malformed', jwt.sign({ _id: ownerId }, 'a-different-test-secret'),
    jwt.sign({ _id: ownerId }, secret, { expiresIn: -1 }),
    jwt.sign({ _id: ownerId, type: 'login' }, secret),
    jwt.sign({ _id: '507f191e810c19729de860ff' }, secret)]) {
    const result = await fetch(`${base}${assetPath}`, { headers: credential ? headers(credential) : {} });
    assert.equal(result.status, 401);
    assert.equal((await result.text()).includes('private clip'), false);
  }
  assert.equal((await fetch(`${base}${assetPath}`, { headers: headers(stranger) })).status, 403);
  const owned = await fetch(`${base}${assetPath}`, { headers: headers(owner) });
  assert.equal(owned.status, 200);
  assert.equal(await owned.text(), 'private clip');
  const cookieOwned = await fetch(`${base}${assetPath}`, { headers: { cookie: `authToken=${owner}` } });
  assert.equal(cookieOwned.status, 200);
  assert.equal(await cookieOwned.text(), 'private clip');
  assert.equal((await fetch(`${base}${assetPath}`, { headers: { cookie: `authToken=${stranger}` } })).status, 403);
  assert.equal((await fetch(`${base}${assetPath}`, { headers: { cookie: 'authToken=invalid.jwt.value' } })).status, 401);
  assert.equal((await fetch(`${base}${assetPath}`, { headers: { cookie: `authToken=${owner}`, ...headers(stranger) } })).status, 403);

  const session = await (await fetch(`${base}/session`, { headers: headers(owner) })).json();
  assert.match(session.video_url, /asset_token=/);
  assert.equal(await (await fetch(`${base}${session.video_url}`)).text(), 'private clip');
  const serialized = await (await fetch(`${base}/serialized_session`, { headers: headers(owner) })).json();
  assert.equal(serialized.status, 'COMPLETED');
  assert.match(serialized.result_url, /asset_token=/);
  assert.equal(await (await fetch(`${base}${serialized.result_url}`)).text(), 'private clip');
  const anonymousSerialized = await (await fetch(`${base}/serialized_session`)).json();
  assert.equal(anonymousSerialized.result_url, assetPath);
  const foreignSession = await (await fetch(`${base}/session`, { headers: headers(stranger) })).json();
  assert.equal((await fetch(`${base}${foreignSession.video_url}`)).status, 403);
});
