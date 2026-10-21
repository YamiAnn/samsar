import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioImagePool } from './studioImagePool.mjs';
import { getStudioMediaIdentity, mergeStudioMediaCredentials } from './studioMediaIdentity.mjs';

function images(t) {
  const previous = globalThis.Image;
  const created = [];
  globalThis.Image = class {
    naturalWidth = 100;
    naturalHeight = 100;
    decode = async () => {};
    set src(value) { this.url = value; if (value) created.push(this); }
    get src() { return this.url; }
  };
  t.after(() => { if (previous === undefined) delete globalThis.Image; else globalThis.Image = previous; });
  return created;
}

test('P2P: concurrent consumers and rotated private credentials share one decoded image', async t => {
  const created = images(t);
  const pool = createStudioImagePool();
  const first = pool.load('/assets_v2/image.png?asset_token=one');
  const second = pool.load('/assets_v2/image.png?asset_token=two');
  assert.equal(created.length, 1);
  await created[0].onload();
  assert.equal(await first, await second);
  pool.dispose();
});

test('P2P: content versions and different origins retain distinct identities', () => {
  assert.notEqual(getStudioMediaIdentity('/image.png?v=1&asset_token=a'), getStudioMediaIdentity('/image.png?v=2&asset_token=b'));
  assert.notEqual(getStudioMediaIdentity('https://one.test/image.png?asset_token=a'), getStudioMediaIdentity('https://two.test/image.png?asset_token=a'));
});

test('P2P: completed image cache evicts least recently used entries', async t => {
  const created = images(t);
  const pool = createStudioImagePool({ maxEntries: 2 });
  for (const url of ['/one.png', '/two.png', '/three.png']) {
    const request = pool.load(url);
    await created.at(-1).onload();
    await request;
  }
  const reload = pool.load('/one.png');
  assert.equal(created.length, 4);
  await created.at(-1).onload();
  await reload;
  pool.dispose();
});

test('P2P: failed images request credential recovery and can be retried', async t => {
  const created = images(t);
  const failures = [];
  const pool = createStudioImagePool({ onError: url => failures.push(url) });
  const first = pool.load('/private.png?asset_token=old');
  created[0].onerror();
  assert.equal(await first, null);
  assert.equal(failures.length, 1);
  const retry = pool.load('/private.png?asset_token=new');
  await created[1].onload();
  assert.ok(await retry);
  pool.dispose();
});

test('P2P: disposal settles pending requests without triggering credential recovery', async t => {
  images(t);
  let failed = false;
  const pool = createStudioImagePool({ onError: () => { failed = true; } });
  const request = pool.load('/pending.png');
  pool.dispose();
  assert.equal(await request, null);
  assert.equal(failed, false);
});

test('P2P: private resource pools never share users or sessions', async t => {
  const created = images(t);
  const firstPool = createStudioImagePool();
  const secondPool = createStudioImagePool();
  const first = firstPool.load('/private.png?asset_token=user-one');
  const second = secondPool.load('/private.png?asset_token=user-two');
  assert.equal(created.length, 2);
  await Promise.all(created.map(image => image.onload()));
  await Promise.all([first, second]);
  firstPool.dispose(); secondPool.dispose();
});

test('P2P: refreshing credentials preserves unsaved content, timing and scene order', () => {
  const previous = { layers: [
    { _id: 'second', duration: 9, imageSession: { activeItemList: [{ id: 'image', src: '/assets_v2/a.png?asset_token=old', x: 42 }] } },
    { _id: 'first', duration: 1 },
  ] };
  const incoming = { layers: [
    { _id: 'first', duration: 7 },
    { _id: 'second', duration: 3, imageSession: { activeItemList: [{ id: 'image', src: '/assets_v2/a.png?asset_token=new', x: 0 }] } },
  ] };
  const result = mergeStudioMediaCredentials(previous, incoming);
  assert.equal(result.layers[0]._id, 'second');
  assert.equal(result.layers[0].duration, 9);
  assert.equal(result.layers[0].imageSession.activeItemList[0].x, 42);
  assert.equal(result.layers[0].imageSession.activeItemList[0].src, '/assets_v2/a.png?asset_token=new');
  assert.equal(previous.layers[0].imageSession.activeItemList[0].src, '/assets_v2/a.png?asset_token=old');
});

test('P2P: jumping scenes cancels the obsolete speculative preload window', async t => {
  const created = images(t);
  const pool = createStudioImagePool();
  const oldWindow = pool.preload(['/old-one.png', '/old-two.png', '/old-three.png']);
  const newWindow = pool.preload(['/active.png']);
  await Promise.all(created.map(image => image.onload()));
  await Promise.all([oldWindow, newWindow]);
  assert.equal(created.some(image => image.src === '/old-three.png'), false);
  pool.dispose();
});
