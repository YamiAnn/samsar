import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePrivateProviderAssetUrl } from './PrivateProviderUrlClient.js';
import { resolveFreshManagedProviderMediaUrl } from './ProviderMediaTunnel.js';

const mediaPath = 'assets_v2/users/session/video.mp4';
const internalSecret = 'test-only-private-asset-internal-secret-123456';
const env = { INTERNAL_SECRET: internalSecret, SAMSAR_RUNTIME: 'docker' };

function providerUrl({ path = mediaPath, claims = {}, base = 'https://media.example' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { purpose: 'provider', path, iat: now, exp: now + 300, ...claims };
  const token = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
  return `${base}/${path.split('/').map(encodeURIComponent).join('/')}?asset_token=${token}`;
}

function fixture({ url = providerUrl(), status = 206, contentType = 'video/mp4', finalUrl } = {}) {
  const calls = [];
  let cancelled = 0;
  const fetchImpl = async (target, options) => {
    calls.push({ url: target, ...options });
    if (options.method === 'POST') return { ok: true, json: async () => ({ url }) };
    return {
      ok: status >= 200 && status < 300,
      status,
      url: finalUrl || target,
      headers: { get: () => contentType },
      body: { cancel: async () => { cancelled += 1; } },
    };
  };
  return { fetchImpl, calls, get cancelled() { return cancelled; } };
}

test('private provider URL uses a trusted signer and probes only the scoped signed URL', async () => {
  const signedUrl = providerUrl();
  const request = fixture({ url: signedUrl });
  assert.equal(await resolvePrivateProviderAssetUrl({
    mediaPath, expectedContentTypePrefix: 'video/', fetchImpl: request.fetchImpl, env,
  }), signedUrl);
  assert.equal(request.calls.length, 2);
  const [signer, probe] = request.calls;
  assert.equal(signer.url, 'http://processor:3002/internal/production-assets/provider-url');
  assert.deepEqual(JSON.parse(signer.body), { mediaPath });
  assert.equal(signer.headers['x-samsar-internal-secret'], internalSecret);
  assert.equal(signer.redirect, 'error');
  assert.equal(probe.url, signedUrl);
  assert.deepEqual(probe.headers, { Range: 'bytes=0-0' });
  assert.equal(probe.redirect, 'error');
  assert.equal(probe.credentials, 'omit');
  assert.equal(probe.cache, 'no-store');
  assert.equal(request.cancelled, 1);
  assert.equal(request.calls.some(call => call.url.includes(internalSecret)), false);
});

test('both canonical media folders and encoded spaces are signed', async () => {
  for (const path of ['assets/generations/image.png', 'assets_v2/users/owner/video with space.mp4']) {
    const request = fixture({ url: providerUrl({ path }) });
    const result = await resolvePrivateProviderAssetUrl({
      mediaPath: `/${path.replaceAll(' ', '%20')}`, fetchImpl: request.fetchImpl, env,
    });
    assert.equal(new URL(result).pathname, `/${path.replaceAll(' ', '%20')}`);
    assert.deepEqual(JSON.parse(request.calls[0].body), { mediaPath: path });
  }
});

test('host runtime and an explicit trusted signer endpoint are supported', async () => {
  for (const [config, expectedUrl] of [
    [{ ...env, SAMSAR_RUNTIME: 'server' }, 'http://localhost:3002/internal/production-assets/provider-url'],
    [{ ...env, SAMSAR_PRODUCTION_ASSET_SIGNER_URL: 'https://signer.example/private/media' }, 'https://signer.example/private/media'],
  ]) {
    const request = fixture();
    await resolvePrivateProviderAssetUrl({ mediaPath, fetchImpl: request.fetchImpl, env: config });
    assert.equal(request.calls[0].url, expectedUrl);
  }
});

test('external delivery and unavailable local signer credentials preserve existing URL flows', async () => {
  const neverFetch = async () => { assert.fail('The signer must not be called.'); };
  for (const config of [
    {}, { INTERNAL_SECRET: 'short' }, { INTERNAL_SECRET: 'change-me'.repeat(5) },
    { ...env, SAMSAR_EXTERNAL_MEDIA_PUBLISH_ENABLED: 'true' },
    { ...env, EXTERNAL_MEDIA_PUBLISH_ENABLED: 'true' },
    { ...env, SAMSAR_MEDIA_DELIVERY_MODE: 's3-cloudfront' },
    { ...env, MEDIA_DELIVERY_MODE: 'external-s3' },
  ]) {
    assert.equal(await resolvePrivateProviderAssetUrl({ mediaPath, fetchImpl: neverFetch, env: config }), null);
  }
  assert.equal(await resolvePrivateProviderAssetUrl({ mediaPath: 'other/image.png', fetchImpl: neverFetch, env }), null);
  assert.equal(await resolvePrivateProviderAssetUrl({ mediaPath: 'https://untrusted.example/assets_v2/image.png', fetchImpl: neverFetch, env }), null);
});

test('unsafe paths are rejected before invoking a signer', async () => {
  for (const path of [
    'assets_v2/../secret', 'assets/%2e%2e/secret', 'assets_v2/%252e%252e/secret',
    'assets_v2/users%2fother/file', 'assets_v2/users%5cother/file', 'assets_v2/.hidden/file',
    'assets_v2/file?query', 'assets_v2/file#fragment', 'assets_v2/file%00', 'assets_v2//file',
  ]) {
    await assert.rejects(resolvePrivateProviderAssetUrl({
      mediaPath: path, fetchImpl: async () => assert.fail('must not fetch'), env,
    }), { code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE' });
  }
});

test('expired, future, excessive-lifetime, wrong-purpose and wrong-path grants are rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { exp: now - 1 }, { iat: now + 60, exp: now + 300 }, { exp: now + 3601 },
    { purpose: 'user' }, { path: 'assets_v2/users/other/video.mp4' },
    { iat: now + 1, exp: now + 1 },
  ]) {
    const request = fixture({ url: providerUrl({ claims }) });
    await assert.rejects(resolvePrivateProviderAssetUrl({ mediaPath, fetchImpl: request.fetchImpl, env }), {
      code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE',
    });
    assert.equal(request.calls.length, 1);
  }
});

test('public HTTPS, exact paths and a single valid media grant are required before probing', async () => {
  const goodUrl = providerUrl();
  for (const url of [
    providerUrl({ base: 'http://media.example' }),
    providerUrl({ base: 'https://localhost' }),
    providerUrl({ base: 'https://127.0.0.1' }),
    providerUrl({ base: 'https://10.0.0.1' }),
    providerUrl({ base: 'https://192.168.1.2' }),
    providerUrl({ base: 'https://100.64.0.1' }),
    providerUrl({ base: 'https://[::ffff:127.0.0.1]' }),
    providerUrl({ base: 'https://processor' }),
    providerUrl({ base: 'https://user:password@media.example' }),
    providerUrl({ path: 'assets_v2/other/video.mp4' }),
    `https://media.example/${mediaPath}`,
    `https://media.example/${mediaPath}?asset_token=invalid`,
    `${goodUrl}&asset_token=duplicate`,
    `${goodUrl}#fragment`,
  ]) {
    const request = fixture({ url });
    await assert.rejects(resolvePrivateProviderAssetUrl({ mediaPath, fetchImpl: request.fetchImpl, env }), {
      code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE',
    });
    assert.equal(request.calls.length, 1);
  }
});

test('denied or non-media signed fetches stop provider dispatch', async () => {
  for (const overrides of [
    { status: 401 }, { status: 403 }, { status: 404 }, { status: 500 },
    { contentType: 'text/html' }, { finalUrl: 'http://media.example/redirect' },
    { finalUrl: 'https://other.example/redirect' },
  ]) {
    const request = fixture(overrides);
    await assert.rejects(resolvePrivateProviderAssetUrl({
      mediaPath, fetchImpl: request.fetchImpl, env, expectedContentTypePrefix: 'video/',
    }), { code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE' });
    assert.equal(request.cancelled, 1);
  }
});

test('signer HTTP, JSON, transport and probe errors fail closed', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, json: async () => ({ message: 'Denied.' }) }),
    async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON.'); } }),
    async () => { throw new Error('Connection unavailable.'); },
    async (_url, options) => {
      if (options.method === 'POST') return { ok: true, json: async () => ({ url: providerUrl() }) };
      throw new Error('Probe unavailable.');
    },
  ]) {
    await assert.rejects(resolvePrivateProviderAssetUrl({ mediaPath, fetchImpl, env }), {
      code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE', retryable: true,
    });
  }
});

test('signer 503 reports missing public delivery without exposing credentials', async () => {
  await assert.rejects(resolvePrivateProviderAssetUrl({
    mediaPath,
    env,
    fetchImpl: async () => ({ ok: false, status: 503,
      json: async () => ({ error: 'Public media delivery is not configured.' }) }),
  }), error => {
    assert.equal(error.code, 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE');
    assert.equal(error.status, 503);
    assert.equal(error.tunnelRefreshRequired, true);
    assert.match(error.message, /HTTP 503.*Public media delivery is not configured/);
    assert.equal(error.message.includes(internalSecret), false);
    return true;
  });
});

test('a failed exact signed-media probe requests tunnel refresh', async () => {
  const request = fixture({ status: 502 });
  await assert.rejects(resolvePrivateProviderAssetUrl({
    mediaPath, env, fetchImpl: request.fetchImpl, expectedContentTypePrefix: 'video/',
  }), error => {
    assert.equal(error.code, 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE');
    assert.equal(error.status, 502);
    assert.equal(error.tunnelRefreshRequired, true);
    return true;
  });
  assert.equal(request.calls.length, 2);
});

test('invalid configured signer URLs do not receive the internal credential', async () => {
  for (const url of ['file:///tmp/signer', 'https://user:pass@signer.example/path', 'https://signer.example/path?key=private']) {
    await assert.rejects(resolvePrivateProviderAssetUrl({
      mediaPath, env: { ...env, SAMSAR_PRODUCTION_ASSET_SIGNER_URL: url },
      fetchImpl: async () => assert.fail('must not fetch'),
    }), { code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE' });
  }
});

test('the shared timeout aborts a stalled signer', async () => {
  await assert.rejects(resolvePrivateProviderAssetUrl({
    mediaPath,
    env: { ...env, SAMSAR_PRODUCTION_ASSET_SIGNER_TIMEOUT_MS: '100' },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true });
    }),
  }), { code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE' });
});

test('a configured signer failure prevents managed-tunnel anonymous fallback', async () => {
  const previousSecret = process.env.INTERNAL_SECRET;
  const previousMode = process.env.SAMSAR_MEDIA_DELIVERY_MODE;
  const originalFetch = globalThis.fetch;
  let candidatesRequested = false;
  process.env.INTERNAL_SECRET = internalSecret;
  process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
  globalThis.fetch = async () => { throw new Error('Signer unavailable.'); };
  try {
    await assert.rejects(resolveFreshManagedProviderMediaUrl({
      mediaPath,
      expectedContentTypePrefix: 'video/',
      fetchImpl: globalThis.fetch,
      getBaseUrlCandidates: () => { candidatesRequested = true; return ['https://anonymous.example']; },
    }), { code: 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE' });
    assert.equal(candidatesRequested, false);
  } finally {
    if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previousSecret;
    if (previousMode === undefined) delete process.env.SAMSAR_MEDIA_DELIVERY_MODE;
    else process.env.SAMSAR_MEDIA_DELIVERY_MODE = previousMode;
    globalThis.fetch = originalFetch;
  }
});

test('a missing tunnel requests refresh and retries the exact private signed URL', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-private-tunnel-'));
  const refreshPath = path.join(directory, 'refresh.json');
  const previous = Object.fromEntries([
    'INTERNAL_SECRET', 'SAMSAR_MEDIA_DELIVERY_MODE', 'SAMSAR_MEDIA_TUNNEL_REFRESH_REQUEST_PATH',
    'SAMSAR_MEDIA_TUNNEL_REFRESH_WAIT_MS', 'SAMSAR_MEDIA_TUNNEL_REFRESH_POLL_MS',
  ].map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });
  process.env.INTERNAL_SECRET = internalSecret;
  process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_REQUEST_PATH = refreshPath;
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_WAIT_MS = '500';
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_POLL_MS = '10';
  let signerCalls = 0;
  let candidatesRequested = false;
  const signedUrl = providerUrl();
  globalThis.fetch = async (target, options) => {
    if (options.method === 'POST') {
      signerCalls += 1;
      return signerCalls === 1
        ? { ok: false, status: 503, json: async () => ({ error: 'Public media delivery is not configured.' }) }
        : { ok: true, status: 200, json: async () => ({ url: signedUrl }) };
    }
    assert.equal(target, signedUrl);
    return { ok: true, status: 206, url: signedUrl,
      headers: { get: () => 'video/mp4' }, body: { cancel: async () => {} } };
  };
  const actual = await resolveFreshManagedProviderMediaUrl({
    mediaPath,
    expectedContentTypePrefix: 'video/',
    getBaseUrlCandidates: () => { candidatesRequested = true; return ['https://anonymous.example']; },
  });
  assert.equal(actual, signedUrl);
  assert.equal(signerCalls, 2);
  assert.equal(candidatesRequested, false);
  const marker = JSON.parse(await fs.readFile(refreshPath, 'utf8'));
  assert.equal(marker.mediaPath, mediaPath);
  assert.equal(JSON.stringify(marker).includes(internalSecret), false);
  assert.equal(JSON.stringify(marker).includes('asset_token'), false);
});
