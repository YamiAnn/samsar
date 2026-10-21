import ImageBillingRequest from '../schema/ImageBillingRequest.js';
import { User } from '../schema/User.js';
import GenerationCreditTransaction from '../schema/GenerationCreditTransaction.js';
import { imageBillingMode, imageBillingError } from './ImagePricing.js';
import { imageCallId, settleCompletedImageCall, debitImageOwnerOnce } from './ImageSettlement.js';
import { resolveImageAdapterReceipt } from './ImageAdapterReceipt.js';

const store = {
  async ensure(id, fields) {
    try {
      return await ImageBillingRequest.findOneAndUpdate({ _id: id }, { $setOnInsert: fields },
        { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      return ImageBillingRequest.findById(id).lean();
    }
  },
  async saveBilling(id, billing) {
    await ImageBillingRequest.updateOne({ _id: id, billing: null }, { $set: { billing } });
    return ImageBillingRequest.findById(id).lean();
  },
  complete: (id, fields) => ImageBillingRequest.findOneAndUpdate({ _id: id },
    { $set: { ...fields, status: 'COMPLETED' } }, { new: true }).lean(),
};

async function charge(userId, credits, idempotencyKey, receipt) {
  // Ensure the unique ledger index exists before a balance mutation.
  await GenerationCreditTransaction.init();
  return debitImageOwnerOnce({ Owner: User, Ledger: GenerationCreditTransaction, userId, credits, idempotencyKey,
    ledger: { source: 'image_model_completion', apiKeyId: receipt.context?.apiKeyUsage?.apiKeyId || null,
      metadata: { category: 'image', requestId: receipt.context?.requestId,
        sessionId: receipt.context?.sessionId, model: receipt.billing.model,
        adapter: receipt.billing.adapter, costUsd: receipt.billing.costUsd,
        apiKeyUsage: receipt.context?.apiKeyUsage } } });
}

export async function billCompletedImage(payload, result, dependencies = {}) {
  if (imageBillingMode(payload, dependencies.env || process.env) !== 'adapter') return null;
  if (!payload.userId) throw imageBillingError('Image billing account is required.');
  const id = result.imageBillingCallId || (payload.imageBillingPending && payload.imageBillingReceiptId
    ? payload.imageBillingReceiptId : imageCallId(payload, result));
  return settleCompletedImageCall({ id, userId: payload.userId, result,
    adapterReceipt: { ...result?.imageBillingReceipt,
      adapter: result?.imageBillingReceipt?.adapter || payload.submittedAdapter || payload.adapterProvider },
    context: { requestId: String(payload._id), sessionId: payload.videoSessionId || payload.sessionId,
      apiRequestId: payload.apiRequestId, apiKeyUsage: payload.imageBillingAPIKeyUsage },
    store: dependencies.store || store, charge: dependencies.charge || charge,
    resolveReceipt: dependencies.resolveReceipt || resolveImageAdapterReceipt });
}

export async function recoverImageBillingRequests({ limit = 25 } = {}) {
  const pending = await ImageBillingRequest.find({ status: 'PENDING' }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const receipt of pending) {
    try {
      await settleCompletedImageCall({ id: receipt._id, userId: receipt.userId, result: receipt.result,
        adapterReceipt: receipt.adapterReceipt, context: receipt.context, store, charge,
        resolveReceipt: resolveImageAdapterReceipt });
    } catch {
      // Retain the original result and billing identity until confirmation.
      await ImageBillingRequest.updateOne({ _id: receipt._id }, { $set: { updatedAt: new Date() } });
    }
  }
}

export async function getPendingImageBillingResult(id) {
  return ImageBillingRequest.findById(id).lean();
}
