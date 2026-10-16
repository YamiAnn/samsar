import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

// Router imports construct service clients. Use isolated test credentials and never
// connect to a real database or payment/provider service.
const TEST_SECRET = 'credit-grant-regression-test-secret-32-bytes';
process.env.SAMSAR_PROCESSOR_ENV_FILE = '/dev/null';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.TOKEN_SECRET = TEST_SECRET;
process.env.APP_KEY_HASH_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_credit_grant_regression';
process.env.OPENAI_API_KEY = 'sk-test-credit-grant-regression';
process.env.MONGO_URL = 'mongodb://127.0.0.1:1/credit-grant-regression';

const [
  { default: externalRouter },
  { default: v2Router },
  { assertCanGrantExternalUserCredits, grantExternalUserCredits },
  { default: User },
  { default: ExternalUser },
  { default: CustomerSubAccount },
  { default: AppKey },
  { default: GenerationCreditTransaction },
  { default: ExternalUserGenerationCreditTransaction },
] = await Promise.all([
  import('./external_users.js'),
  import('./v2.js'),
  import('../../models/external/User.js'),
  import('../../schema/User.js'),
  import('../../schema/ExternalUser.js'),
  import('../../schema/CustomerSubAccount.js'),
  import('../../schema/AppKey.js'),
  import('../../schema/GenerationCreditTransaction.js'),
  import('../../schema/ExternalUserGenerationCreditTransaction.js'),
]);

const ids = {
  parent: '507f191e810c19729de860ea',
  admin: '507f191e810c19729de860eb',
  otherParent: '507f191e810c19729de860ec',
  external: '507f191e810c19729de860ed',
  adminExternal: '507f191e810c19729de860ee',
  subAccount: '507f191e810c19729de860ef',
};
const credentials = {
  parentApiKey: 'samsar_credit_grant_parent_test_key',
  adminApiKey: 'samsar_credit_grant_admin_test_key',
  externalApiKey: 'external_credit_grant_test_key',
  adminExternalApiKey: 'external_credit_grant_admin_test_key',
  subAccountApiKey: 'scsa_credit_grant_test_key',
  appKey: 'sapp_credit_grant_test_key',
  appSecret: 'credit-grant-test-app-secret-at-least-32-bytes',
};
const appSecretHash = await bcrypt.hash(credentials.appSecret, 4);
const userToken = (userId, claims = {}) => jwt.sign({ _id: userId, ...claims }, TEST_SECRET);
const tokens = {
  parent: userToken(ids.parent),
  admin: userToken(ids.admin),
  external: userToken(ids.parent, { type: 'external_auth', externalUserId: ids.external }),
  adminExternal: userToken(ids.admin, { type: 'external_auth', externalUserId: ids.adminExternal }),
};
const bearer = (credential) => ({ authorization: `Bearer ${credential}` });
const targetIdentity = (externalUserId = 'member-admin') => ({
  provider: 'test',
  external_user_id: externalUserId,
});

function queryResult(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function installPersistence(t) {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousReadyState; });
  t.mock.method(mongoose, 'connect', async () => {
    assert.fail('Credit security tests must not open a database connection.');
  });

  const users = new Map([
    [ids.parent, { _id: ids.parent, isAdminUser: false, generationCredits: 100,
      userApiKeys: [{ apiKey: credentials.parentApiKey }] }],
    [ids.admin, { _id: ids.admin, isAdminUser: true, generationCredits: 200,
      userApiKeys: [{ apiKey: credentials.adminApiKey }] }],
    [ids.otherParent, { _id: ids.otherParent, isAdminUser: false, generationCredits: 300 }],
  ]);
  const externalUsers = new Map([
    [ids.external, { _id: ids.external, internalUserId: ids.parent, provider: 'test',
      externalUserId: 'member-parent', externalIdentityKey: 'test:default:member-parent',
      externalApiKey: credentials.externalApiKey, generationCredits: 10 }],
    [ids.adminExternal, { _id: ids.adminExternal, internalUserId: ids.admin, provider: 'test',
      externalUserId: 'member-admin', externalIdentityKey: 'test:default:member-admin',
      externalApiKey: credentials.adminExternalApiKey, generationCredits: 20 }],
  ]);
  const subAccount = {
    _id: ids.subAccount,
    // The owning parent's admin flag must not elevate a delegated key.
    internalUserId: ids.admin,
    internalApiKey: credentials.subAccountApiKey,
    status: 'active',
    generationCredits: 5,
  };
  const balancesBefore = () => ({
    users: [...users.values()].map(({ _id, generationCredits }) => ({ _id, generationCredits })),
    externalUsers: [...externalUsers.values()].map(({ _id, generationCredits }) => ({ _id, generationCredits })),
    subAccountCredits: subAccount.generationCredits,
  });
  const originalBalances = balancesBefore();
  const balanceWrites = [];
  const internalLedger = [];
  const externalLedger = [];

  function applyUpdate(collection, record, update) {
    if (Object.hasOwn(update.$inc ?? {}, 'generationCredits') ||
        Object.hasOwn(update.$set ?? {}, 'generationCredits')) {
      balanceWrites.push({ collection, id: record?._id, update });
    }
    if (!record) return null;
    Object.assign(record, update.$set ?? {});
    for (const [key, amount] of Object.entries(update.$inc ?? {})) {
      record[key] = (record[key] ?? 0) + amount;
    }
    return record;
  }

  t.mock.method(User, 'findOne', (filter) => queryResult(
    filter._id
      ? users.get(String(filter._id)) ?? null
      : [...users.values()].find((user) => user.userApiKeys?.some(
        (key) => key.apiKey === filter['userApiKeys.apiKey'],
      )) ?? null,
  ));
  t.mock.method(User, 'findById', (id) => queryResult(users.get(String(id)) ?? null));
  t.mock.method(User, 'findOneAndUpdate', async (filter, update) =>
    applyUpdate('User', users.get(String(filter._id)), update));
  t.mock.method(User, 'updateOne', async (filter, update) => {
    applyUpdate('User', users.get(String(filter._id)), update);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(ExternalUser, 'findOne', (filter) => queryResult(
    [...externalUsers.values()].find((record) =>
      Object.entries(filter).every(([key, value]) => String(record[key]) === String(value))) ?? null,
  ));
  const targetUpsert = t.mock.method(ExternalUser, 'findOneAndUpdate', async (filter, update) => {
    const record = [...externalUsers.values()].find(
      (entry) => entry.externalIdentityKey === filter.externalIdentityKey,
    );
    assert.ok(record, 'The fixture must contain the requested external identity.');
    return applyUpdate('ExternalUser', record, update);
  });
  t.mock.method(ExternalUser, 'findByIdAndUpdate', async (id, update) =>
    applyUpdate('ExternalUser', externalUsers.get(String(id)), update));
  t.mock.method(ExternalUser, 'updateOne', async (filter, update) => {
    applyUpdate('ExternalUser', externalUsers.get(String(filter._id)), update);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CustomerSubAccount, 'findOne', (filter) => queryResult(
    filter.internalApiKey === subAccount.internalApiKey ? subAccount : null,
  ));
  t.mock.method(CustomerSubAccount, 'findOneAndUpdate', async (filter, update) =>
    applyUpdate('CustomerSubAccount', subAccount, update));
  t.mock.method(CustomerSubAccount, 'updateOne', async (filter, update) => {
    applyUpdate('CustomerSubAccount', subAccount, update);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(AppKey, 'findOne', (filter) => queryResult(
    filter.appKeyHash === createHmac('sha256', TEST_SECRET).update(credentials.appKey).digest('hex')
      ? { userId: ids.admin, appKeyId: 'appkey_test', status: 'active',
        appSecretHash, expiresAt: new Date(Date.now() + 60_000), save: async () => {} }
      : null,
  ));
  t.mock.method(GenerationCreditTransaction.prototype, 'save', async function save() {
    internalLedger.push(this.toObject());
    return this;
  });
  t.mock.method(ExternalUserGenerationCreditTransaction.prototype, 'save', async function save() {
    externalLedger.push(this.toObject());
    return this;
  });

  return {
    users, externalUsers, subAccount, balanceWrites, internalLedger, externalLedger, targetUpsert,
    assertNoCreditChanges() {
      assert.deepEqual(balanceWrites, [], 'A rejected grant must not write any balance.');
      assert.deepEqual(balancesBefore(), originalBalances);
      assert.deepEqual(internalLedger, []);
      assert.deepEqual(externalLedger, []);
      assert.equal(targetUpsert.mock.callCount(), 0, 'Reject before upserting a grant target.');
    },
  };
}

function postGrant(router, prefix, headers, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Credit grant route did not respond.')), 5_000);
    const req = {
      method: 'POST', url: '/credits/grant', originalUrl: `${prefix}/credits/grant`,
      baseUrl: prefix, headers, body, query: {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      json(payload) { clearTimeout(timer); resolve({ status: this.statusCode, headers: this.headers, payload }); return this; },
    };
    router.handle(req, res, (error) => {
      clearTimeout(timer);
      reject(error || new Error('Credit grant request fell through the router.'));
    });
  });
}

const surfaces = [
  ['v1 external users', externalRouter, '/v1/external_users'],
  ['v2', v2Router, '/v2'],
];

for (const [surface, router, prefix] of surfaces) {
  test(`${surface}: delegated and ordinary credentials cannot mint external or parent credits`, async (t) => {
    const cases = [
      ['external JWT for its own balance', bearer(tokens.external), { input: { credits: 25 } }],
      ['external JWT requesting its parent', bearer(tokens.external), {
        external_user: { provider: 'samsar_internal', external_user_id: ids.parent }, input: { credits: 25 },
      }],
      ['external JWT owned by an administrator', bearer(tokens.adminExternal)],
      ['parent API key and body identity', bearer(credentials.parentApiKey)],
      ['parent API key and external key header', {
        ...bearer(credentials.parentApiKey), 'x-external-user-api-key': credentials.externalApiKey,
      }],
      ['administrator API key', bearer(credentials.adminApiKey)],
      ['sub-account bearer key', bearer(credentials.subAccountApiKey)],
      ['APP_KEY', { authorization: `AppKey ${credentials.appKey}`, 'x-app-secret': credentials.appSecret }],
      ['ordinary parent JWT', bearer(tokens.parent)],
      ['admin JWT mixed with sub-account key', {
        ...bearer(tokens.admin), 'x-customer-sub-account-api-key': credentials.subAccountApiKey,
      }],
      ['admin JWT mixed with APP_KEY', {
        ...bearer(tokens.admin), 'x-app-key': credentials.appKey, 'x-app-secret': credentials.appSecret,
      }],
      ['admin JWT mixed with external-user key', {
        ...bearer(tokens.admin), 'x-external-user-api-key': credentials.adminExternalApiKey,
      }],
    ];
    for (const [name, headers, body] of cases) {
      await t.test(name, async (st) => {
        const persistence = installPersistence(st);
        const response = await postGrant(router, prefix, headers, body ?? {
          external_user: targetIdentity(), input: { credits: 25 },
        });
        assert.equal(response.status, 403, response.payload.message);
        assert.match(response.payload.message, /signed-in administrator auth token/);
        persistence.assertNoCreditChanges();
      });
    }
  });

  test(`${surface}: a signed-in persisted administrator can grant its own external user`, async (t) => {
    const persistence = installPersistence(t);
    const response = await postGrant(router, prefix, bearer(tokens.admin), {
      external_user: targetIdentity(), input: { credits: 25 },
    });
    assert.equal(response.status, 200, response.payload.message);
    assert.equal(response.payload.creditsGranted, 25);
    assert.equal(response.payload.remainingCredits, 45);
    assert.equal(response.headers['x-credits-remaining'], '45');
    assert.equal(persistence.users.get(ids.admin).generationCredits, 225);
    assert.equal(persistence.users.get(ids.parent).generationCredits, 100);
    assert.equal(persistence.externalUsers.get(ids.adminExternal).generationCredits, 45);
    assert.equal(persistence.externalUsers.get(ids.external).generationCredits, 10);
    assert.equal(persistence.balanceWrites.length, 2);
    assert.equal(persistence.internalLedger.length, 1);
    assert.equal(persistence.externalLedger.length, 1);
    for (const transaction of [...persistence.internalLedger, ...persistence.externalLedger]) {
      assert.equal(transaction.amount, 25);
      assert.equal(transaction.direction, 'credit');
      assert.equal(transaction.source, 'manual_grant');
      assert.equal(transaction.metadata.grantedByUserId, ids.admin);
    }
  });

  test(`${surface}: manual grant amounts must be positive safe integers`, async (t) => {
    for (const credits of [0, -1, 0.5, '1.5', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await t.test(String(credits), async (st) => {
        const persistence = installPersistence(st);
        const response = await postGrant(router, prefix, bearer(tokens.admin), {
          external_user: targetIdentity(), input: { credits },
        });
        assert.equal(response.status, 400, response.payload.message);
        assert.match(response.payload.message, /positive safe integer/);
        persistence.assertNoCreditChanges();
      });
    }
  });
}

test('the model independently enforces administrator identity, delegation and target ownership', async (t) => {
  const adminContext = { authType: 'auth_token', internalUserId: ids.admin };
  const cases = [
    ['missing authorization context', undefined],
    ['empty authorization context', {}],
    ['auth token without actor', { authType: 'auth_token' }],
    ['administrator API key', { authType: 'api_key', internalUserId: ids.admin }],
    ['administrator APP_KEY', { authType: 'app_key', internalUserId: ids.admin }],
    ['sub-account key of administrator', { authType: 'customer_sub_account_api_key', internalUserId: ids.admin }],
    ['external token of administrator', { authType: 'external_auth', internalUserId: ids.admin }],
    ['ordinary user cannot assert admin in context', { authType: 'auth_token', internalUserId: ids.parent, isAdminUser: true }],
    ['missing persisted actor', { authType: 'auth_token', internalUserId: '507f191e810c19729de860ff' }],
    ['administrator scoped to an external user', { ...adminContext, externalUser: { _id: ids.adminExternal } }],
    ['administrator scoped to a customer sub-account', { ...adminContext, customerSubAccount: { _id: ids.subAccount } }],
    ['different parent account argument', adminContext, { internalUserId: ids.parent }],
    ['external target owned by another parent', adminContext, { targetParent: ids.otherParent }],
    ['missing external target owner', adminContext, { targetParent: null }],
    ['truthy persisted admin flag is insufficient', adminContext, { persistedAdmin: 'true' }],
    ['purchase source cannot bypass manual grant authorization', undefined, { source: 'purchase' }],
  ];
  for (const [name, authContext, options = {}] of cases) {
    await t.test(name, async (st) => {
      const persistence = installPersistence(st);
      if (Object.hasOwn(options, 'persistedAdmin')) {
        persistence.users.get(ids.admin).isAdminUser = options.persistedAdmin;
      }
      const externalUser = { ...persistence.externalUsers.get(ids.adminExternal) };
      if (Object.hasOwn(options, 'targetParent')) externalUser.internalUserId = options.targetParent;
      await assert.rejects(grantExternalUserCredits({
        internalUserId: options.internalUserId ?? ids.admin,
        authContext, externalUser, credits: 25, source: options.source ?? 'manual_grant',
      }), (error) => error.status === 403 && error.code === 'CREDIT_GRANT_FORBIDDEN');
      persistence.assertNoCreditChanges();
    });
  }
});

test('model grants reject invalid amounts even when route validation is bypassed', async (t) => {
  for (const credits of [undefined, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(credits), async (st) => {
      const persistence = installPersistence(st);
      await assert.rejects(grantExternalUserCredits({
        internalUserId: ids.admin,
        authContext: { authType: 'auth_token', internalUserId: ids.admin },
        externalUser: persistence.externalUsers.get(ids.adminExternal), credits,
      }), (error) => error.status === 400 && /positive safe integer/.test(error.message));
      persistence.assertNoCreditChanges();
    });
  }
});

test('grant authorization uses the persisted admin flag rather than token claims', async (t) => {
  installPersistence(t);
  await assert.rejects(assertCanGrantExternalUserCredits({
    authType: 'auth_token', internalUserId: ids.parent, isAdminUser: true,
  }), (error) => error.status === 403);
  assert.equal(await assertCanGrantExternalUserCredits({
    authType: 'auth_token', internalUserId: ids.admin,
  }), ids.admin);
});
