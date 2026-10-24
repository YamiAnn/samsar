import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageAdapterTariffSnapshot } from './ImageAdapterTariffs.js';
import { calculateImageCallCredits } from './ImagePricing.js';
import { billCompletedImage } from './ImageRequestBilling.js';
import { resolveImageAdapterReceipt } from './ImageAdapterReceipt.js';
import { sealImageAdapterSubmission } from './ImageAdapterSubmission.js';

const env = { SAMSAR_DEPLOYMENT_EDITION: 'production' };
const completeUsage = { promptTokenCount: 1000, cachedContentTokenCount: 200,
  candidatesTokenCount: 1200, thoughtsTokenCount: 100,
  candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }, { modality: 'TEXT', tokenCount: 80 }] };

function fixture(model, providerReceipt) {
  let saved;
  const debits = [];
  const snapshot = createImageAdapterTariffSnapshot({ submittedAdapter: 'gmicloud', model });
  return { snapshot, debits, saved: () => saved,
    payload: { _id: 'nano-call', userId: 'owner', submittedAdapter: 'gmicloud', model,
      imageBillingPolicy: 'adapter', apiRequestId: 'genblaze-image:provider', imageAdapterTariffSnapshot: snapshot },
    result: { image: 'retained.png', imageBillingReceipt: {
      adapter: 'gmicloud', model, providerRequestId: 'provider', ...providerReceipt } },
    dependencies: { env, store: {
      async ensure(id, fields) { return saved ||= { _id: id, ...fields }; },
      async saveBilling(id, billing) { saved.billing = billing; return saved; },
      async complete(id, fields) { Object.assign(saved, fields, { status: 'COMPLETED' }); return saved; },
    }, charge: async (...args) => { debits.push(args); return { remainingCredits: 85 }; } },
  };
}

for (const model of ['NANOBANANA2', 'NANOBANANA2EDIT']) {
  test(`F2P: ${model} retains a normal reported charge when token usage is unavailable`, async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('unexpected pricing/result HTTP request'); };
    try {
      for (const usage of [undefined, { promptTokenCount: 1000 },
        { ...completeUsage, candidatesTokensDetails: undefined }]) {
        const f = fixture(model, { costUsd: 0.125, usage });
        await billCompletedImage(f.payload, f.result, f.dependencies);
        assert.equal(f.snapshot.version, 2);
        await billCompletedImage(f.payload, f.result, f.dependencies);
        assert.equal(f.saved().status, 'COMPLETED');
        assert.equal(f.saved().billing.costUsd, 0.125);
        assert.equal(f.saved().billing.credits, 15);
        assert.equal(f.saved().billing.costSource, 'adapter_reported_unverified_usage');
        assert.equal(f.saved().billing.pricingException, 'GMI_NANO2_TOKEN_USAGE_UNAVAILABLE');
        assert.equal(f.debits.length, 1);
      }
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
}

test('GMI Nano2 valid reported zero remains a successful zero debit when usage is unavailable', async () => {
  const f = fixture('NANOBANANA2', { costUsd: 0 });
  await billCompletedImage(f.payload, f.result, f.dependencies);
  assert.equal(f.saved().status, 'COMPLETED');
  assert.equal(f.saved().billing.credits, 0);
  assert.equal(f.debits.length, 0);
});

test('GMI Nano2 missing complete usage and valid charge retains its image pending settlement', async () => {
  for (const costUsd of [undefined, null, '', 'invalid', -1, Infinity]) {
    const f = fixture('NANOBANANA2', costUsd === undefined ? {} : { costUsd });
    await assert.rejects(billCompletedImage(f.payload, f.result, f.dependencies),
      { code: 'IMAGE_BILLING_PENDING' });
    assert.equal(f.saved().status, 'PENDING');
    assert.equal(f.saved().result.image, 'retained.png');
    assert.equal(f.debits.length, 0);
  }
});

test('GMI Nano2 complete usage keeps fixed tariffs authoritative over reported money', async () => {
  const f = fixture('NANOBANANA2', { costUsd: 999, usage: completeUsage });
  await billCompletedImage(f.payload, f.result, f.dependencies);
  assert.equal(f.saved().billing.credits, 8.1888);
  assert.equal(f.saved().billing.costSource, 'static_tariff');
  assert.equal(f.saved().billing.pricingException, undefined);
});

test('historical GMI Nano2 v1 snapshots retain their prior strict usage requirement and seal', async () => {
  const snapshot = { ...createImageAdapterTariffSnapshot({ submittedAdapter: 'gmicloud', model: 'NANOBANANA2' }), version: 1 };
  assert.throws(() => calculateImageCallCredits({ adapter: 'gmicloud', model: 'NANOBANANA2',
    imageAdapterTariffSnapshot: snapshot, costUsd: 0.125 }), /input tokens/);
  assert.equal(await sealImageAdapterSubmission({ _id: 'old', submittedAdapter: 'gmicloud', model: 'NANOBANANA2',
    imageBillingPolicy: 'adapter', imageAdapterTariffSnapshot: snapshot }, {
    env, imageGenerationModel: { updateOne() { throw new Error('must not replace historical seal'); } },
  }), snapshot);
  const receipt = await resolveImageAdapterReceipt({ adapter: 'gmicloud', model: 'NANOBANANA2',
    costUsd: 999, usage: completeUsage }, { imageAdapterTariffSnapshot: snapshot });
  assert.equal(calculateImageCallCredits(receipt).credits, 8.1888);
});
