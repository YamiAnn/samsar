import ImageGeneration from '../schema/ImageGeneration.js';
import { imageBillingMode } from './ImagePricing.js';
import { assertImageAdapterTariffSnapshot, createImageAdapterTariffSnapshot } from './ImageAdapterTariffs.js';

/** Persist verified unit rates before a hosted provider POST. Standalone/BYOK,
 * prepaid jobs, Fal's separate catalog and unverified pairs keep their existing
 * behavior. Missing prices do not introduce a new model availability rule. */
export async function sealImageAdapterSubmission(payload, { env = process.env,
  imageGenerationModel = ImageGeneration } = {}) {
  if (imageBillingMode(payload, env) !== 'adapter' || payload.submittedAdapter === 'fal') return null;
  const saved = payload.imageAdapterTariffSnapshot;
  const adapter = payload.submittedAdapter === 'genblaze' ? 'gmicloud' : payload.submittedAdapter;
  if (saved && saved.adapter === adapter && saved.model === String(payload.model).toUpperCase()) {
    assertImageAdapterTariffSnapshot(saved);
    return saved;
  }
  let snapshot;
  try {
    snapshot = createImageAdapterTariffSnapshot(payload, { env });
  } catch (error) {
    if (error.code === 'IMAGE_ADAPTER_TARIFF_UNVERIFIED') return null;
    throw error;
  }
  const update = await imageGenerationModel.updateOne({ _id: payload._id },
    { $set: { imageAdapterTariffSnapshot: snapshot } });
  if (update?.matchedCount !== 1) {
    throw new Error('The image request disappeared before its adapter tariff could be sealed.');
  }
  payload.imageAdapterTariffSnapshot = snapshot;
  return snapshot;
}
