import { imageBillingError } from './ImagePricing.js';

/** Fal reports actual discounted cost per request, independent of model,
 * image size, quality, output count, and the provider's billing unit. */
export async function readFalImageCharge(requestId, { fetchImpl = fetch, env = process.env } = {}) {
  if (!requestId) throw imageBillingError('The image adapter request ID is missing.');
  const key = env.FAL_BILLING_API_KEY || env.FAL_API_KEY;
  if (!key) throw imageBillingError('Fal billing credentials are required.');
  const url = new URL('https://api.fal.ai/v1/models/billing-events');
  url.searchParams.set('request_id', requestId);
  url.searchParams.set('limit', '10000');
  const response = await fetchImpl(url, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw imageBillingError(`Image billing confirmation is unavailable (${response.status}).`);
  const data = await response.json();
  if (data.has_more || data.next_cursor) throw imageBillingError('The image adapter charge is incomplete.');
  const events = data.billing_events?.filter(event => event.request_id === requestId);
  if (!events?.length) throw imageBillingError('The image adapter charge is not available yet.');
  let costUsd = 0;
  for (const event of events) {
    const value = event.cost_total;
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
        !Number.isFinite(Number(value)) || Number(value) < 0) throw imageBillingError('Invalid image adapter charge.');
    costUsd += Number(value);
  }
  return costUsd;
}

export async function resolveImageAdapterReceipt(receipt, context = {}, dependencies = {}) {
  if (Object.hasOwn(receipt, 'costUsd')) return receipt;
  if (receipt.adapter === 'fal') return { ...receipt,
    costUsd: await readFalImageCharge(receipt.providerRequestId || context.apiRequestId, dependencies) };
  return receipt;
}
