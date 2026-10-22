import { videoBillingError } from './VideoPricing.js';
import { getVideoDuration } from '../VideoProcessor.js';
import { falLipSyncTariff, requireCurrentFalLipSyncTariff } from './FalLipSyncTariffs.js';

const DEFAULT_GENBLAZE_BASE_URL = 'http://genblaze:8080/v1';

/** Fal reports actual discounted cost per request, independent of model,
 * video size, quality, output count, and the provider's billing unit. */
export async function readFalVideoCharge(requestId, { fetchImpl = fetch, env = process.env } = {}) {
  if (!requestId) throw videoBillingError('The video adapter request ID is missing.');
  const key = env.FAL_BILLING_API_KEY || env.FAL_API_KEY;
  if (!key) throw videoBillingError('Fal billing credentials are required.');
  const url = new URL('https://api.fal.ai/v1/models/billing-events');
  url.searchParams.set('request_id', requestId);
  url.searchParams.set('limit', '10000');
  const response = await fetchImpl(url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw videoBillingError(`Video billing confirmation is unavailable (${response.status}).`);
  const data = await response.json();
  if (data.has_more || data.next_cursor) throw videoBillingError('The video adapter charge is incomplete.');
  const events = data.billing_events?.filter(event => event.request_id === requestId);
  if (!events?.length) throw videoBillingError('The video adapter charge is not available yet.');
  let costUsd = 0;
  for (const event of events) {
    const value = event.cost_total;
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
        !Number.isFinite(Number(value)) || Number(value) < 0) throw videoBillingError('Invalid video adapter charge.');
    costUsd += Number(value);
  }
  return costUsd;
}

/** The gateway resolves the actual GMICloud model price against the submitted
 * request. Re-reading the sealed job also recovers outputs saved before that
 * price was available, without submitting another provider request. */
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
  if (Object.hasOwn(receipt, 'costUsd')) return receipt;
  if (receipt.adapter === 'fal') return { ...receipt,
    costUsd: await readFalVideoCharge(receipt.providerRequestId || context.apiRequestId, dependencies) };
  if (receipt.adapter === 'gmicloud') return { ...receipt,
    costUsd: await readGenBlazeVideoCharge(receipt.providerRequestId || context.apiRequestId, dependencies) };
  return receipt;
}
