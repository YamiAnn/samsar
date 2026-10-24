import { calculateImageAdapterTariffBilling, calculateNativeImageCost } from './ImageAdapterTariffs.js';

export const IMAGE_PRICING_MULTIPLIER = 1.2;
const CREDITS_PER_USD = 100;

export function imageBillingError(message, code = 'IMAGE_BILLING_PENDING') {
  return Object.assign(new Error(message), { code, imageBillingPending: true });
}

function amount(value, label = 'adapter charge') {
  if (!['number', 'string'].includes(typeof value) ||
      (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw imageBillingError(`A valid ${label} is required.`);
  }
  return Number(value);
}

export function imageBillingMode(payload = {}, env = process.env) {
  const edition = String(env.SAMSAR_DEPLOYMENT_EDITION || env.SAMSAR_EDITION || env.CURRENT_ENV || '').trim().toLowerCase();
  if (['standalone', 'community', 'docker'].includes(edition)) return 'standalone';
  // Only new, server-created jobs opt into completion billing. Existing jobs
  // may already have been paid for and must never receive a second debit.
  return payload.imageBillingPolicy === 'adapter' ? 'adapter'
    : payload.imageBillingPolicy === 'pipeline' ? 'pipeline' : 'legacy';
}

export function calculateImageCallCredits(receipt = {}) {
  let costUsd;
  let costSource = 'adapter_reported';
  let pricingException;
  if (receipt.imageAdapterTariffSnapshot) {
    ({ costUsd, costSource, pricingException } = calculateImageAdapterTariffBilling(receipt.imageAdapterTariffSnapshot, receipt));
  } else if (Object.hasOwn(receipt, 'costUsd')) {
    costUsd = amount(receipt.costUsd);
    costSource = receipt.costSource || costSource;
  }
  else if (Array.isArray(receipt.calls) && receipt.calls.length) {
    costSource = 'native_usage';
    costUsd = receipt.calls.reduce((sum, call) => sum + calculateImageCallCredits(call).costUsd, 0);
  }
  else {
    costSource = 'native_usage';
    costUsd = calculateNativeImageCost(receipt);
  }
  const credits = Math.round(costUsd * CREDITS_PER_USD * IMAGE_PRICING_MULTIPLIER * 10_000) / 10_000;
  if (!Number.isFinite(credits)) throw imageBillingError('Invalid image adapter charge.');
  return { costUsd, credits, costSource, adapter: receipt.adapter, model: receipt.model,
    ...(pricingException ? { pricingException } : {}) };
}

/** Called only on a trusted adapter response, never on client request fields. */
export function reportedImageCharge(response = {}) {
  const candidates = [response?.billing?.cost_usd, response?.billing?.costUsd,
    response?.cost_usd, response?.costUsd, response?.usage?.cost,
    response?.usage?.total_cost, response?.usage?.cost_usd];
  const value = candidates.find(value => value !== undefined && value !== null);
  return value === undefined ? {} : { costUsd: value };
}
