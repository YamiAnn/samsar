import ImageGeneration from '../schema/ImageGeneration.js';
import { imageBillingMode } from './ImagePricing.js';
import { createFalImageTariffSnapshot } from './FalImageTariffs.js';

export async function sealFalImageSubmission(payload, { env = process.env,
  imageGenerationModel = ImageGeneration } = {}) {
  if (imageBillingMode(payload, env) !== 'adapter' || payload.submittedAdapter !== 'fal') return null;
  const snapshot = createFalImageTariffSnapshot(payload);
  const update = await imageGenerationModel.updateOne({ _id: payload._id },
    { $set: { falImageBillingSnapshot: snapshot } });
  if (update?.matchedCount !== 1) {
    throw new Error('The Fal image request disappeared before its tariff could be sealed.');
  }
  payload.falImageBillingSnapshot = snapshot;
  return snapshot;
}
