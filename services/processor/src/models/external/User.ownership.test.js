import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import ExternalUser from '../../schema/ExternalUser.js';

process.env.SAMSAR_PROCESSOR_ENV_FILE = '/dev/null';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.STRIPE_SECRET_KEY = 'sk_test_external_user_ownership';
process.env.OPENAI_API_KEY = 'sk-test-external-user-ownership';
process.env.MONGO_URL = 'mongodb://127.0.0.1:1/external-user-ownership';
const { upsertExternalUser } = await import('./User.js');

const identity = {
  provider: 'test',
  external_user_id: 'member',
  external_app_id: 'shared-app',
};
const subAccount = (id) => ({
  _id: id,
  customerSubAccountId: `public-${id}`,
  externalCustomerId: `customer-${id}`,
});
const storedUser = (overrides = {}) => ({
  _id: 'external-user',
  externalIdentityKey: 'test:shared-app:member',
  internalUserId: 'parent-a',
  provider: 'test',
  externalUserId: 'member',
  uniqueKey: 'member',
  externalAppId: 'shared-app',
  displayName: 'Original name',
  generationCredits: 75,
  totalCreditsPurchased: 100,
  ...overrides,
});

function installPersistence(t, initialUsers) {
  const users = structuredClone(initialUsers);
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousReadyState; });
  t.mock.method(mongoose, 'connect', async () => {
    assert.fail('Ownership regressions must never connect to a real database.');
  });
  t.mock.method(ExternalUser, 'findOneAndUpdate', async (filter, update, options) => {
    const existing = users.find((user) => Object.entries(filter).every(
      ([key, value]) => String(user[key]) === String(value),
    ));
    if (existing) {
      Object.assign(existing, update.$set ?? {});
      return existing;
    }
    if (!options.upsert) return null;

    const inserted = { ...filter, ...update.$setOnInsert, ...update.$set };
    if (users.some((user) => user.externalIdentityKey === inserted.externalIdentityKey ||
      user.uniqueKey === inserted.uniqueKey)) {
      const duplicate = new Error('Duplicate unique external identity');
      duplicate.code = 11000;
      throw duplicate;
    }
    const created = { _id: 'new-external-user', generationCredits: 0, ...inserted };
    users.push(created);
    return created;
  });
  return users;
}

test('an external identity cannot be moved to another parent or redirect its credits', async (t) => {
  const users = installPersistence(t, [storedUser()]);
  const original = structuredClone(users);
  await assert.rejects(upsertExternalUser({
    internalUserId: 'parent-b',
    externalUserPayload: { external_user: { ...identity, display_name: 'Attacker' } },
  }), (error) => error.status === 403 && error.code === 'EXTERNAL_USER_OWNERSHIP_CONFLICT');
  assert.deepEqual(users, original);
});

test('a delegated key cannot move an external identity between sibling sub-accounts', async (t) => {
  const users = installPersistence(t, [storedUser({
    customerSubAccountId: 'sub-a',
    customerSubAccountPublicId: 'public-sub-a',
    customerSubAccountExternalId: 'customer-sub-a',
  })]);
  const original = structuredClone(users);
  await assert.rejects(upsertExternalUser({
    internalUserId: 'parent-a',
    customerSubAccount: subAccount('sub-b'),
    externalUserPayload: { external_user: identity },
  }), (error) => error.status === 403 && error.code === 'EXTERNAL_USER_OWNERSHIP_CONFLICT');
  assert.deepEqual(users, original);
});

test('a delegated key cannot adopt a legacy or parent-owned identity without proven ownership', async (t) => {
  for (const ownership of [{}, { customerSubAccountId: null }]) {
    await t.test(JSON.stringify(ownership), async (st) => {
      const users = installPersistence(st, [storedUser(ownership)]);
      const original = structuredClone(users);
      await assert.rejects(upsertExternalUser({
        internalUserId: 'parent-a',
        customerSubAccount: subAccount('sub-a'),
        externalUserPayload: { external_user: identity },
      }), (error) => error.status === 403);
      assert.deepEqual(users, original);
    });
  }
});

test('the same parent can update legacy profiles without changing ownership or credits', async (t) => {
  const users = installPersistence(t, [storedUser({ customerSubAccountId: null })]);
  const updated = await upsertExternalUser({
    internalUserId: 'parent-a',
    externalUserPayload: { external_user: { ...identity, display_name: 'Updated name' } },
  });
  assert.equal(users.length, 1);
  assert.equal(updated.displayName, 'Updated name');
  assert.equal(updated.internalUserId, 'parent-a');
  assert.equal(updated.customerSubAccountId, null);
  assert.equal(updated.generationCredits, 75);
  assert.equal(updated.totalCreditsPurchased, 100);
});

test('the parent and owning delegated key preserve existing sub-account ownership and credits', async (t) => {
  const users = installPersistence(t, [storedUser({
    customerSubAccountId: 'sub-a',
    customerSubAccountPublicId: 'public-sub-a',
    customerSubAccountExternalId: 'customer-sub-a',
  })]);
  for (const delegatedOwner of [null, subAccount('sub-a')]) {
    const updated = await upsertExternalUser({
      internalUserId: 'parent-a',
      customerSubAccount: delegatedOwner,
      externalUserPayload: { external_user: { ...identity, display_name: 'Updated name' } },
    });
    assert.equal(updated.internalUserId, 'parent-a');
    assert.equal(updated.customerSubAccountId, 'sub-a');
    assert.equal(updated.customerSubAccountPublicId, 'public-sub-a');
    assert.equal(updated.customerSubAccountExternalId, 'customer-sub-a');
    assert.equal(updated.generationCredits, 75);
    assert.equal(updated.totalCreditsPurchased, 100);
  }
  assert.equal(users.length, 1);
});

test('new delegated external users receive their authenticated parent and sub-account ownership', async (t) => {
  installPersistence(t, []);
  const created = await upsertExternalUser({
    internalUserId: 'parent-a',
    customerSubAccount: subAccount('sub-a'),
    externalUserPayload: { external_user: identity },
  });
  assert.equal(created.internalUserId, 'parent-a');
  assert.equal(created.customerSubAccountId, 'sub-a');
  assert.equal(created.customerSubAccountPublicId, 'public-sub-a');
  assert.equal(created.customerSubAccountExternalId, 'customer-sub-a');
  assert.equal(created.generationCredits, 0);
});
