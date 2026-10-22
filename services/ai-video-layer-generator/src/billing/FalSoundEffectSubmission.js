import { getDBConnectionString } from '../DBString.js';
import AIVideoLayerGeneration from '../schema/AIVideoLayerGeneration.js';
import { videoBillingError, videoBillingMode } from './VideoPricing.js';

/** Snapshot the exact charged configuration before a paid Fal submission. */
export async function prepareFalSoundEffectSubmission(payload, requestedSeconds, submittedSamples,
  dependencies = {}) {
  if (videoBillingMode(payload, dependencies.env || process.env) !== 'adapter') return;
  if (!payload._id) throw videoBillingError('The sound-effect billing queue ID is missing.');
  const nativeReceipt = { adapter: 'fal', model: payload.model,
    requestedSeconds, submittedSamples };
  const persistNativeReceipt = dependencies.persistNativeReceipt || (async (id, receipt) => {
    await getDBConnectionString();
    const update = await AIVideoLayerGeneration.updateOne({ _id: id },
      { $set: { videoBillingNativeReceipt: receipt } });
    if (update.matchedCount !== 1) {
      throw videoBillingError('The sound-effect billing queue is unavailable.');
    }
  });
  await persistNativeReceipt(payload._id, nativeReceipt);
  payload.videoBillingNativeReceipt = nativeReceipt;
}
