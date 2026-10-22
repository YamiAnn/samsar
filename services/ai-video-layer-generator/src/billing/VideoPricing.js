import { isStandaloneEdition } from '../utils/Environment.js';
import { calculateFalLipSyncUsd, falLipSyncTariff } from './FalLipSyncTariffs.js';

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

/** Fal lip sync uses published per-model tariffs. Other adapter receipts use
 * reported provider charges when present, including free calls. Native
 * receipts describe submitted configuration, not edited scene duration. */
export function calculateVideoCallCredits(receipt = {}) {
  let costUsd;
  const falLipSync = receipt.adapter === 'fal' ? falLipSyncTariff(receipt.model) : null;
  if (falLipSync?.fallbackCreditsPerRequestedSecond) {
    const seconds = nonnegative(receipt.requestedSeconds, 'requested duration');
    if (!seconds) throw videoBillingError('The Fal lip sync requested duration is missing.');
    return { adapter: receipt.adapter, model: receipt.model, costUsd: null,
      billableSeconds: seconds, billingBasis: 'requestedSeconds',
      pricingFallback: 'historical_fixed_credits', tariffVerifiedOn: null,
      credits: Math.round(seconds * falLipSync.fallbackCreditsPerRequestedSecond * 10_000) / 10_000 };
  }
  if (falLipSync) costUsd = calculateFalLipSyncUsd(receipt, falLipSync);
  else if (Object.hasOwn(receipt, 'costUsd')) costUsd = nonnegative(receipt.costUsd, 'adapter charge');
  else {
    const seconds = nonnegative(receipt.seconds, 'billable duration');
    if (!seconds) throw videoBillingError('Completed video duration is missing.');
    if (receipt.adapter === 'runway' && receipt.model === 'gen4.5') costUsd = seconds * 0.12;
    else if (receipt.adapter === 'googleCloud' && /^veo-3\.1-(fast-)?generate/.test(receipt.model || '')) {
      if (typeof receipt.generateAudio !== 'boolean' || !['720p', '1080p'].includes(receipt.resolution)) {
        throw videoBillingError('The submitted Google video configuration is incomplete.');
      }
      const fast = receipt.model.includes('-fast-');
      const rate = fast ? (receipt.generateAudio ? (receipt.resolution === '1080p' ? 0.12 : 0.10)
        : (receipt.resolution === '1080p' ? 0.10 : 0.08)) : (receipt.generateAudio ? 0.40 : 0.20);
      const outputs = nonnegative(receipt.outputCount, 'output count');
      if (!Number.isInteger(outputs) || outputs < 1) throw videoBillingError('Completed video output count is missing.');
      costUsd = seconds * rate * outputs;
    } else if (receipt.adapter === 'alibabaCloud' && receipt.model === 'happyhorse-1.1-i2v' && receipt.resolution === '720P') {
      if (!['international', 'global', 'china'].includes(receipt.region)) throw videoBillingError('Unknown Alibaba video region.');
      costUsd = seconds * (receipt.region === 'international' ? 0.14 : 0.123769);
    } else if (receipt.adapter === 'hailuo' && receipt.model === 'MiniMax-Hailuo-02' && receipt.resolution === '768P' && [6, 10].includes(seconds)) {
      costUsd = seconds === 6 ? 0.28 : 0.56;
    } else throw videoBillingError('The video adapter charge is not available yet.');
  }
  return { adapter: receipt.adapter, model: receipt.model, costUsd,
    ...(falLipSync ? { billableSeconds: Number(receipt[falLipSync.basis]),
      billingBasis: falLipSync.basis, tariffVerifiedOn: falLipSync.verifiedOn,
      tariffSource: falLipSync.source } : {}),
    credits: Math.round(costUsd * VIDEO_CREDITS_PER_USD * VIDEO_ADAPTER_MARKUP * 10_000) / 10_000 };
}

export function reportedVideoCharge(response = {}) {
  const values = [response.billing?.cost_usd, response.billing?.costUsd, response.cost_usd,
    response.costUsd, response.usage?.cost, response.usage?.total_cost];
  const costUsd = values.find(value => value !== undefined && value !== null);
  return costUsd === undefined ? {} : { costUsd };
}
