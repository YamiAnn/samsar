import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateImageCallCredits } from './ImagePricing.js';
import { resolveImageAdapterReceipt } from './ImageAdapterReceipt.js';
import { sealFalImageSubmission } from './FalImageSubmission.js';
import { calculateFalImageTariffCost, createFalImageTariffSnapshot } from './FalImageTariffs.js';

test('Fal per-image tariffs include verified style, speed, resolution, and output-count tiers', async () => {
  const cases = [
    [{ model: 'RECRAFTV3', imageStyle: 'vector_illustration/line_art' }, 0.08],
    [{ model: 'RECRAFT20B', imageStyle: 'vector_illustration' }, 0.0438],
    [{ model: 'IDEOGRAMV3' }, 0.06],
    [{ model: 'WAN2.7PRO' }, 0.075],
    [{ model: 'NANOBANANA2', resolution: '4K' }, 0.08], // Generation omits resolution.
    [{ model: 'NANOBANANA2EDIT', case_type: 'enhance_image', resolution: '2K' }, 0.12],
    [{ model: 'NANOBANANAPROEDIT', case_type: 'image_list_to_image_set', numImages: 3 }, 0.24],
  ];
  for (const [payload, expected] of cases) {
    const snapshot = createFalImageTariffSnapshot(payload);
    assert.equal(await calculateFalImageTariffCost(snapshot, { image: 'done.png' }), expected, payload.model);
  }
});

test('verified FLUX submit sizes seal one billable megapixel before dispatch', async () => {
  const snapshot = createFalImageTariffSnapshot({ model: 'FLUX1.1PRO', aspectRatio: '16:9' });
  assert.equal(snapshot.billableUnits, 1);
  assert.equal(await calculateFalImageTariffCost(snapshot), 0.04);
  const priced = await resolveImageAdapterReceipt({ adapter: 'fal', model: 'FLUX1.1PRO' },
    { falImageBillingSnapshot: snapshot });
  assert.equal(calculateImageCallCredits(priced).credits, 4.8);
});

test('unpriced endpoints and unverified megapixel rules fail before provider submission', async () => {
  for (const model of ['IMAGEN4', 'FLITE', 'SEEDREAM', 'GPTIMAGE2.5',
    'SANA', 'PHOTON', 'HUNYUAN', 'SDV3.5', 'FLUX1PROFILL',
    'FLUX1.1PROULTRAREDUX']) {
    assert.throws(() => createFalImageTariffSnapshot({ model }),
      { code: 'FAL_IMAGE_TARIFF_UNVERIFIED' }, model);
  }
  assert.throws(() => createFalImageTariffSnapshot({ model: 'NANOBANANA2EDIT',
    case_type: 'image_list_to_image_set', numImages: 0 }), /output count/);
  let writes = 0;
  const imageGenerationModel = { async updateOne() { writes++; return { matchedCount: 1 }; } };
  await assert.rejects(sealFalImageSubmission({ _id: 'new', model: 'SEEDREAM',
    submittedAdapter: 'fal', imageBillingPolicy: 'adapter' },
  { env: { SAMSAR_DEPLOYMENT_EDITION: 'production' }, imageGenerationModel }), /unverified|no verified/);
  assert.equal(writes, 0);
});

test('hosted adapter submissions seal a tariff; agent and standalone calls bypass it', async () => {
  const writes = [];
  const imageGenerationModel = { async updateOne(filter, update) {
    writes.push([filter, update]);
    return { matchedCount: 1 };
  } };
  const payload = { _id: 'new', model: 'WAN2.7PRO', submittedAdapter: 'fal',
    imageBillingPolicy: 'adapter' };
  const snapshot = await sealFalImageSubmission(payload,
    { env: { SAMSAR_DEPLOYMENT_EDITION: 'production' }, imageGenerationModel });
  assert.equal(snapshot.endpoint, 'fal-ai/wan/v2.7/pro/text-to-image');
  assert.deepEqual(writes[0][1].$set.falImageBillingSnapshot, payload.falImageBillingSnapshot);
  assert.equal(await sealFalImageSubmission({ ...payload, model: 'SEEDREAM', imageBillingPolicy: 'pipeline' },
    { env: { SAMSAR_DEPLOYMENT_EDITION: 'production' }, imageGenerationModel }), null);
  assert.equal(await sealFalImageSubmission({ ...payload, model: 'SEEDREAM' },
    { env: { CURRENT_ENV: 'docker' }, imageGenerationModel }), null);
  assert.equal(writes.length, 1);
});

test('legacy saved Fal completion recovers only from its matching original request', async () => {
  const job = { model: 'RECRAFTV3', imageStyle: 'vector_illustration', submittedAdapter: 'fal',
    apiRequestId: 'provider-id' };
  const imageGenerationModel = { findById: () => ({ lean: async () => job }) };
  const receipt = { adapter: 'fal', providerRequestId: 'provider-id', model: 'RECRAFTV3' };
  const recovered = await resolveImageAdapterReceipt(receipt,
    { requestId: 'original-row', apiRequestId: 'provider-id', result: { image: 'done.png' } },
    { imageGenerationModel });
  assert.equal(recovered.costUsd, 0.08);
  await assert.rejects(resolveImageAdapterReceipt({ ...receipt, providerRequestId: 'different' },
    { requestId: 'original-row', result: { image: 'done.png' } }, { imageGenerationModel }),
  /could not be verified/);
  const expiredJob = { findById: () => ({ lean: async () => null }) };
  await assert.rejects(resolveImageAdapterReceipt({ adapter: 'fal', model: 'WAN2.7PRO',
    providerRequestId: 'saved-wan-request' }, { requestId: 'expired-row' },
  { imageGenerationModel: expiredJob }), /could not be verified/);
});
