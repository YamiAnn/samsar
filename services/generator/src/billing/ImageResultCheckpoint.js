import ImageGeneration from '../schema/ImageGeneration.js';
import { imageBillingMode } from './ImagePricing.js';
import { imageCallId } from './ImageSettlement.js';

export function imageAttempt(payload = {}) {
  return [payload.failureRetryCount || 0, payload.filterRetryCount || 0,
    payload.refilterImagePassNumber || 0, payload.retryCount || 0].join(':');
}

/** Synchronous providers cannot be polled again after a process restart.
 * Save their local result and immutable billing identity before marking the
 * provider request complete, so recovery never regenerates a paid image. */
export async function checkpointImageResult(payload, result, dependencies = {}) {
  if (imageBillingMode(payload, dependencies.env || process.env) !== 'adapter') return result;
  result.imageBillingCallId ||= imageCallId(payload, result);
  try {
    await (dependencies.Model || ImageGeneration).updateOne({ _id: payload._id }, { $set: {
      imageBillingSavedResult: { attempt: imageAttempt(payload), result },
      imageDeliveryPending: true, expireAt: null,
    } });
  } catch (error) {
    // A paid synchronous response cannot safely be regenerated during an
    // outage. Keep ownership for recovery/reconciliation rather than retrying.
    error.imageBillingPending = true;
    throw error;
  }
  return result;
}

export function checkpointForAttempt(payload) {
  const saved = payload.imageBillingSavedResult;
  return saved?.attempt === imageAttempt(payload) ? saved.result : null;
}
