import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

const TEST_SECRET = 'billing-mode-regression-test-secret-at-least-32-bytes';
process.env.SAMSAR_PROCESSOR_ENV_FILE = '/dev/null';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.TOKEN_SECRET = TEST_SECRET;
process.env.APP_KEY_HASH_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_billing_mode_regression';
process.env.OPENAI_API_KEY = 'sk-test-billing-mode-regression';
process.env.MONGO_URL = 'mongodb://127.0.0.1:1/billing-mode-regression';

const [
  { upsertExternalUser, reserveExternalRequestCredits, refundExternalRequestCredits },
  { default: User },
  { default: ExternalUser },
  { default: ExternalUserRequest },
  { default: CustomerSubAccount },
  { default: GenerationCreditTransaction },
  { default: ExternalUserGenerationCreditTransaction },
] = await Promise.all([
  import('./User.js'),
  import('../../schema/User.js'),
  import('../../schema/ExternalUser.js'),
  import('../../schema/ExternalUserRequest.js'),
  import('../../schema/CustomerSubAccount.js'),
  import('../../schema/GenerationCreditTransaction.js'),
  import('../../schema/ExternalUserGenerationCreditTransaction.js'),
]);

const ids = {
  parent: '507f191e810c19729de860ea',
  external: '507f191e810c19729de860eb',
  request: '507f191e810c19729de860ec',
  subAccount: '507f191e810c19729de860ed',
};

function applyUpdate(document, update, { inserting = false } = {}) {
  if (inserting) Object.assign(document, update.$setOnInsert || {});
  Object.assign(document, update.$set || {});
  for (const [field, amount] of Object.entries(update.$inc || {})) {
    document[field] = (Number(document[field]) || 0) + amount;
  }
  return structuredClone(document);
}

function mockBillingState(t, externalFields = {}, { insert = false } = {}) {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousReadyState; });
  const state = {
    parent: { _id: ids.parent, generationCredits: 100, autoRechargeEnabled: false },
    external: insert ? null : {
      _id: ids.external,
      internalUserId: ids.parent,
      provider: 'partner',
      externalUserId: 'customer',
      externalIdentityKey: 'partner:default:customer',
      generationCredits: 100,
      userType: null,
      metadata: {},
      ...externalFields,
    },
    subAccount: { _id: ids.subAccount, generationCredits: 50 },
    request: {
      _id: ids.request,
      externalRequestId: 'extreq_billing_mode',
      externalUserId: ids.external,
      creditsCharged: 0,
      routeKey: 'add_outro_image',
    },
    parentTransactions: [],
  };
  t.mock.method(User, 'findById', async () => structuredClone(state.parent));
  t.mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    if (filter.generationCredits && state.parent.generationCredits < filter.generationCredits.$gte) return null;
    return applyUpdate(state.parent, update);
  });
  t.mock.method(GenerationCreditTransaction.prototype, 'save', async function save() {
    state.parentTransactions.push({ direction: this.direction, amount: this.amount });
    return this;
  });
  t.mock.method(ExternalUserGenerationCreditTransaction.prototype, 'save', async function save() { return this; });
  t.mock.method(ExternalUser, 'findById', async () => structuredClone(state.external));
  t.mock.method(ExternalUser, 'findByIdAndUpdate', async (_id, update) => applyUpdate(state.external, update));
  t.mock.method(ExternalUser, 'findOneAndUpdate', async (filter, update, options) => {
    const inserting = !state.external;
    if (inserting) {
      assert.equal(options.upsert, true);
      state.external = { _id: ids.external, generationCredits: 0 };
    }
    if (filter.generationCredits && state.external.generationCredits < filter.generationCredits.$gte) return null;
    return applyUpdate(state.external, update, { inserting });
  });
  t.mock.method(ExternalUserRequest, 'findOne', async () => structuredClone(state.request));
  t.mock.method(ExternalUserRequest, 'findByIdAndUpdate', async (_id, update) => applyUpdate(state.request, update));
  t.mock.method(CustomerSubAccount, 'findById', async () => structuredClone(state.subAccount));
  t.mock.method(CustomerSubAccount, 'findOneAndUpdate', async (filter, update) => {
    if (filter.generationCredits && state.subAccount.generationCredits < filter.generationCredits.$gte) return null;
    return applyUpdate(state.subAccount, update);
  });
  t.mock.method(CustomerSubAccount, 'findByIdAndUpdate', async (_id, update) => applyUpdate(state.subAccount, update));
  return state;
}

const reserve = () => reserveExternalRequestCredits({
  externalRequestId: 'extreq_billing_mode', creditsToReserve: 20,
});
const refund = () => refundExternalRequestCredits({
  externalRequestId: 'extreq_billing_mode', creditsToRefund: 20,
});
const updateProfile = (state, fields) => upsertExternalUser({
  internalUserId: ids.parent,
  externalUserPayload: {
    provider: state.external?.provider || 'partner',
    external_user_id: 'customer',
    ...fields,
  },
});

for (const billingMode of ['internal', 'customer_sub_account']) {
  test(`profile billingMode ${billingMode} cannot redirect an external refund to the parent`, async (t) => {
    const state = mockBillingState(t);
    await reserve();
    assert.equal(state.external.generationCredits, 80);
    assert.equal(state.parent.generationCredits, 100);
    await updateProfile(state, { metadata: { billingMode } });
    await refund();
    assert.equal(state.external.generationCredits, 100);
    assert.equal(state.parent.generationCredits, 100);
    assert.deepEqual(state.parentTransactions, []);
  });
}

test('user_type cannot convert an existing external debit into a parent refund', async (t) => {
  const state = mockBillingState(t);
  await reserve();
  await updateProfile(state, { user_type: 'internal_user' });
  await refund();
  assert.equal(state.external.userType, null);
  assert.equal(state.external.generationCredits, 100);
  assert.equal(state.parent.generationCredits, 100);
  assert.deepEqual(state.parentTransactions, []);
});

test('initial internal user type keeps parent debit and refund routing when a profile tries to clear it', async (t) => {
  const state = mockBillingState(t, {}, { insert: true });
  await updateProfile(state, { user_type: 'internal_user' });
  await reserve();
  assert.equal(state.parent.generationCredits, 80);
  await updateProfile(state, { user_type: 'external_user', metadata: {} });
  await refund();
  assert.equal(state.external.userType, 'internal_user');
  assert.equal(state.parent.generationCredits, 100);
  assert.deepEqual(state.parentTransactions, [
    { direction: 'debit', amount: 20 }, { direction: 'credit', amount: 20 },
  ]);
});

test('mapped Samsar identities retain parent billing independently of profile metadata', async (t) => {
  const state = mockBillingState(t, {
    provider: 'samsar_internal',
    externalIdentityKey: 'samsar_internal:default:customer',
  });
  await reserve();
  assert.equal(state.parent.generationCredits, 80);
  await updateProfile(state, { metadata: { billingMode: 'external' } });
  await refund();
  assert.equal(state.parent.generationCredits, 100);
  assert.deepEqual(state.parentTransactions, [
    { direction: 'debit', amount: 20 }, { direction: 'credit', amount: 20 },
  ]);
});

test('customer sub-account identities keep both parent and allocation billing after profile changes', async (t) => {
  const state = mockBillingState(t, {
    customerSubAccountId: ids.subAccount,
    customerSubAccountPublicId: 'customer_sub_account_test',
    generationCredits: 50,
  });
  await reserve();
  assert.equal(state.parent.generationCredits, 80);
  assert.equal(state.subAccount.generationCredits, 30);
  await updateProfile(state, { user_type: 'external_user', metadata: { billingMode: 'external' } });
  await refund();
  assert.equal(state.parent.generationCredits, 100);
  assert.equal(state.subAccount.generationCredits, 50);
  assert.deepEqual(state.parentTransactions, [
    { direction: 'debit', amount: 20 }, { direction: 'credit', amount: 20 },
  ]);
});

test('metadata-only legacy records cannot spend parent credits without a structural billing identity', async (t) => {
  const state = mockBillingState(t, { generationCredits: 0, metadata: { billingMode: 'internal' } });
  await assert.rejects(reserve(), (error) => error.code === 'INSUFFICIENT_CREDITS');
  assert.equal(state.parent.generationCredits, 100);
  assert.deepEqual(state.parentTransactions, []);
});
