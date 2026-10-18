import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrivateMediaUrl } from './privateMediaUrl.mjs';

const options = {
  processorApiUrl: 'https://api.samsar.one/',
  staticCdnUrl: 'https://media.example',
};

test('private local and legacy media keep their scoped credentials on the processor', () => {
  for (const path of [
    'assets/image.png',
    'assets_v2/user_resources/owner/video.mp4',
    'user_resources/owner/music.mp3',
    'generations/image.png',
  ]) {
    const credential = '?asset_token=v1.owner%2Bsignature&variant=preview#frame';
    for (const prefix of ['', '/', 'https://static.samsar.one/', 'https://media.example/']) {
      assert.equal(
        resolvePrivateMediaUrl(`${prefix}${path}${credential}`, options),
        `https://api.samsar.one/${path}${credential}`,
      );
    }
  }
});

test('processor URLs retain their path and credentials', () => {
  const url = 'https://api.samsar.one/assets_v2/image.png?asset_token=v1.private';
  assert.equal(resolvePrivateMediaUrl(url, options), url);
});

test('unsigned, third party, and non-HTTP URLs do not change host', () => {
  for (const url of [
    'https://static.samsar.one/assets_v2/image.png',
    'https://media.example/assets_v2/image.png?Expires=2000000000&Signature=cdn&Key-Pair-Id=K1',
    'https://external.example/assets_v2/image.png?asset_token=external',
    '//external.example/assets_v2/image.png?asset_token=external',
    'blob:https://api.samsar.one/image-id?asset_token=external',
    'data:image/png;base64,AAA',
    '/assets_v2/image.png?asset_token=',
    '',
    null,
  ]) {
    assert.equal(resolvePrivateMediaUrl(url, options), null);
  }
});

test('private relative media support same-origin delivery', () => {
  assert.equal(
    resolvePrivateMediaUrl('assets_v2/image.png?asset_token=local'),
    '/assets_v2/image.png?asset_token=local',
  );
});
