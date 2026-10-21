import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAccessibleMediaUrlForProvider } from './MediaReferenceUtils.js';

const originalFetch = globalThis.fetch;
const originalTunnelTestEnv = {
  INTERNAL_SECRET: process.env.INTERNAL_SECRET,
  SAMSAR_MEDIA_TUNNEL_REFRESH_WAIT_MS: process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_WAIT_MS,
  SAMSAR_MEDIA_TUNNEL_REFRESH_POLL_MS: process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_POLL_MS,
  SAMSAR_MEDIA_TUNNEL_REFRESH_REQUEST_PATH: process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_REQUEST_PATH,
};

test.beforeEach(() => {
  // The tunnel fallback cases model an installation without a private signer.
  // Docker normally supplies INTERNAL_SECRET, so leave it out explicitly.
  delete process.env.INTERNAL_SECRET;
  globalThis.fetch = async (url) => {
    // The real container may also mount a live managed tunnel in its runtime
    // config. Only this test's explicitly configured tunnel is reachable.
    const configuredTunnel = process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL;
    let reachable = false;
    try {
      reachable = Boolean(configuredTunnel) &&
        new URL(url).origin === new URL(configuredTunnel).origin;
    } catch {}
    return {
      ok: reachable,
      status: reachable ? 206 : 503,
      headers: { get: () => reachable ? 'image/png' : 'application/json' },
      body: { cancel: async () => {} },
    };
  };
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_WAIT_MS = '1';
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_POLL_MS = '10';
  process.env.SAMSAR_MEDIA_TUNNEL_REFRESH_REQUEST_PATH = path.join(
    os.tmpdir(),
    `samsar-generator-media-refresh-${Date.now()}-${Math.random()}.json`,
  );
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalTunnelTestEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('docker media URLs can prefer the internal media gateway for local provider fetches', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    MEDIA_PUBLIC_URL: process.env.MEDIA_PUBLIC_URL,
    SAMSAR_PUBLIC_MEDIA_BASE_URL: process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL,
    SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL: process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL,
    SAMSAR_MEDIA_TUNNEL_PUBLIC_URL: process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL,
    SAMSAR_INTERNAL_MEDIA_BASE_URL: process.env.SAMSAR_INTERNAL_MEDIA_BASE_URL,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-ref-'));

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.MEDIA_PUBLIC_URL = 'http://localhost:3002/';
    process.env.SAMSAR_INTERNAL_MEDIA_BASE_URL = 'http://media-gateway';
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.MEDIA_DELIVERY_MODE = 'docker-local';

    const mediaPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([0]));

    const resolved = await getAccessibleMediaUrlForProvider(
      'http://localhost:3002/assets_v2/generations/session-id/frame.png',
      { preferInternalDockerUrl: true },
    );

    assert.equal(resolved, 'http://media-gateway/assets_v2/generations/session-id/frame.png');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('docker media URLs can prefer inline data URLs for vision requests', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    MEDIA_PUBLIC_URL: process.env.MEDIA_PUBLIC_URL,
    SAMSAR_PUBLIC_MEDIA_BASE_URL: process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL,
    SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL: process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL,
    SAMSAR_MEDIA_TUNNEL_PUBLIC_URL: process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL,
    SAMSAR_INTERNAL_MEDIA_BASE_URL: process.env.SAMSAR_INTERNAL_MEDIA_BASE_URL,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-ref-'));

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.MEDIA_PUBLIC_URL = 'http://localhost:3002/';
    process.env.SAMSAR_INTERNAL_MEDIA_BASE_URL = 'http://media-gateway';
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.MEDIA_DELIVERY_MODE = 'docker-local';

    const mediaPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([1, 2, 3]));

    const resolved = await getAccessibleMediaUrlForProvider(
      'http://localhost:3002/assets_v2/generations/session-id/frame.png',
      { preferDataUrl: true, preferInternalDockerUrl: true },
    );

    assert.equal(resolved, 'data:image/png;base64,AQID');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('docker media URLs use the media tunnel for remote provider requests', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    MEDIA_PUBLIC_URL: process.env.MEDIA_PUBLIC_URL,
    SAMSAR_PUBLIC_MEDIA_BASE_URL: process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL,
    SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL: process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL,
    SAMSAR_MEDIA_TUNNEL_PUBLIC_URL: process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-ref-'));

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.MEDIA_PUBLIC_URL = 'http://20.24.15.143/api';
    process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL = 'http://20.24.15.143/api';
    process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL = 'http://20.24.15.143/api';
    process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL = 'https://media-tunnel.trycloudflare.com';
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.MEDIA_DELIVERY_MODE = 'docker-local';

    const mediaPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([4]));

    const resolved = await getAccessibleMediaUrlForProvider(
      'http://20.24.15.143/api/assets_v2/generations/session-id/frame.png',
    );

    assert.equal(resolved, 'https://media-tunnel.trycloudflare.com/assets_v2/generations/session-id/frame.png');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('docker private media URLs use the exact signed URL for provider requests', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    SAMSAR_PRODUCTION_ASSET_SIGNER_URL: process.env.SAMSAR_PRODUCTION_ASSET_SIGNER_URL,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-private-media-ref-'));
  const internalSecret = 'test-internal-secret-for-private-media';
  const mediaPath = 'assets_v2/generations/session-id/frame.png';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({
    purpose: 'provider',
    path: mediaPath,
    iat: nowSeconds,
    exp: nowSeconds + 300,
  })).toString('base64url');
  const signedUrl = `https://media-tunnel.trycloudflare.com/${mediaPath}?asset_token=header.${claims}.signature`;
  const calls = [];

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.SAMSAR_PRODUCTION_ASSET_SIGNER_URL = 'http://processor:3002/internal/production-assets/provider-url';
    process.env.INTERNAL_SECRET = internalSecret;
    const localPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, Buffer.from([4]));

    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ url: signedUrl }) };
      }
      return {
        ok: true,
        status: 206,
        url: signedUrl,
        headers: { get: () => 'image/png' },
        body: { cancel: async () => {} },
      };
    };

    assert.equal(await getAccessibleMediaUrlForProvider(`/${mediaPath}`), signedUrl);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, process.env.SAMSAR_PRODUCTION_ASSET_SIGNER_URL);
    assert.equal(calls[0].options.headers['x-samsar-internal-secret'], internalSecret);
    assert.deepEqual(JSON.parse(calls[0].options.body), { mediaPath });
    assert.equal(calls[1].url, signedUrl);
    assert.equal(calls[1].options.headers.Range, 'bytes=0-0');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('docker media URLs require a media tunnel for remote provider requests', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    MEDIA_PUBLIC_URL: process.env.MEDIA_PUBLIC_URL,
    SAMSAR_PUBLIC_MEDIA_BASE_URL: process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL,
    SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL: process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL,
    SAMSAR_MEDIA_TUNNEL_PUBLIC_URL: process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-ref-'));

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.MEDIA_PUBLIC_URL = 'http://20.24.15.143/api';
    process.env.SAMSAR_PUBLIC_MEDIA_BASE_URL = 'http://20.24.15.143/api';
    process.env.SAMSAR_EXTERNAL_MEDIA_PUBLIC_BASE_URL = 'http://20.24.15.143/api';
    delete process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL;
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.MEDIA_DELIVERY_MODE = 'docker-local';

    const mediaPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([5]));

    await assert.rejects(
      () => getAccessibleMediaUrlForProvider(
        'http://20.24.15.143/api/assets_v2/generations/session-id/frame.png',
      ),
      (error) => error?.code === 'SAMSAR_MEDIA_TUNNEL_UNREACHABLE' && error?.retryable === true,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('docker provider media canonicalizes mounted keys and rejects malformed local references', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    SAMSAR_ASSETS_ROOT: process.env.SAMSAR_ASSETS_ROOT,
    SAMSAR_MEDIA_TUNNEL_PUBLIC_URL: process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-canonical-'));
  const assetsV2Root = path.join(tempRoot, 'assets_v2');
  const assetsRoot = path.join(tempRoot, 'assets');

  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = assetsV2Root;
    process.env.SAMSAR_ASSETS_ROOT = assetsRoot;
    process.env.SAMSAR_MEDIA_TUNNEL_PUBLIC_URL = 'https://media-tunnel.trycloudflare.com';
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    process.env.MEDIA_DELIVERY_MODE = 'docker-local';
    const bareReference = 'generations/session-id/frame.png';
    const mediaPath = path.join(assetsV2Root, bareReference);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.mkdir(assetsRoot, { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([6]));

    assert.equal(
      await getAccessibleMediaUrlForProvider(bareReference),
      'https://media-tunnel.trycloudflare.com/assets_v2/generations/session-id/frame.png',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider('https://third-party.example/assets_v2/reference.png'),
      'https://third-party.example/assets_v2/reference.png',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider('https://s3.us-east-1.amazonaws.com/unrelated-bucket/assets_v2/reference.png'),
      'https://s3.us-east-1.amazonaws.com/unrelated-bucket/assets_v2/reference.png',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider('https://foreign.trycloudflare.com/assets_v2/other/reference.png'),
      'https://foreign.trycloudflare.com/assets_v2/other/reference.png',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider(
        'https://expired.trycloudflare.com/assets_v2/generations/session-id/frame.png',
      ),
      'https://media-tunnel.trycloudflare.com/assets_v2/generations/session-id/frame.png',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider('https://static.samsar.one/assets_v2/other/reference.png'),
      'https://static.samsar.one/assets_v2/other/reference.png',
    );
    await assert.rejects(
      () => getAccessibleMediaUrlForProvider('http://localhost:3002/not-assets/frame.png'),
      (error) => error?.code === 'SAMSAR_PROVIDER_MEDIA_REFERENCE_INVALID' && error?.retryable === false,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('docker external-S3 media fails closed instead of using an implicit hosted CDN', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
    MEDIA_DELIVERY_MODE: process.env.MEDIA_DELIVERY_MODE,
    SAMSAR_EXTERNAL_MEDIA_PUBLISH_ENABLED: process.env.SAMSAR_EXTERNAL_MEDIA_PUBLISH_ENABLED,
    MEDIA_BUCKET_NAME: process.env.MEDIA_BUCKET_NAME,
    STATIC_CDN_BUCKET: process.env.STATIC_CDN_BUCKET,
    STATIC_CDN_URL: process.env.STATIC_CDN_URL,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-external-media-config-'));
  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'external-s3';
    process.env.MEDIA_DELIVERY_MODE = 'external-s3';
    process.env.SAMSAR_EXTERNAL_MEDIA_PUBLISH_ENABLED = 'true';
    delete process.env.MEDIA_BUCKET_NAME;
    delete process.env.STATIC_CDN_BUCKET;
    delete process.env.STATIC_CDN_URL;
    const mediaPath = path.join(tempRoot, 'generations', 'session-id', 'frame.png');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([7]));

    await assert.rejects(
      () => getAccessibleMediaUrlForProvider('/assets_v2/generations/session-id/frame.png'),
      (error) => error?.code === 'SAMSAR_PROVIDER_MEDIA_REFERENCE_INVALID',
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hosted provider media does not forward a private original after CDN prime failure', () => {
  // AWS.js captures STATIC_CDN_URL at import. Start a fresh process so this
  // hosted contract remains testable inside a Docker configured test runner.
  const script = `
    import assert from 'node:assert/strict';
    import { getAccessibleMediaUrlForProvider } from './src/utils/MediaReferenceUtils.js';
    console.error = () => {};
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return { ok: false, status: 403, body: { cancel: async () => {} } };
    };
    await assert.rejects(
      () => getAccessibleMediaUrlForProvider('https://static.samsar.one/assets_v2/generations/session/frame.png'),
      /CDN cache prime returned status 403/,
    );
    assert.equal(fetchCount, 3);
    await assert.rejects(
      () => getAccessibleMediaUrlForProvider('http://localhost:3002/private.png'),
      (error) => error?.code === 'SAMSAR_PROVIDER_MEDIA_REFERENCE_INVALID',
    );
    assert.equal(
      await getAccessibleMediaUrlForProvider('https://third-party.example/public.png'),
      'https://third-party.example/public.png',
    );
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CURRENT_ENV: 'production',
      SAMSAR_RUNTIME: 'server',
      SAMSAR_MEDIA_DELIVERY_MODE: 's3-cloudfront',
      STATIC_CDN_URL: 'https://static.samsar.one/',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('inline Docker media uses a media-kind-correct fallback MIME type', async () => {
  const previousEnv = {
    CURRENT_ENV: process.env.CURRENT_ENV,
    SAMSAR_ASSETS_V2_ROOT: process.env.SAMSAR_ASSETS_V2_ROOT,
    SAMSAR_MEDIA_DELIVERY_MODE: process.env.SAMSAR_MEDIA_DELIVERY_MODE,
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-media-mime-'));
  try {
    process.env.CURRENT_ENV = 'docker';
    process.env.SAMSAR_ASSETS_V2_ROOT = tempRoot;
    process.env.SAMSAR_MEDIA_DELIVERY_MODE = 'docker-local';
    const mediaPath = path.join(tempRoot, 'audio', 'sample.unknown');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([1, 2]));
    assert.equal(
      await getAccessibleMediaUrlForProvider('/assets_v2/audio/sample.unknown', {
        preferDataUrl: true,
        mediaKind: 'audio',
      }),
      'data:audio/mpeg;base64,AQI=',
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
