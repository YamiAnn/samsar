import { videoBillingError } from './VideoPricing.js';

// Fal model cards and API schemas checked on 2026-10-23. Mirelo 1.6's card
// quotes a second price without spelling out its sample multiplier. Its API
// defaults to two samples; the adjoining SFX versions bill each sample.
export const FAL_SOUND_EFFECT_TARIFFS = Object.freeze({
  MIRELOAI: Object.freeze({
    endpoint: 'mirelo-ai/sfx1.6/video-to-video',
    usdPerSecondPerSample: 0.01,
    defaultRequestedSeconds: 10,
    legacyDefaultSamples: 2,
    source: 'https://fal.ai/models/mirelo-ai/sfx1.6/video-to-video',
    verifiedOn: '2026-10-23',
    sampleMultiplierInferred: true,
  }),
  MMAUDIOV2: Object.freeze({
    endpoint: 'fal-ai/mmaudio-v2',
    usdPerSecondPerSample: 0.001,
    defaultRequestedSeconds: 8,
    source: 'https://fal.ai/models/fal-ai/mmaudio-v2',
    verifiedOn: '2026-10-23',
  }),
});

export function falSoundEffectTariff(model) {
  return FAL_SOUND_EFFECT_TARIFFS[model] || null;
}

export function calculateFalSoundEffectUsd(receipt, tariff = falSoundEffectTariff(receipt.model)) {
  if (receipt.adapter !== 'fal' || !tariff) {
    throw videoBillingError('The Fal sound-effect adapter or model is invalid.');
  }
  const seconds = Number(receipt.requestedSeconds);
  const samples = Number(receipt.sampleCount);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw videoBillingError('The Fal sound-effect submitted duration is missing or invalid.');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 4 ||
      (receipt.model === 'MMAUDIOV2' && samples !== 1)) {
    throw videoBillingError('The Fal sound-effect sample count is missing or invalid.');
  }
  return seconds * samples * tariff.usdPerSecondPerSample;
}
