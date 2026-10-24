import { isStandaloneEdition } from '../utils/Environment.js';
import { calculateFalLipSyncUsd, falLipSyncTariff } from './FalLipSyncTariffs.js';
import { calculateFalSoundEffectUsd, falSoundEffectTariff } from './FalSoundEffectTariffs.js';
import { calculateFalVideoUsd, falVideoTariffForReceipt } from './FalVideoTariffs.js';
import { calculateStaticVideoUsd, usesLegacyGmiReportedPricing } from './StaticVideoTariffs.js';

export const VIDEO_CREDITS_PER_USD = 100;
export const VIDEO_ADAPTER_MARKUP = 1.2;

export function videoBillingError(message) {
  return Object.assign(new Error(message), { videoBillingPending: true, code: 'VIDEO_BILLING_PENDING' });
}

export function videoBillingMode(payload = {}, env = process.env) {
  if (isStandaloneEdition(env)) return 'standalone';
  return ['adapter', 'pipeline'].includes(payload.videoBillingPolicy) ? payload.videoBillingPolicy : 'legacy';
}

function nonnegative(value, name) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) < 0) throw videoBillingError(`Invalid video ${name}.`);
  return Number(value);
}

/** Fal models use checked-in per-model tariffs. Native adapter receipts
 * describe submitted configuration, not edited scene duration. */
export function calculateVideoCallCredits(receipt = {}) {
  let costUsd;
  let staticPricing;
  const falLipSync = receipt.adapter === 'fal' ? falLipSyncTariff(receipt.model) : null;
  const falSoundEffect = receipt.adapter === 'fal' ? falSoundEffectTariff(receipt.model) : null;
  const falVideo = receipt.adapter === 'fal' ? falVideoTariffForReceipt(receipt) : null;
  if (falLipSync?.fallbackCreditsPerRequestedSecond) {
    const seconds = nonnegative(receipt.requestedSeconds, 'requested duration');
    if (!seconds) throw videoBillingError('The Fal lip sync requested duration is missing.');
    return { adapter: receipt.adapter, model: receipt.model, costUsd: null,
      billableSeconds: seconds, billingBasis: 'requestedSeconds',
      pricingFallback: 'historical_fixed_credits', tariffVerifiedOn: null,
      credits: Math.round(seconds * falLipSync.fallbackCreditsPerRequestedSecond * 10_000) / 10_000 };
  }
  if (falLipSync) costUsd = calculateFalLipSyncUsd(receipt, falLipSync);
  else if (falSoundEffect) costUsd = calculateFalSoundEffectUsd(receipt, falSoundEffect);
  else if (receipt.adapter === 'fal') costUsd = calculateFalVideoUsd(receipt);
  else if (usesLegacyGmiReportedPricing(receipt)) {
    costUsd = nonnegative(receipt.costUsd, 'reported adapter charge');
    staticPricing = { pricingFallback: 'legacy_gmicloud_hailuo_reported_cost', tariffVerifiedOn: null };
  }
  else {
    staticPricing = calculateStaticVideoUsd(receipt);
    costUsd = staticPricing.costUsd;
  }
  return { adapter: receipt.adapter, model: receipt.model, costUsd,
    ...(staticPricing || {}),
    ...(falSoundEffect ? { billableSeconds: Number(receipt.requestedSeconds) * Number(receipt.sampleCount),
      billingBasis: 'submittedSecondsPerSample', sampleCount: Number(receipt.sampleCount),
      sampleCountSource: receipt.sampleCountSource || null,
      tariffVerifiedOn: falSoundEffect.verifiedOn, tariffSource: falSoundEffect.source,
      sampleMultiplierInferred: !!falSoundEffect.sampleMultiplierInferred } : {}),
    ...(falLipSync ? { billableSeconds: Number(receipt[falLipSync.basis]),
      billingBasis: falLipSync.basis, tariffVerifiedOn: falLipSync.verifiedOn,
      tariffSource: falLipSync.source } : {}),
    ...(falVideo ? { billingBasis: receipt.tariffUnit,
      billableQuantity: Number(receipt.billableQuantity ?? receipt.submittedQuantity),
      tariffRateUsd: receipt.tariffRateUsd, tariffVersion: receipt.falVideoTariffVersion,
      tariffVerifiedOn: receipt.tariffVerifiedOn, tariffSource: receipt.tariffSource,
      ...(receipt.pricingRecovery ? { pricingRecovery: receipt.pricingRecovery } : {}) } : {}),
    credits: Math.round(costUsd * VIDEO_CREDITS_PER_USD * VIDEO_ADAPTER_MARKUP * 10_000) / 10_000 };
}

/** Compatibility exception only: callers must limit this to GMI Hailuo's
 * unverified 1080P configuration and use the normal completion response. */
export function reportedVideoCharge(response = {}) {
  const values = [response.billing?.cost_usd, response.billing?.costUsd, response.cost_usd,
    response.costUsd, response.usage?.cost, response.usage?.total_cost];
  const costUsd = values.find(value => value !== undefined && value !== null);
  return costUsd === undefined ? {} : { costUsd };
}
