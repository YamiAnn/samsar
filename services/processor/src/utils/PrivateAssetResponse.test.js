import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { signPrivateAssetReference, signPrivateAssetResponse, privateAssetResponseMiddleware } from './PrivateAssetResponse.js';

const actor = { authType: 'auth_token', internalUserId: 'owner' };
const options = { mint: ({ actor, path }) => `media:${actor.internalUserId}:${path}` };

test('browser media references receive a path-bound credential and retain existing query parameters', () => {
  for (const reference of ['/assets/a.mp4?download=1', 'assets_v2/video/a.mp4', '/generations/a.png']) {
    const signed = signPrivateAssetReference(reference, actor, options);
    const parsed = new URL(signed, 'https://processor.example');
    assert.equal(parsed.searchParams.get('asset_token'), `media:owner:${reference.startsWith('/generations') ? 'assets/generations/a.png' : reference.split('?')[0].replace(/^\//, '')}`);
    if (reference.includes('download')) assert.equal(parsed.searchParams.get('download'), '1');
  }
});

test('signs only recognized media references on configured origins', () => {
  for (const reference of ['https://foreign.example/assets/a.mp4', 'https://foreign.example/a.png', 'ordinary prompt', 'data:image/png;base64,AA', '/users/me', '/assets/%252e%252e/private', '//foreign.example/assets/a.mp4']) {
    assert.equal(signPrivateAssetReference(reference, actor, options), reference);
  }
  const cloudfront = 'https://static.samsar.one/assets_v2/a.mp4?Expires=9&Signature=sig&Key-Pair-Id=id';
  assert.equal(signPrivateAssetReference(cloudfront, actor, options), cloudfront);
});

test('nested JSON, image fields, video downloads, and audio references preserve their serialized types', () => {
  const body = { date: new Date('2026-10-16T00:00:00Z'), image: '/assets_v2/generations/image.png', items: [{ video_url: '/assets/video/a.mp4', download_url: '/assets/video/a.mp4?download=1', audio: '/assets/audio/a.mp3' }], count: 2, empty: null };
  const signed = signPrivateAssetResponse(body, actor, options);
  assert.equal(signed.date, '2026-10-16T00:00:00.000Z');
  assert.match(signed.image, /asset_token=/);
  for (const value of Object.values(signed.items[0])) assert.match(value, /asset_token=/);
  assert.equal(signed.count, 2);
  assert.equal(signed.empty, null);
  assert.equal(body.image, '/assets_v2/generations/image.png');
});

test('JSON response signing requires a successfully authenticated request', async () => {
  for (const authenticated of [true, false]) {
    let received;
    const res = { json(body) { received = body; return this; } };
    const middleware = privateAssetResponseMiddleware({ ...options, resolveActor: async () => { if (!authenticated) throw new Error('Unauthorized'); return actor; } });
    middleware({ headers: { authorization: 'Bearer fixture' } }, res, (error) => { if (error) throw error; });
    assert.equal(res.json({ url: '/assets_v2/a.mp4' }), res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.url.includes('asset_token='), authenticated);
  }
});

test('public JSON responses stay synchronous and do not invoke authentication or the database', () => {
  let resolverCalls = 0;
  let received;
  const res = { json(body) { received = body; return this; } };
  const middleware = privateAssetResponseMiddleware({ ...options,
    resolveActor() { resolverCalls += 1; throw new Error('Public response must not authenticate.'); } });
  middleware({ url: '/v2/health', headers: {} }, res, () => {});
  const body = { healthy: true, image: '/assets_v2/example.png' };
  assert.equal(res.json(body), res);
  assert.equal(received, body);
  assert.equal(resolverCalls, 0);
});

test('asset grant endpoints preserve their token purpose and canonical path metadata', () => {
  for (const endpoint of ['/v2/assets/access-url', '/api/v2/assets/access-url/', '/internal/production-assets/provider-url']) {
    let received;
    let resolverCalls = 0;
    const res = { json(body) { received = body; return this; } };
    const middleware = privateAssetResponseMiddleware({ ...options,
      resolveActor() { resolverCalls += 1; return actor; } });
    middleware({ originalUrl: `${endpoint}?source=test`, headers: { authorization: 'Bearer fixture' } }, res, () => {});
    const body = { path: 'assets_v2/video/a.mp4', url: '/assets_v2/video/a.mp4?asset_token=provider-grant', purpose: 'provider' };
    res.json(body);
    assert.equal(received, body);
    assert.equal(received.path, 'assets_v2/video/a.mp4');
    assert.equal(resolverCalls, 0);
  }
});

test('encoded filenames and application query strings survive signing and verify against decoded path', () => {
  const reference = '/assets_v2/video/image%20one.png?download=1#preview';
  const signed = signPrivateAssetReference(reference, actor, options);
  const parsed = new URL(signed, 'https://processor.example');
  assert.equal(parsed.pathname, '/assets_v2/video/image%20one.png');
  assert.equal(parsed.searchParams.get('download'), '1');
  assert.equal(parsed.hash, '#preview');
  assert.equal(parsed.searchParams.get('asset_token'), 'media:owner:assets_v2/video/image one.png');
});

test('non-HTTP and credential-bearing references are preserved without adding grants', () => {
  const configured = { ...options, env: { API_SERVER: 'https://processor.example' } };
  for (const reference of ['file:assets_v2/video/a.mp4', 'blob:https://processor.example/assets_v2/video/a.mp4',
    'https://username:password@processor.example/assets_v2/video/a.mp4']) {
    assert.equal(signPrivateAssetReference(reference, actor, configured), reference);
  }
});

test('authenticated read-only share responses mint a revocable session-bound hash grant', async () => {
  const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const shareToken = 'b'.repeat(48);
  const minted = [];
  let received;
  const res = { statusCode: 200, json(body) { received = body; return this; } };
  privateAssetResponseMiddleware({ resolveActor: async () => actor,
    mint: options => { minted.push(options); return 'private-media-grant'; },
  })({ method: 'GET', originalUrl: `/video_sessions/share/${shareToken}`, headers: { authorization: 'Bearer fixture' } }, res, () => {});
  res.json({ _id: sessionId, layers: [{ src: '/assets_v2/video/frames/image.png' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(minted.length, 1);
  assert.equal(minted[0].actor.readOnlyShareSessionId, sessionId);
  assert.equal(minted[0].actor.readOnlyShareTokenHash, createHash('sha256').update(shareToken).digest('hex'));
  assert.equal(JSON.stringify(minted[0]).includes(shareToken), false);
  assert.match(received.layers[0].src, /asset_token=private-media-grant/);
});

test('ordinary, unsuccessful and anonymous share responses cannot mint a share scope', async () => {
  const shareToken = 'b'.repeat(48);
  for (const [pathname, statusCode, headers] of [
    [`/video_sessions/share/${shareToken}`, 404, { authorization: 'Bearer fixture' }],
    ['/video_sessions/details', 200, { authorization: 'Bearer fixture' }],
    [`/video_sessions/share/${shareToken}`, 200, {}],
  ]) {
    const minted = [];
    const res = { statusCode, json() { return this; } };
    privateAssetResponseMiddleware({ resolveActor: async () => actor,
      mint: options => { minted.push(options); return 'private-media-grant'; },
    })({ method: 'GET', originalUrl: pathname, headers }, res, () => {});
    res.json({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', src: '/assets_v2/video/a.mp4' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(minted.every(grant => grant.actor.readOnlyShareTokenHash === undefined));
    if (!headers.authorization) assert.equal(minted.length, 0);
  }
});

test('historical URL-safe read-only share tokens retain their authenticated media grant', async () => {
  const shareToken = 'Historical_URL-safe_share_key_12345';
  const minted = [];
  const res = { statusCode: 200, json() { return this; } };
  privateAssetResponseMiddleware({ resolveActor: async () => actor,
    mint: options => { minted.push(options); return 'private-media-grant'; },
  })({ method: 'GET', originalUrl: `/video_session/share/${shareToken}`, headers: { authorization: 'Bearer fixture' } }, res, () => {});
  res.json({ _id: 'a'.repeat(24), url: '/assets_v2/video/a.mp4' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(minted[0].actor.readOnlyShareTokenHash, createHash('sha256').update(shareToken).digest('hex'));
});

test('legacy audio, global video and intermediate media prefixes receive canonical capabilities', () => {
  for (const prefix of ['audio_studio', 'global_videos', 'intermediates', 'twitter', 'temp', 'avatar_voiceover']) {
    const value = `${prefix}/owner/file.mp4`;
    const signed = signPrivateAssetReference(value, actor, options);
    const parsed = new URL(signed, 'https://processor.example');
    assert.equal(parsed.pathname, `/${value}`);
    assert.equal(parsed.searchParams.get('asset_token'), `media:owner:assets/${value}`);
  }
});

test('known bare generated image fields use the same path as native browser image rendering', () => {
  const filename = 'a2f1f0f8-ec8c-4107-bd14-67cd61809064.png';
  const signed = signPrivateAssetResponse({
    imageSession: { activeGeneratedImage: 'generation_abc.png?download=1', activeEditedImage: 'outpaint_abc.webp',
      activeOutpaintedImage: filename, activeSelectedImage: filename },
    item: { type: 'image', src: filename },
    generated: { url: filename, userId: 'owner' },
    generationImages: [filename, { url: filename }],
  }, actor, options);
  const values = [...Object.values(signed.imageSession), signed.item.src, signed.generated.url,
    signed.generationImages[0], signed.generationImages[1].url];
  for (const value of values) {
    const parsed = new URL(value, 'https://processor.example');
    assert.ok(parsed.pathname.startsWith('/generations/'));
    assert.equal(parsed.searchParams.get('asset_token'), `media:owner:assets${decodeURIComponent(parsed.pathname)}`);
  }
  assert.equal(new URL(signed.imageSession.activeGeneratedImage, 'https://processor.example').searchParams.get('download'), '1');
});

test('bare image-looking prompt, model, name and non-image src values remain unchanged', () => {
  const body = { prompt: 'generation_prompt.png', inputPrompt: 'outpaint_prompt.webp',
    model: 'image_model.jpg', name: 'picture.gif', item: { type: 'text', src: 'generation_text.png' },
    unsafe: { activeGeneratedImage: '../private.png' }, notes: ['generation_note.png'] };
  assert.deepEqual(signPrivateAssetResponse(body, actor, options), body);
});

test('serialized JSON send signs media exactly once without reentering Express JSON delivery', async () => {
  let delivered;
  let resolves = 0;
  let jsonCalls = 0;
  let sendCalls = 0;
  const res = { getHeader() { return 'application/json; charset=utf-8'; },
    json(body) { jsonCalls += 1; return this.send(JSON.stringify(body)); },
    send(body) { sendCalls += 1; delivered = body; return this; } };
  privateAssetResponseMiddleware({ ...options, resolveActor: async () => { resolves += 1; return actor; } })(
    { originalUrl: '/v1/image/status', headers: { authorization: 'Bearer fixture' } }, res,
    error => { if (error) throw error; },
  );
  assert.equal(res.send(JSON.stringify({ result_url: '/assets_v2/generations/image.png', status: 'COMPLETED' })), res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(delivered).result_url.includes('asset_token='), true);
  assert.equal(JSON.parse(delivered).status, 'COMPLETED');
  assert.equal(resolves, 1);
  assert.equal(jsonCalls, 1);
  assert.equal(sendCalls, 1);
});

test('ordinary res.json delivery still resolves and sends exactly once', async () => {
  let delivered;
  let resolves = 0;
  let sendCalls = 0;
  const res = { getHeader() { return 'application/json'; },
    json(body) { return this.send(JSON.stringify(body)); },
    send(body) { sendCalls += 1; delivered = body; return this; } };
  privateAssetResponseMiddleware({ ...options, resolveActor: async () => { resolves += 1; return actor; } })(
    { originalUrl: '/session', headers: { api_key: 'fixture' } }, res,
    error => { if (error) throw error; },
  );
  assert.equal(res.json({ url: '/assets_v2/video/final.mp4' }), res);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(JSON.parse(delivered).url, /asset_token=/);
  assert.equal(resolves, 1);
  assert.equal(sendCalls, 1);
});

test('non-JSON sends, buffers, malformed JSON and unauthenticated serialized JSON remain unchanged', async () => {
  for (const [contentType, body, headers] of [
    ['text/plain', '{"url":"/assets_v2/image.png"}', { authorization: 'Bearer fixture' }],
    ['text/html', '<img src="/assets_v2/image.png">', { authorization: 'Bearer fixture' }],
    ['application/json', Buffer.from('{"url":"/assets_v2/image.png"}'), { authorization: 'Bearer fixture' }],
    ['application/json', '{invalid json}', { authorization: 'Bearer fixture' }],
    ['application/json', '{"url":"/assets_v2/image.png"}', {}],
  ]) {
    let delivered;
    let resolves = 0;
    const res = { getHeader() { return contentType; },
      json() { assert.fail('Passthrough must not enter JSON delivery.'); },
      send(value) { delivered = value; return this; } };
    privateAssetResponseMiddleware({ ...options, resolveActor: async () => { resolves += 1; return actor; } })(
      { originalUrl: '/response', headers }, res, error => { if (error) throw error; },
    );
    assert.equal(res.send(body), res);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, body);
    assert.equal(resolves, 0);
  }
});

test('serialized JSON signing errors reach Express error handling once', async () => {
  const failure = new Error('synthetic signing failure');
  const errors = [];
  const res = { getHeader() { return 'application/problem+json'; },
    json() { assert.fail('Failed signing must not deliver a response.'); },
    send() { assert.fail('Failed signing must not deliver a response.'); } };
  privateAssetResponseMiddleware({ resolveActor: async () => actor, mint() { throw failure; } })(
    { originalUrl: '/serialized_session', headers: { authorization: 'Bearer fixture' } }, res,
    error => { if (error) errors.push(error); },
  );
  res.send(JSON.stringify({ result_url: '/assets_v2/image.png' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
});
