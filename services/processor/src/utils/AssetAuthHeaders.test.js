import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAssetAuthHeaders } from './AssetAuthHeaders.js';

test('media requests use the existing browser login without mutating request headers', () => {
  const headers = { cookie: 'theme=dark; authToken=owner%2Etoken; consent=accepted' };
  assert.equal(resolveAssetAuthHeaders(headers).authorization, 'Bearer owner.token');
  assert.equal(headers.authorization, undefined);
  assert.equal(resolveAssetAuthHeaders({ Cookie: 'samsarHostAuthToken=local.token' }).authorization, 'Bearer local.token');
});

test('explicit account credentials always take precedence over a login cookie', () => {
  for (const name of ['authorization', 'Authorization', 'api_key', 'APP_KEY', 'x-customer-sub-account-api-key', 'x-external-user-api-key']) {
    const headers = { [name]: 'explicit-credential', cookie: 'authToken=another.account' };
    assert.equal(resolveAssetAuthHeaders(headers), headers);
  }
});

test('missing, malformed and ambiguous cookies fail closed', () => {
  for (const cookie of [undefined, '', 'theme=dark', 'authToken=', 'authToken=%zz', 'authToken=one; authToken=two', 'authToken=bad%0Atoken']) {
    const headers = { cookie };
    assert.equal(resolveAssetAuthHeaders(headers), headers);
  }
});
