import ImageGeneration from '../schema/ImageGeneration.js';
import { imageBillingError } from './ImagePricing.js';
import { calculateFalImageTariffCost, createFalImageTariffSnapshot } from './FalImageTariffs.js';
import { calculateImageAdapterTariffBilling, createImageAdapterTariffSnapshot } from './ImageAdapterTariffs.js';

function sameProviderRequest(adapter, left, right) {
  const normalize = value => ['gmicloud', 'genblaze'].includes(adapter)
    ? String(value).replace(/^genblaze-image(?:-edit)?:/, '') : String(value);
  return normalize(left) === normalize(right);
}

async function resolveNonFalReceipt(receipt, context, imageGenerationModel) {
  let snapshot = receipt.imageAdapterTariffSnapshot || context.imageAdapterTariffSnapshot;
  if (!snapshot && context.requestId) {
    const job = await imageGenerationModel.findById(context.requestId).lean();
    const providerRequestId = receipt.providerRequestId || context.apiRequestId;
    // Recover only an original server-created completion-billed job. Prepaid
    // legacy jobs and already completed receipts must retain their old debit.
    if (job?.imageBillingPolicy === 'adapter' && providerRequestId &&
        sameProviderRequest(receipt.adapter, job.apiRequestId, providerRequestId) &&
        (job.submittedAdapter === receipt.adapter || job.externalProvider === receipt.adapter)) {
      snapshot = job.imageAdapterTariffSnapshot;
      if (!snapshot) {
        try {
          snapshot = createImageAdapterTariffSnapshot(job, { receipt });
        } catch {
          // A saved result remains recoverable even if its old model was retired.
        }
      }
    }
  }
  if (!snapshot) return receipt;
  if (receipt.providerRequestId && context.apiRequestId &&
      !sameProviderRequest(receipt.adapter, receipt.providerRequestId, context.apiRequestId)) {
    throw imageBillingError('The saved image request identity conflicts with its sealed tariff.');
  }
  return { ...receipt, imageAdapterTariffSnapshot: snapshot,
    ...calculateImageAdapterTariffBilling(snapshot, receipt) };
}

/** Calculate a Fal image charge from the tariff sealed before submission.
 * A legacy saved completion can use its original job if the provider request
 * identity still matches. No Fal billing endpoint is contacted. */
export async function resolveImageAdapterReceipt(receipt = {}, context = {},
  { imageGenerationModel = ImageGeneration } = {}) {
  if (receipt.adapter !== 'fal') return resolveNonFalReceipt(receipt, context, imageGenerationModel);

  let snapshot = receipt.falImageBillingSnapshot || context.falImageBillingSnapshot;
  if (!snapshot && context.requestId) {
    const job = await imageGenerationModel.findById(context.requestId).lean();
    const providerRequestId = receipt.providerRequestId || context.apiRequestId;
    if (job && providerRequestId && String(job.apiRequestId) === String(providerRequestId) &&
        (job.submittedAdapter === 'fal' || job.externalProvider === 'fal')) {
      try {
        snapshot = job.falImageBillingSnapshot || createFalImageTariffSnapshot(job);
      } catch {
        // Retain the saved result when legacy submission settings are insufficient.
      }
    }
  }
  if (!snapshot) throw imageBillingError('The saved Fal image tariff could not be verified.');
  if (receipt.model && String(receipt.model).toUpperCase() !== snapshot.model) {
    throw imageBillingError('The saved Fal image model conflicts with its sealed tariff.');
  }
  if (receipt.providerRequestId && context.apiRequestId &&
      String(receipt.providerRequestId) !== String(context.apiRequestId)) {
    throw imageBillingError('The saved Fal image request identity conflicts with its sealed tariff.');
  }
  return { ...receipt, costUsd: calculateFalImageTariffCost(snapshot), costSource: 'static_tariff' };
}
