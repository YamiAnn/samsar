import { prepareImageRequestBilling } from '../api/ImageRequestBilling.js';

// Admission and API-key attribution are shared with the image completion path.
// Only server code calls this; incoming billing policy flags are discarded.
export async function prepareVideoRequestBilling(userId, options = {}, dependencies = {}) {
  const admission = await prepareImageRequestBilling(userId, options, dependencies);
  return { userId: admission.userId, videoBillingPolicy: 'adapter', expireAt: null,
    videoBillingPending: admission.imageBillingPending,
    videoBillingAPIKeyUsage: admission.imageBillingAPIKeyUsage };
}

export function videoQueueBillingFields(payload = {}) {
  return { videoBillingPolicy: payload.videoBillingPolicy,
    videoBillingPending: payload.videoBillingPending,
    videoBillingAPIKeyUsage: payload.videoBillingAPIKeyUsage,
    expireAt: null };
}
