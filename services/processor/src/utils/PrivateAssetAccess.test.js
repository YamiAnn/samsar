import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import jwt from 'jsonwebtoken';
import {
  installPrivateAssetAccess, resolvePrivateAssetPublicBaseUrl,
} from './PrivateAssetAccess.js';
import {
  mintPrivateAssetToken, normalizePrivateAssetPath, verifyPrivateAssetToken,
} from './PrivateAssetTokens.js';

const TEST_SECRET = 'private-asset-route-fixture-secret-32-bytes-long';
process.env.TOKEN_SECRET = TEST_SECRET;
const owner = { authType: 'auth_token', internalUserId: 'owner' };
const shared = { authType: 'auth_token', internalUserId: 'collaborator' };
const stranger = { authType: 'auth_token', internalUserId: 'stranger' };
const subaccount = { authType: 'customer_sub_account_api_key', internalUserId: 'owner',
  customerSubAccount: { _id: 'sub-a' } };
const external = { authType: 'external_auth', internalUserId: 'owner', externalUser: { _id: 'external-a' } };

function request(server, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: pathname, method, agent: false,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: () => text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fixture(t, { canAccessAsset } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-private-assets-'));
  const assetsPath = path.join(root, 'assets');
  const assetsV2Path = path.join(root, 'assets_v2');
  await fs.mkdir(assetsPath);
  for (const sub of ['private', 'shared', 'sub-a', 'external-a']) {
    await fs.mkdir(path.join(assetsV2Path, sub), { recursive: true });
    await fs.writeFile(path.join(assetsV2Path, sub, 'media.wav'), '0123456789');
  }
  await fs.writeFile(path.join(assetsPath, 'legacy.mp4'), 'legacy-video');
  await fs.writeFile(path.join(root, 'outside.txt'), 'must never be returned');
  await fs.symlink(path.join(root, 'outside.txt'), path.join(assetsPath, 'outside-link.txt'));
  await fs.symlink(path.join(root, 'outside.txt'), path.join(assetsV2Path, 'private', 'outside-link.txt'));
  await fs.symlink(path.join(assetsV2Path, 'private', 'media.wav'), path.join(assetsV2Path, 'private', 'inside-link.wav'));
  const actors = { owner, shared, stranger, subaccount, external };
  const seen = [];
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.vary('Origin'); next(); });
  installPrivateAssetAccess({ app, assetsPath, assetsV2Path,
    resolveActor: async headers => actors[headers.authorization?.replace(/^Bearer /, '')] || null,
    canAccessAsset: async (actor, canonicalPath) => {
      seen.push({ actor, canonicalPath });
      if (canAccessAsset) return canAccessAsset(actor, canonicalPath);
      if (actor.authType === 'customer_sub_account_api_key') {
        return canonicalPath.startsWith(`assets_v2/${actor.customerSubAccountId || actor.customerSubAccount?._id}/`);
      }
      if (actor.authType === 'external_auth') {
        return canonicalPath.startsWith(`assets_v2/${actor.externalUserId || actor.externalUser?._id}/`);
      }
      return actor.internalUserId === 'owner'
        || (actor.internalUserId === 'collaborator' && canonicalPath.startsWith('assets_v2/shared/'));
    },
  });
  app.get('/later/api', (_req, res) => res.json({ healthy: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { server, root, seen };
}

test('private static roots and legacy aliases require own or shared authorization', async t => {
  const { server } = await fixture(t);
  for (const route of ['/assets/legacy.mp4', '/legacy.mp4', '/assets_v2/private/media.wav']) {
    assert.equal((await request(server, route)).status, 401);
    assert.equal((await request(server, route, { headers: { Authorization: 'Bearer stranger' } })).status, 403);
    const allowed = await request(server, route, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers['cache-control'], /private.*no-store/);
    assert.match(allowed.headers.vary, /Origin/);
    assert.match(allowed.headers.vary, /Authorization/);
  }
  assert.equal((await request(server, '/assets_v2/shared/media.wav', { headers: { Authorization: 'Bearer shared' } })).status, 200);
  assert.equal((await request(server, '/assets_v2/private/media.wav', { headers: { Authorization: 'Bearer shared' } })).status, 403);
  assert.equal((await request(server, '/later/api')).json().healthy, true);
});

test('delegated credentials retain their scope for direct and capability access', async t => {
  const { server } = await fixture(t);
  for (const [credential, ownPath] of [['subaccount', '/assets_v2/sub-a/media.wav'], ['external', '/assets_v2/external-a/media.wav']]) {
    const headers = { Authorization: `Bearer ${credential}` };
    assert.equal((await request(server, ownPath, { headers })).status, 200);
    assert.equal((await request(server, '/assets_v2/private/media.wav', { headers })).status, 403);
    const grant = await request(server, '/v2/assets/access-url', { method: 'POST', headers, body: { path: ownPath } });
    assert.equal(grant.status, 200);
    assert.equal(grant.json().purpose, 'user');
    assert.equal((await request(server, grant.json().url)).status, 200);
    assert.equal((await request(server, '/v2/assets/access-url', { method: 'POST', headers,
      body: { path: 'assets_v2/private/media.wav' } })).status, 403);
  }
});

test('authorized static delivery retains HEAD, Range, 416 and conditional requests', async t => {
  const { server } = await fixture(t);
  const headers = { Authorization: 'Bearer owner' };
  const full = await request(server, '/assets_v2/private/media.wav', { headers });
  assert.equal(full.headers['content-type'], 'audio/wav');
  assert.equal(full.text, '0123456789');
  const head = await request(server, '/assets_v2/private/media.wav', { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], '10');
  const range = await request(server, '/assets_v2/private/media.wav', { headers: { ...headers, Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.text, '2345');
  assert.equal(range.headers['content-range'], 'bytes 2-5/10');
  const invalidRange = await request(server, '/assets_v2/private/media.wav', { headers: { ...headers, Range: 'bytes=30-' } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers['content-range'], 'bytes */10');
  const cached = await request(server, '/assets_v2/private/media.wav', { headers: { ...headers, 'If-None-Match': full.headers.etag } });
  assert.equal(cached.status, 304);
  assert.match(cached.headers['cache-control'], /no-store/);
  const anonymousConditional = await request(server, '/assets_v2/private/media.wav', { headers: { 'If-None-Match': full.headers.etag } });
  assert.equal(anonymousConditional.status, 401);
});

test('path normalization rejects traversal, encoding ambiguity, full URLs and hidden files', () => {
  for (const value of ['assets_v2/../outside', 'assets_v2/%2e%2e/outside', 'assets_v2/%252e%252e/outside',
    'assets_v2/a%2fb', 'assets_v2/a%252fb', 'assets_v2/a\\b', 'assets_v2/.secret',
    'assets_v2//file', 'assets_v2/file?token=x', 'https://example.com/assets_v2/file', '//assets_v2/file', 'assets_v2/%00']) {
    assert.equal(normalizePrivateAssetPath(value), null, value);
  }
  assert.equal(normalizePrivateAssetPath('/assets_v2/private/image%20one.png'), 'assets_v2/private/image one.png');
});

test('file serving rejects symlinks outside either root and supports checked in-root links', async t => {
  const { server } = await fixture(t, { canAccessAsset: () => true });
  for (const route of ['/assets/outside-link.txt', '/outside-link.txt', '/assets_v2/private/outside-link.txt']) {
    const result = await request(server, route, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(result.status, 403);
    assert.equal(result.text.includes('must never be returned'), false);
  }
  assert.equal((await request(server, '/assets_v2/private/inside-link.wav', { headers: { Authorization: 'Bearer owner' } })).text, '0123456789');
  for (const route of ['/assets_v2/%2e%2e/outside.txt', '/assets_v2/%252e%252e/outside.txt', '/assets_v2/a%2fb']) {
    assert.equal((await request(server, route, { headers: { Authorization: 'Bearer owner' } })).status, 400);
  }
});

test('exact-path capabilities exclude raw credentials and fail on expiry, tampering and purpose swap', () => {
  const now = Date.now();
  const token = mintPrivateAssetToken({ actor: { ...subaccount, apiKey: 'never include', secret: 'never include' },
    path: 'assets_v2/sub-a/media.wav', now });
  const decoded = jwt.decode(token);
  assert.deepEqual(decoded.actor, { authType: 'customer_sub_account_api_key', internalUserId: 'owner', customerSubAccountId: 'sub-a' });
  assert.equal(JSON.stringify(decoded).includes('never include'), false);
  assert.equal(verifyPrivateAssetToken(token, { path: 'assets_v2/sub-a/media.wav', now }).actor.customerSubAccountId, 'sub-a');
  assert.equal(verifyPrivateAssetToken(token, { path: 'assets_v2/private/media.wav', now }), null);
  assert.equal(verifyPrivateAssetToken(token, { path: 'assets_v2/sub-a/media.wav', purpose: 'provider', now }), null);
  assert.equal(verifyPrivateAssetToken(token, { now: now + 901000 }), null);
  assert.equal(verifyPrivateAssetToken(`${token.slice(0, -8)}tampered`, { now }), null);
  assert.equal(verifyPrivateAssetToken(jwt.sign({ _id: 'owner' }, TEST_SECRET), { now }), null);
  assert.throws(() => mintPrivateAssetToken({ actor: owner, path: 'assets_v2/private/media.wav', expiresInSeconds: 901 }));
});

test('read-only share capability scope is paired, strict and contains only the share hash', () => {
  const scope = { ...owner, readOnlyShareSessionId: 'a'.repeat(24), readOnlyShareTokenHash: 'b'.repeat(64) };
  const token = mintPrivateAssetToken({ actor: scope, path: 'assets_v2/private/media.wav' });
  assert.deepEqual(verifyPrivateAssetToken(token).actor, scope);
  for (const malformed of [
    { ...owner, readOnlyShareSessionId: 'a'.repeat(24) },
    { ...scope, readOnlyShareTokenHash: 'not-a-sha256-hash' },
    { ...scope, readOnlyShareSessionId: '../session' },
  ]) assert.throws(() => mintPrivateAssetToken({ actor: malformed, path: 'assets_v2/private/media.wav' }));
});

test('capability fetch rechecks ownership and refuses a different explicitly supplied account', async t => {
  let authorized = true;
  const { server, seen } = await fixture(t, { canAccessAsset: () => authorized });
  const grant = await request(server, '/api/v2/assets/access-url', { method: 'POST',
    headers: { Authorization: 'Bearer owner' }, body: { path: 'assets_v2/private/media.wav' } });
  assert.equal(grant.status, 200);
  const url = grant.json().url;
  assert.equal((await request(server, url)).status, 200);
  assert.equal((await request(server, url, { headers: { Authorization: 'Bearer stranger' } })).status, 401);
  assert.equal((await request(server, url, { headers: { 'x-samsar-app-key': 'unrecognized' } })).status, 401);
  authorized = false;
  assert.equal((await request(server, url)).status, 403);
  assert.ok(seen.length >= 3);
  assert.equal((await request(server, url.replace('/private/', '/shared/'))).status, 401);
});

test('provider grants require the internal header and use validated configured origin', async t => {
  const previousInternal = process.env.INTERNAL_SECRET;
  const previousBase = process.env.PUBLIC_API_BASE_URL;
  process.env.INTERNAL_SECRET = 'provider-internal-fixture-secret-at-least-32-bytes';
  process.env.PUBLIC_API_BASE_URL = 'https://media.example.com';
  t.after(() => {
    if (previousInternal === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousInternal;
    if (previousBase === undefined) delete process.env.PUBLIC_API_BASE_URL;
    else process.env.PUBLIC_API_BASE_URL = previousBase;
  });
  const { server } = await fixture(t, { canAccessAsset: () => false });
  const endpoint = '/internal/production-assets/provider-url';
  const body = { mediaPath: 'assets/legacy.mp4', serviceName: 'test' };
  assert.equal((await request(server, endpoint, { method: 'POST', body })).status, 404);
  assert.equal((await request(server, `${endpoint}?secret=${process.env.INTERNAL_SECRET}`, { method: 'POST', body })).status, 404);
  const grant = await request(server, endpoint, { method: 'POST', body,
    headers: { 'x-samsar-internal-secret': process.env.INTERNAL_SECRET, Host: 'attacker.invalid' } });
  assert.equal(grant.status, 200);
  assert.equal(grant.json().expires_in_seconds, 300);
  assert.equal(grant.json().purpose, 'provider');
  assert.ok(grant.json().url.startsWith('https://media.example.com/assets/legacy.mp4?asset_token='));
  const url = new URL(grant.json().url);
  assert.equal((await request(server, `${url.pathname}${url.search}`)).status, 200);
  assert.equal((await request(server, `${url.pathname.replace('legacy.mp4', 'outside-link.txt')}${url.search}`)).status, 401);
});

test('production publication base selection matches stable, tunnel and validated external mode', async () => {
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env: {}, runtimeConfig: {
    publication: { mode: 'stable', publicBaseUrl: 'https://stable.example.com/' },
  } }), 'https://stable.example.com');
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env: {}, runtimeConfig: {
    publication: { mode: 'external', publicBaseUrl: 'https://external.example.com' },
    externalPublish: { enabled: true, securityMode: 'processor-token-proxy', publicBaseUrl: 'https://external.example.com' },
  } }), 'https://external.example.com');
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env: { PUBLIC_API_BASE_URL: 'http://127.0.0.1:3002' }, runtimeConfig: {} }), null);
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env: { PUBLIC_API_BASE_URL: 'https://processor' }, runtimeConfig: {} }), null);
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env: {}, runtimeConfig: {
    publication: { mode: 'external', publicBaseUrl: 'https://a.example.com' },
    externalPublish: { enabled: true, securityMode: 'processor-token-proxy', publicBaseUrl: 'https://b.example.com' },
  } }), null);
});

test('provider signer uses the managed runtime tunnel when Docker processor URL is local', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-runtime-tunnel-'));
  const configPath = path.join(directory, 'samsar.config.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = {
    SAMSAR_RUNTIME_CONFIG_FILE: configPath,
    SAMSAR_DOCKER_PUBLIC_PROCESSOR_BASE_URL: 'http://localhost:3002',
    PUBLIC_API_BASE_URL: 'https://stale-api.example',
    SAMSAR_MEDIA_DELIVERY_MODE: 'docker-local',
  };
  const writeTunnel = async (tunnel) => fs.writeFile(configPath, JSON.stringify({ localMediaTunnel: tunnel }));
  await writeTunnel({ enabled: true, publicUrl: 'https://current-tunnel.trycloudflare.com' });
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env, runtimeConfig: {} }),
    'https://current-tunnel.trycloudflare.com');
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env, runtimeConfig: {
    publication: { mode: 'stable', publicBaseUrl: 'https://stable.example.com' },
  } }), 'https://stable.example.com');
  await writeTunnel({ enabled: false, publicUrl: 'https://current-tunnel.trycloudflare.com' });
  assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env, runtimeConfig: {} }),
    'https://stale-api.example');
  for (const publicUrl of ['http://current-tunnel.trycloudflare.com',
    'https://localhost', 'https://media.internal', 'https://10.0.0.1',
    'https://current-tunnel.trycloudflare.com/other',
    'https://user:password@current-tunnel.trycloudflare.com']) {
    await writeTunnel({ enabled: true, publicUrl });
    assert.equal(await resolvePrivateAssetPublicBaseUrl({ purpose: 'provider', env, runtimeConfig: {} }),
      'https://stale-api.example',
      publicUrl);
  }
});
