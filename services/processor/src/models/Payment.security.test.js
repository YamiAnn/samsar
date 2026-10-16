import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import Stripe from 'stripe';

// Service clients must use synthetic configuration without loading local secrets.
const TEST_SECRET = 'checkout-metadata-security-regression-secret-32-bytes';
process.env.SAMSAR_PROCESSOR_ENV_FILE = '/dev/null';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.TOKEN_SECRET = TEST_SECRET;
process.env.APP_KEY_HASH_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_metadata_security';
process.env.OPENAI_API_KEY = 'sk-test-checkout-metadata-security';
process.env.MONGO_URL = 'mongodb://127.0.0.1:1/checkout_metadata_security';
process.env.SAMSAR_CREDITS_PER_DOLLAR = '100';
const { default: User } = await import('../schema/User.js');
const {
  createAnonymousCreditCheckoutSession,
  getPaidCheckoutCredits,
  purchaseCreditsForUser,
} = await import('./Payment.js');

function captureCheckout(t) {
  const stripe = new Stripe('sk_test_checkout_metadata_security');
  let checkout;
  t.mock.method(Object.getPrototypeOf(stripe.checkout.sessions), 'create', async (payload) => {
    checkout = payload;
    return { id: 'cs_test_security', url: 'https://checkout.stripe.com/test' };
  });
  return () => checkout;
}

function mockDatabaseConnection(t) {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousReadyState; });
}

function mockPurchasingUser(t) {
  mockDatabaseConnection(t);
  t.mock.method(User, 'findById', async () => ({
    _id: 'parent-account',
    stripeCustomerId: 'cus_parent',
  }));
  t.mock.method(User, 'updateOne', async () => ({ matchedCount: 1 }));
  const stripe = new Stripe('sk_test_checkout_metadata_security');
  t.mock.method(Object.getPrototypeOf(stripe.customers), 'retrieve', async () => ({
    id: 'cus_parent',
  }));
}

test('anonymous checkout fixes paid credits and fulfillment identity despite malicious metadata', async (t) => {
  const previousRate = process.env.SAMSAR_CREDITS_PER_DOLLAR;
  process.env.SAMSAR_CREDITS_PER_DOLLAR = '100';
  t.after(() => {
    if (previousRate === undefined) delete process.env.SAMSAR_CREDITS_PER_DOLLAR;
    else process.env.SAMSAR_CREDITS_PER_DOLLAR = previousRate;
  });
  const getCheckout = captureCheckout(t);
  const result = await createAnonymousCreditCheckoutSession({
    amountCents: 100,
    metadata: {
      creditsRequested: '1000000000',
      intent: 'v2_user_recharge_credits',
      originalAmountCents: '1000000000',
      customerEmail: 'victim@example.com',
      userId: 'victim-parent',
      internalUserId: 'victim-parent',
      stripeCustomerId: 'cus_victim',
      billingScope: 'external_user',
      externalIdentityKey: 'victim-identity',
      externalUserId: 'victim-sub-account',
      externalUserExternalId: 'victim-external-user',
      customerSubAccountId: 'victim-customer',
      redirectUrl: 'https://attacker.example/callback',
    },
  });

  const checkout = getCheckout();
  assert.equal(checkout.line_items[0].price_data.unit_amount, 100);
  assert.equal(result.credits, 100);
  assert.equal(checkout.metadata.creditsRequested, '100');
  assert.equal(checkout.metadata.originalAmountCents, '100');
  assert.equal(checkout.metadata.intent, 'anonymous_credit_purchase');
  for (const field of [
    'customerEmail', 'userId', 'internalUserId', 'stripeCustomerId', 'billingScope',
    'externalIdentityKey', 'externalUserId', 'externalUserExternalId', 'customerSubAccountId', 'redirectUrl',
  ]) {
    assert.equal(Object.hasOwn(checkout.metadata, field), false, field);
  }
  assert.deepEqual(checkout.payment_intent_data.metadata, checkout.metadata);
});

test('anonymous checkout preserves harmless client metadata without accepting reserved aliases', async (t) => {
  const getCheckout = captureCheckout(t);
  await createAnonymousCreditCheckoutSession({
    amountCents: 500,
    metadata: {
      campaignId: 'autumn',
      referralCount: 3,
      optionalNote: null,
      sourceProject: 'forged-project',
      productSummary: 'Forged product',
      CREDITS_REQUESTED: '999999999',
      'billing-scope': 'external_user',
      external_user_id: 'victim',
    },
  });

  const metadata = getCheckout().metadata;
  assert.equal(metadata.campaignId, 'autumn');
  assert.equal(metadata.referralCount, '3');
  assert.equal(metadata.sourceProject, 'superreferrer');
  assert.match(metadata.productSummary, /^Purchase \d+ Samsar Processor credits$/);
  for (const field of ['optionalNote', 'CREDITS_REQUESTED', 'billing-scope', 'external_user_id']) {
    assert.equal(Object.hasOwn(metadata, field), false, field);
  }
});

test('signed-in checkout cannot choose a different fulfillment flow or credit amount through metadata', async (t) => {
  mockPurchasingUser(t);
  const getCheckout = captureCheckout(t);
  await purchaseCreditsForUser('parent-account', {
    amountCents: 100,
    metadata: {
      intent: 'anonymous_credit_purchase',
      creditsRequested: '1000000000',
      customerEmail: 'victim@example.com',
      externalUserId: 'victim-sub-account',
      billingScope: 'external_user',
      campaignId: 'autumn',
    },
  });

  const checkout = getCheckout();
  assert.equal(checkout.customer, 'cus_parent');
  assert.equal(checkout.line_items[0].price_data.unit_amount, 100);
  assert.equal(checkout.metadata.creditsRequested, '100');
  assert.equal(checkout.metadata.campaignId, 'autumn');
  for (const field of ['intent', 'customerEmail', 'externalUserId', 'billingScope']) {
    assert.equal(Object.hasOwn(checkout.metadata, field), false, field);
  }
});

test('server-supplied external billing metadata remains available for paid sub-account recharges', async (t) => {
  mockPurchasingUser(t);
  const getCheckout = captureCheckout(t);
  await purchaseCreditsForUser('parent-account', {
    amountCents: 100,
    metadata: { externalUserId: 'forged-sub-account' },
  }, {
    trustedMetadata: {
      billingScope: 'external_user',
      externalIdentityKey: 'parent:real-sub-account',
      externalUserId: 'real-sub-account',
      externalUserExternalId: 'real-external-user',
    },
  });

  assert.deepEqual(getCheckout().metadata, {
    billingScope: 'external_user',
    externalIdentityKey: 'parent:real-sub-account',
    externalUserId: 'real-sub-account',
    externalUserExternalId: 'real-external-user',
    productSummary: 'Purchase 100 credits',
    creditsRequested: '100',
  });
});

test('paid checkout credit totals ignore forged metadata from previously created sessions', () => {
  const paidSession = {
    mode: 'payment',
    payment_status: 'paid',
    currency: 'usd',
    amount_total: 100,
    metadata: { creditsRequested: '1000000000', originalAmountCents: '1000000000' },
  };

  assert.equal(getPaidCheckoutCredits(paidSession, {
    env: { SAMSAR_CREDITS_PER_DOLLAR: '250' },
  }), 100, 'legacy purchases retain one credit per cent');

  for (const intent of ['anonymous_credit_purchase', 'v2_user_recharge_credits']) {
    assert.equal(getPaidCheckoutCredits({
      ...paidSession,
      metadata: { ...paidSession.metadata, intent },
    }, {
      useConfiguredRate: true,
      env: { SAMSAR_CREDITS_PER_DOLLAR: '250' },
    }), 250, `${intent} uses the server credit rate and the Stripe amount paid`);
  }
});

test('paid checkout credit conversion keeps the default rate and purchase rounding', () => {
  const session = { mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 101 };
  for (const configuredRate of [undefined, '', 'invalid', '-1', 'Infinity', '0']) {
    assert.equal(getPaidCheckoutCredits(session, {
      useConfiguredRate: true,
      env: { SAMSAR_CREDITS_PER_DOLLAR: configuredRate },
    }), 101);
  }
  assert.equal(getPaidCheckoutCredits(session, {
    useConfiguredRate: true,
    env: { SAMSAR_CREDITS_PER_DOLLAR: '150' },
  }), 152);
});

test('unpaid, invalid, non-USD, and unsafe checkout amounts cannot produce credits', () => {
  const paidSession = { mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 100 };
  const invalidSessions = [
    null,
    {},
    ...['unpaid', 'no_payment_required', undefined].map((payment_status) => ({ ...paidSession, payment_status })),
    ...['subscription', 'setup', undefined].map((mode) => ({ ...paidSession, mode })),
    ...['eur', undefined, null].map((currency) => ({ ...paidSession, currency })),
    ...[0, -100, 1.5, '100', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map((amount_total) => ({ ...paidSession, amount_total })),
  ];
  for (const session of invalidSessions) {
    assert.equal(getPaidCheckoutCredits(session), 0);
    assert.equal(getPaidCheckoutCredits(session, { useConfiguredRate: true }), 0);
  }
  assert.equal(getPaidCheckoutCredits({ ...paidSession, amount_total: Number.MAX_SAFE_INTEGER }, {
    useConfiguredRate: true,
    env: { SAMSAR_CREDITS_PER_DOLLAR: '1000' },
  }), 0, 'credit conversion must also remain a safe integer');
});

test('one-time webhook acknowledges unpaid and invalid checkouts before account or credit mutations', async (t) => {
  const { default: webhookRouter } = await import('../routes/webhooks.js');
  mockDatabaseConnection(t);
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_checkout_metadata_security';
  t.after(() => {
    if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  });
  const userLookup = t.mock.method(User, 'findOne', async () => {
    throw new Error('Invalid payments must not resolve or modify an account.');
  });
  const userWrite = t.mock.method(User, 'findOneAndUpdate', async () => {
    throw new Error('Invalid payments must not issue credits.');
  });
  const webhookHandler = webhookRouter.stack
    .find((layer) => layer.route?.path === '/stripe_payment_webhook').route.stack[1].handle;

  for (const fields of [
    { payment_status: 'unpaid', currency: 'usd', amount_total: 100 },
    { payment_status: 'paid', currency: 'eur', amount_total: 100 },
    { payment_status: 'paid', currency: 'usd', amount_total: 1.5 },
    { payment_status: 'paid', currency: 'usd', amount_total: 0 },
  ]) {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_invalid',
        mode: 'payment',
        metadata: { intent: 'v2_user_recharge_credits', creditsRequested: '1000000000' },
        ...fields,
      } },
    });
    const response = {
      statusCode: null,
      body: null,
      status(statusCode) { this.statusCode = statusCode; return this; },
      send(body) { this.body = body; return this; },
    };
    await webhookHandler({
      body: Buffer.from(body),
      headers: { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: process.env.STRIPE_WEBHOOK_SECRET,
      }) },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'Success');
  }
  assert.equal(userLookup.mock.callCount(), 0);
  assert.equal(userWrite.mock.callCount(), 0);
});
