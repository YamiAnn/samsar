import AIVideoLayerGeneration from '../schema/AIVideoLayerGeneration.js';
import { videoBillingMode } from './VideoPricing.js';
import { buildStaticVideoReceipt, usesLegacyGmiReportedPricing } from './StaticVideoTariffs.js';

export async function sealStaticVideoSubmission(payload, configuration, dependencies = {}) {
  if (videoBillingMode(payload, dependencies.env || process.env) !== 'adapter') {
    payload.videoBillingNativeReceipt = configuration;
    return configuration;
  }
  if (usesLegacyGmiReportedPricing(configuration)) {
    payload.videoBillingNativeReceipt = { ...configuration,
      pricingFallback: 'legacy_gmicloud_hailuo_reported_cost' };
    return payload.videoBillingNativeReceipt;
  }
  let receipt;
  try {
    receipt = buildStaticVideoReceipt(configuration);
  } catch (error) {
    // Billing-pending protects an already paid output. A local price guard
    // runs before submission and must follow the ordinary terminal failure.
    delete error.videoBillingPending;
    error.code = 'VIDEO_STATIC_TARIFF_UNAVAILABLE';
    throw error;
  }
  const persist = dependencies.persist || ((id, value) =>
    AIVideoLayerGeneration.findByIdAndUpdate(id, { $set: { videoBillingNativeReceipt: value } }));
  const saved = await persist(payload._id, receipt);
  if (!saved) throw Object.assign(new Error('The static video tariff could not be persisted before submission.'),
    { code: 'VIDEO_TARIFF_NOT_PERSISTED' });
  payload.videoBillingNativeReceipt = receipt;
  return receipt;
}
