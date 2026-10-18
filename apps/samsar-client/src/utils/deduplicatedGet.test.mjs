import assert from 'node:assert/strict';
import test from 'node:test';
import { deduplicatedGet } from './deduplicatedGet.mjs';

test('concurrent session and polling consumers send one request, then get fresh results', async () => {
  let resolve;
  let calls = 0;
  const client = { get: () => { calls += 1; return new Promise(done => { resolve = done; }); } };
  const first = deduplicatedGet(client, '/session?id=one&cacheBust=1', { headers: { Authorization: 'Bearer owner' } });
  const second = deduplicatedGet(client, '/session?id=one&cacheBust=2', { headers: { Authorization: 'Bearer owner' } });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ data: { id: 'one' } });
  await first;
  const fresh = deduplicatedGet(client, '/session?id=one&cacheBust=3', { headers: { Authorization: 'Bearer owner' } });
  await Promise.resolve();
  assert.equal(calls, 2);
  resolve({ data: { id: 'one', updated: true } });
  assert.equal((await fresh).data.updated, true);
});

test('different accounts, resources and clients never share a request', async () => {
  let calls = 0;
  const client = { get: async () => { calls += 1; return {}; } };
  const otherClient = { get: client.get };
  await Promise.all([
    deduplicatedGet(client, '/session?id=one', { headers: { Authorization: 'owner' } }),
    deduplicatedGet(client, '/session?id=one', { headers: { Authorization: 'other' } }),
    deduplicatedGet(client, '/session?id=two', { headers: { Authorization: 'owner' } }),
    deduplicatedGet(otherClient, '/session?id=one', { headers: { Authorization: 'owner' } }),
  ]);
  assert.equal(calls, 4);
});

test('failed requests are evicted so retry works without retaining private data', async () => {
  let calls = 0;
  const client = { get: async () => { calls += 1; if (calls === 1) throw new Error('temporary failure'); return { data: 'recovered' }; } };
  const first = deduplicatedGet(client, '/session');
  const second = deduplicatedGet(client, '/session');
  assert.equal(first, second);
  await assert.rejects(first, /temporary failure/);
  assert.equal((await deduplicatedGet(client, '/session')).data, 'recovered');
  assert.equal(calls, 2);
});
