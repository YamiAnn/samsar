import { videoBillingError } from './VideoPricing.js';

// Fal's public model pages were checked on 2026-10-23. Keep the endpoint and
// billing unit with each price: these models do not share a seconds tariff.
export const FAL_LIP_SYNC_TARIFFS = Object.freeze({
  SYNCLIPSYNC: Object.freeze({
    endpoint: 'fal-ai/sync-lipsync/v3',
    basis: 'outputSeconds',
    usdPerMinute: 8,
    source: 'https://fal.ai/models/fal-ai/sync-lipsync/v3',
    verifiedOn: '2026-10-23',
  }),
  LATENTSYNC: Object.freeze({
    endpoint: 'fal-ai/latentsync',
    basis: 'outputSeconds',
    usdUpTo40Seconds: 0.20,
    usdPerSecondAbove40Seconds: 0.005,
    source: 'https://fal.ai/models/fal-ai/latentsync',
    verifiedOn: '2026-10-23',
  }),
  KLINGLIPSYNC: Object.freeze({
    endpoint: 'fal-ai/kling-video/lipsync/audio-to-video',
    basis: 'inputSeconds',
    usdPerSecond: 0.014,
    billingBlockSeconds: 5,
    source: 'https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video',
    verifiedOn: '2026-10-23',
  }),
  CREATIFYLIPSYNC: Object.freeze({
    endpoint: 'creatify/lipsync',
    basis: 'outputSeconds',
    // The public card says $1/video minute without stating input or output.
    // Generated output duration is the implementation's billing inference.
    basisInferred: true,
    usdPerMinute: 1,
    source: 'https://fal.ai/models/creatify/lipsync',
    verifiedOn: '2026-10-23',
  }),
  HUMMINGBIRDLIPSYNC: Object.freeze({
    endpoint: 'fal-ai/tavus/hummingbird-lipsync/v0',
    basis: 'requestedSeconds',
    fallbackCreditsPerRequestedSecond: 15,
    // The current Fal page has no verifiable price. Until it does, the
    // historical Samsar 15-credit/requested-second price is an explicit
    // fallback. An archived January 2026 Fal page listed $2.10/generated
    // minute with a 15-second minimum; that price is never used here.
    archivedUsdPerGeneratedMinute: 2.10,
    archivedMinimumSeconds: 15,
    source: 'https://fal.ai/models/fal-ai/tavus/hummingbird-lipsync/v0',
    verifiedOn: null,
  }),
});

export function falLipSyncTariff(model) {
  return FAL_LIP_SYNC_TARIFFS[model] || null;
}

export function requireCurrentFalLipSyncTariff(model) {
  const tariff = falLipSyncTariff(model);
  if (!tariff || !tariff.verifiedOn) {
    throw videoBillingError(`The current Fal lip sync tariff for ${model} is unavailable.`);
  }
  return tariff;
}

function duration(value, name) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw videoBillingError(`The Fal lip sync ${name} is missing or invalid.`);
  }
  return Number(value);
}

export function calculateFalLipSyncUsd(receipt, tariff = requireCurrentFalLipSyncTariff(receipt.model)) {
  if (receipt.adapter !== 'fal') throw videoBillingError('The Fal lip sync adapter is invalid.');
  if (!tariff.verifiedOn) throw videoBillingError(`The current Fal lip sync tariff for ${receipt.model} is unavailable.`);
  const seconds = duration(receipt[tariff.basis], tariff.basis);
  if (receipt.model === 'LATENTSYNC') {
    return seconds <= 40 ? tariff.usdUpTo40Seconds : seconds * tariff.usdPerSecondAbove40Seconds;
  }
  if (receipt.model === 'KLINGLIPSYNC') {
    return Math.ceil(seconds / tariff.billingBlockSeconds) * tariff.billingBlockSeconds * tariff.usdPerSecond;
  }
  return seconds * tariff.usdPerMinute / 60;
}
