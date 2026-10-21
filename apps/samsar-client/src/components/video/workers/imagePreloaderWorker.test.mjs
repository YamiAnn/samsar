import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const workerSource = await readFile(new URL('./imagePreloaderWorker.jsx', import.meta.url), 'utf8');

test('image preloading skips private no-store media to avoid duplicate canvas requests', async () => {
  const requestedUrls = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const self = {
    postMessage: finish,
  };
  runInNewContext(workerSource, {
    self,
    URL,
    AbortController,
    fetch: async (url) => {
      requestedUrls.push(url);
      return { ok: true, blob: async () => new Blob() };
    },
  });
  self.onmessage({ data: {
    type: 'CONFIG',
    apiServer: 'https://api.samsar.one/',
    staticCdnUrl: 'https://static.samsar.one',
  } });
  self.onmessage({ data: {
    type: 'PRELOAD_LAYERS',
    requestId: 'private-images',
    layers: [{ imageSession: { activeItemList: [
      { type: 'image', src: 'https://static.samsar.one/assets/private.png?asset_token=v1.image%2Bsignature&size=preview' },
      { type: 'image', previewUrl: 'https://static.samsar.one/assets_v2/user_resources/owner/private.png?asset_token=v1.owner' },
      { type: 'image', src: '/assets_v2/users/session/image.png?asset_token=v1.relative' },
      { type: 'image', src: 'https://static.samsar.one/assets_v2/image.png?Expires=2000000000&Signature=cdn&Key-Pair-Id=K1' },
      { type: 'image', src: 'https://static.samsar.one/assets_v2/user_resources/public.png' },
      { type: 'image', src: '/video_sessions/guest_media?sessionId=shared&assetKey=assets_v2%2Fshared%2Fimage.png' },
    ] } }],
  } });
  const result = await completed;
  assert.equal(result.type, 'PRELOAD_COMPLETE');
  assert.equal(result.loadedCount, 2);
  assert.deepEqual(requestedUrls, [
    'https://static.samsar.one/assets_v2/image.png?Expires=2000000000&Signature=cdn&Key-Pair-Id=K1',
    'https://api.samsar.one/video_sessions/guest_media?sessionId=shared&assetKey=assets_v2%2Fshared%2Fimage.png',
  ]);
});
