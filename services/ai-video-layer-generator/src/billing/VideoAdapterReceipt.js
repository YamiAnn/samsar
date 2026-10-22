import { videoBillingError } from './VideoPricing.js';
import { getVideoDuration, getVideoPricingMetadata } from '../VideoProcessor.js';
import { falLipSyncTariff, requireCurrentFalLipSyncTariff } from './FalLipSyncTariffs.js';
import { falSoundEffectTariff } from './FalSoundEffectTariffs.js';
import { buildFalVideoSubmissionReceipt, falVideoTariffForReceipt } from './FalVideoTariffs.js';
import AIVideoLayerGeneration from '../schema/AIVideoLayerGeneration.js';

const DEFAULT_GENBLAZE_BASE_URL = 'http://genblaze:8080/v1';

/** Re-read the original GMICloud gateway result when its saved completion had
 * no charge. This is a result/status GET, never a model pricing endpoint or a
 * replacement generation request. */
export async function readGenBlazeVideoCharge(requestId, { fetchImpl = fetch, env = process.env } = {}) {
  const id = String(requestId || '').replace(/^genblaze-video:/, '').trim();
  if (!id) throw videoBillingError('The GMICloud video request ID is missing.');
  const baseUrl = String(env.SAMSAR_GENBLAZE_BASE_URL || DEFAULT_GENBLAZE_BASE_URL).replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/media/requests/${encodeURIComponent(id)}`,
    { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw videoBillingError(`GMICloud video billing confirmation is unavailable (${response.status}).`);
  const data = await response.json();
  if (data?.status !== 'succeeded') throw videoBillingError('The GMICloud video result is not complete.');
  const costUsd = data?.billing?.cost_usd;
  if (!['number', 'string'].includes(typeof costUsd) || String(costUsd).trim() === '' ||
      !Number.isFinite(Number(costUsd)) || Number(costUsd) < 0) {
    throw videoBillingError('The GMICloud video adapter charge is not available yet.');
  }
  return Number(costUsd);
}

export async function resolveVideoAdapterReceipt(receipt, context = {}, dependencies = {}) {
  if (receipt.adapter === 'fal' && falLipSyncTariff(receipt.model)) {
    const tariff = falLipSyncTariff(receipt.model);
    if (!tariff.fallbackCreditsPerRequestedSecond) requireCurrentFalLipSyncTariff(receipt.model);
    if (Object.hasOwn(receipt, tariff.basis)) return receipt;
    if (tariff.basis === 'requestedSeconds') {
      if (context.requestedSeconds === undefined) {
        throw videoBillingError('The Fal lip sync requested duration is unavailable.');
      }
      return { ...receipt, requestedSeconds: context.requestedSeconds };
    }
    const video = tariff.basis === 'outputSeconds'
      ? context.result?.localVideoLink || context.result?.remoteUrl : null;
    if (!video) throw videoBillingError(`The Fal lip sync ${tariff.basis} is unavailable.`);
    let seconds;
    try {
      seconds = await (dependencies.probeDuration || getVideoDuration)(video);
    } catch {
      // ffprobe errors can contain a signed result URL; never expose it.
      throw videoBillingError(`The Fal lip sync ${tariff.basis} could not be measured.`);
    }
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) {
      throw videoBillingError(`The Fal lip sync ${tariff.basis} is invalid.`);
    }
    return { ...receipt, [tariff.basis]: Number(seconds) };
  }
  if (receipt.adapter === 'fal' && falSoundEffectTariff(receipt.model)) {
    const tariff = falSoundEffectTariff(receipt.model);
    let requestedSeconds = receipt.requestedSeconds;
    let durationSource = receipt.durationSource || 'submitted_config';
    if (requestedSeconds === undefined && receipt.model === 'MMAUDIOV2') {
      requestedSeconds = tariff.defaultRequestedSeconds;
      durationSource = 'legacy_fal_default';
    }
    if (requestedSeconds === undefined && receipt.model === 'MIRELOAI') {
      const lookupGeneration = dependencies.lookupGeneration || (id =>
        AIVideoLayerGeneration.findById(id, { duration: 1 }).lean());
      let queued;
      if (context.requestId) {
        try { queued = await lookupGeneration(context.requestId); } catch { /* Saved output remains usable. */ }
      }
      if (queued) {
        requestedSeconds = queued.duration || tariff.defaultRequestedSeconds;
        durationSource = 'legacy_queue';
      } else {
        const video = context.result?.localVideoLink || context.result?.remoteUrl;
        if (!video) throw videoBillingError('The saved Fal sound-effect output is unavailable.');
        try {
          requestedSeconds = await (dependencies.probeDuration || getVideoDuration)(video);
        } catch {
          // ffprobe errors can contain a signed result URL; never expose it.
          throw videoBillingError('The saved Fal sound-effect duration could not be measured.');
        }
        durationSource = 'legacy_measured_output';
      }
    }
    const sampleCount = receipt.sampleCount === undefined
      ? (receipt.model === 'MIRELOAI' ? tariff.legacyDefaultSamples : 1)
      : receipt.sampleCount;
    return { ...receipt, requestedSeconds, durationSource, sampleCount,
      sampleCountSource: receipt.sampleCountSource ||
        (receipt.sampleCount === undefined ? 'legacy_default' : 'submitted_config') };
  }
  if (receipt.adapter === 'fal') {
    let sealed = receipt.falVideoTariffVersion ? receipt : null;
    if (!sealed) {
      // Existing completed jobs predate submission receipts. Recover their
      // original options from the queue without polling Fal or resubmitting.
      const lookupGeneration = dependencies.lookupGeneration || (id =>
        AIVideoLayerGeneration.findById(id, {
          model: 1, duration: 1, generateAudio: 1, generate_audio: 1,
          isAudioVideoGeneration: 1, generationType: 1, layerAiVideoType: 1,
          framesPerSecond: 1, aspectRatio: 1, videoBillingNativeReceipt: 1,
          submittedAdapter: 1, generationId: 1,
        }).lean());
      let queued;
      if (context.requestId) {
        try { queued = await lookupGeneration(context.requestId); } catch { /* Keep the saved output. */ }
      }
      if (queued && queued.model !== receipt.model) {
        throw videoBillingError('The saved Fal video model differs from its queued request.');
      }
      if (queued?.submittedAdapter && queued.submittedAdapter !== 'fal') {
        throw videoBillingError('The saved Fal video adapter differs from its queued request.');
      }
      if (queued?.generationId && receipt.providerRequestId &&
          queued.generationId !== receipt.providerRequestId) {
        throw videoBillingError('The saved Fal video provider request differs from its queued request.');
      }
      if (queued?.videoBillingNativeReceipt?.falVideoTariffVersion) {
        sealed = queued.videoBillingNativeReceipt;
      } else if (queued) {
        try { sealed = buildFalVideoSubmissionReceipt(queued); } catch {
          throw videoBillingError('The saved Fal video configuration has no verified tariff.');
        }
      } else if (['SDVIDEO', 'SKYREELSI2V', 'VIDUI2V'].includes(receipt.model)) {
        sealed = buildFalVideoSubmissionReceipt({ model: receipt.model });
      } else {
        throw videoBillingError('The saved Fal video submission configuration is unavailable.');
      }
      sealed = { ...receipt, ...sealed, pricingRecovery: queued ? 'legacy_queue' : 'legacy_model' };
    }
    if (sealed.model !== receipt.model || !falVideoTariffForReceipt(sealed)) {
      throw videoBillingError('The saved Fal video model has no verified tariff.');
    }
    if (sealed.tariffUnit === 'millionVideoTokens' || sealed.tariffUnit === 'thousandVideoTokens') {
      if (sealed.billableQuantity !== undefined) return sealed;
      const video = context.result?.localVideoLink || context.result?.remoteUrl;
      if (!video) throw videoBillingError('The saved Fal video output is unavailable for token measurement.');
      let metadata;
      try {
        metadata = await (dependencies.probeVideo || getVideoPricingMetadata)(video);
      } catch {
        // ffprobe errors can contain a signed result URL; never expose it.
        throw videoBillingError('The Fal video output could not be measured for billing.');
      }
      const { width, height, seconds, framesPerSecond } = metadata || {};
      const fps = sealed.tariffUnit === 'thousandVideoTokens' ? 24 : Number(framesPerSecond);
      if (![width, height, seconds, fps].every(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
        throw videoBillingError('The Fal video output dimensions or duration are invalid.');
      }
      const tokens = Number(width) * Number(height) * Number(seconds) * Number(fps) / 1024;
      return { ...sealed, billableQuantity: tokens /
        (sealed.tariffUnit === 'millionVideoTokens' ? 1_000_000 : 1_000),
      measuredOutput: { width: Number(width), height: Number(height),
        seconds: Number(seconds), framesPerSecond: Number(fps) } };
    }
    return sealed;
  }
  if (Object.hasOwn(receipt, 'costUsd')) return receipt;
  if (receipt.adapter === 'gmicloud') return { ...receipt,
    costUsd: await readGenBlazeVideoCharge(receipt.providerRequestId || context.apiRequestId, dependencies) };
  return receipt;
}
