import { videoBillingMode } from './VideoPricing.js';

/** A billing/delivery retry consumes this saved output and cannot submit or
 * poll the provider again. Financial settlement has its own durable identity. */
export async function completeVideoOutput(payload, response, dependencies) {
  try {
    let saved = payload.videoBillingSavedResult;
    if (!saved) {
      saved = { remoteUrl: response.remoteUrl, videoBillingReceipt: response.videoBillingReceipt || {
        adapter: payload.submittedAdapter, model: payload.model, providerRequestId: payload.generationId } };
      if (!response.remoteUrl) saved.localVideoLink = await dependencies.downloadBlob(response.responseBlob, payload.sessionId, payload.layerId);
      if (videoBillingMode(payload, dependencies.env || process.env) === 'adapter') {
        // Keep a financial receipt even if the queue is cancelled/deleted
        // between provider completion and the next worker iteration.
        await dependencies.retain?.(payload, saved);
        await dependencies.checkpoint(payload._id, saved);
        payload.videoBillingSavedResult = saved;
      }
    }
    const receipt = await dependencies.bill(payload, saved);
    if (receipt) await dependencies.recordCharge(payload, receipt);
    if (!saved.localVideoLink) {
      saved.localVideoLink = await dependencies.download(saved.remoteUrl, payload.sessionId, payload.layerId);
      if (videoBillingMode(payload, dependencies.env || process.env) === 'adapter') {
        await dependencies.checkpoint(payload._id, saved);
      }
    }
    await dependencies.deliver(payload, saved.localVideoLink);
    return receipt;
  } catch (error) {
    if (videoBillingMode(payload, dependencies.env || process.env) !== 'adapter') throw error;
    // Never send a paid/completed provider call through generation failover.
    throw Object.assign(error, { videoBillingPending: true, code: 'VIDEO_BILLING_PENDING' });
  }
}
