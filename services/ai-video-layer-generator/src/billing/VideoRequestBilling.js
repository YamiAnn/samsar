import VideoBillingRequest from '../schema/VideoBillingRequest.js';
import User from '../schema/User.js';
import GenerationCreditTransaction from '../schema/GenerationCreditTransaction.js';
import { videoBillingMode, videoBillingError } from './VideoPricing.js';
import { videoCallId, settleCompletedVideoCall, debitVideoOwnerOnce } from './VideoSettlement.js';
import { resolveVideoAdapterReceipt } from './VideoAdapterReceipt.js';
import { falSoundEffectTariff } from './FalSoundEffectTariffs.js';

function billingRequestId(payload, result) {
  return result.videoBillingCallId || (payload.videoBillingPending && payload.videoBillingReceiptId
    ? payload.videoBillingReceiptId : videoCallId(payload, result));
}

const store = {
  async ensure(id, fields) {
    try {
      return await VideoBillingRequest.findOneAndUpdate({ _id: id }, { $setOnInsert: fields },
        { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      return VideoBillingRequest.findById(id).lean();
    }
  },
  async saveBilling(id, billing) {
    await VideoBillingRequest.updateOne({ _id: id, billing: null }, { $set: { billing } });
    return VideoBillingRequest.findById(id).lean();
  },
  async attachLocalResult(id, identity, localVideoLink) {
    const filter = { _id: id, userId: identity.userId, status: 'PENDING', billing: null,
      'result.remoteUrl': identity.remoteUrl,
      'adapterReceipt.adapter': identity.adapter,
      'adapterReceipt.model': identity.model,
      'adapterReceipt.providerRequestId': identity.providerRequestId,
      'result.localVideoLink': { $exists: false } };
    const updated = await VideoBillingRequest.findOneAndUpdate(filter,
      { $set: { 'result.localVideoLink': localVideoLink } }, { new: true }).lean();
    return updated || VideoBillingRequest.findById(id).lean();
  },
  complete: (id, fields) => VideoBillingRequest.findOneAndUpdate({ _id: id },
    { $set: { ...fields, status: 'COMPLETED' } }, { new: true }).lean(),
};

async function charge(userId, credits, idempotencyKey, receipt) {
  // Ensure the unique ledger index exists before a balance mutation.
  await GenerationCreditTransaction.init();
  return debitVideoOwnerOnce({ Owner: User, Ledger: GenerationCreditTransaction, userId, credits, idempotencyKey,
    ledger: { source: 'video_model_completion', apiKeyId: receipt.context?.apiKeyUsage?.apiKeyId || null,
      metadata: { category: 'video', requestId: receipt.context?.requestId,
        sessionId: receipt.context?.sessionId, model: receipt.billing.model,
        adapter: receipt.billing.adapter, costUsd: receipt.billing.costUsd,
        apiKeyUsage: receipt.context?.apiKeyUsage } } });
}

export async function billCompletedVideo(payload, result, dependencies = {}) {
  if (videoBillingMode(payload, dependencies.env || process.env) !== 'adapter') return null;
  if (!payload.userId) throw videoBillingError('Video billing account is required.');
  const id = billingRequestId(payload, result);
  return settleCompletedVideoCall({ id, userId: payload.userId, result,
    adapterReceipt: { ...result?.videoBillingReceipt,
      adapter: result?.videoBillingReceipt?.adapter || payload.submittedAdapter || payload.adapterProvider },
    context: { requestId: String(payload._id), sessionId: payload.videoSessionId || payload.sessionId,
      apiRequestId: payload.generationId, apiKeyUsage: payload.videoBillingAPIKeyUsage,
      ...(payload.model === 'HUMMINGBIRDLIPSYNC' ? { requestedSeconds: payload.duration } : {}),
      ...(falSoundEffectTariff(payload.model) ? {
        requestedSeconds: payload.videoBillingNativeReceipt?.requestedSeconds ||
          (payload.model === 'MIRELOAI' ? payload.duration || 10 : 8),
      } : {}) },
    store: dependencies.store || store, charge: dependencies.charge || charge,
    deferSettlement: dependencies.deferSettlement || false,
    resolveReceipt: dependencies.resolveReceipt || resolveVideoAdapterReceipt });
}

/** Attach measured media to the original paid call without replacing any
 * financial identity or pricing fields. A concurrent settlement may already
 * have resolved the remote output, in which case its billing is final. */
export async function attachLocalVideoBillingResult(payload, result, dependencies = {}) {
  const adapterReceipt = result?.videoBillingReceipt;
  const identity = { userId: String(payload.userId || ''), remoteUrl: result?.remoteUrl,
    adapter: adapterReceipt?.adapter, model: adapterReceipt?.model,
    providerRequestId: adapterReceipt?.providerRequestId };
  if (!identity.userId || !identity.remoteUrl || !identity.adapter || !identity.model ||
      !identity.providerRequestId || !result?.localVideoLink) {
    throw videoBillingError('The saved video billing identity or local output is incomplete.');
  }
  const receipt = await (dependencies.store || store).attachLocalResult(
    billingRequestId(payload, result), identity, result.localVideoLink);
  if (!receipt || receipt.userId !== identity.userId ||
      receipt.result?.remoteUrl !== identity.remoteUrl ||
      receipt.adapterReceipt?.adapter !== identity.adapter ||
      receipt.adapterReceipt?.model !== identity.model ||
      receipt.adapterReceipt?.providerRequestId !== identity.providerRequestId ||
      (!receipt.billing && receipt.status !== 'COMPLETED' &&
        !receipt.result?.localVideoLink)) {
    throw videoBillingError('The saved video billing receipt conflicts with its completed output.');
  }
  return receipt;
}

export async function recoverVideoBillingRequests({ limit = 25 } = {}) {
  const pending = await VideoBillingRequest.find({ status: 'PENDING' }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const receipt of pending) {
    try {
      await settleCompletedVideoCall({ id: receipt._id, userId: receipt.userId, result: receipt.result,
        adapterReceipt: receipt.adapterReceipt, context: receipt.context, store, charge,
        resolveReceipt: resolveVideoAdapterReceipt });
    } catch {
      // Retain the original result and billing identity until confirmation.
      await VideoBillingRequest.updateOne({ _id: receipt._id }, { $set: { updatedAt: new Date() } });
    }
  }
}

export async function getPendingVideoBillingResult(id) {
  return VideoBillingRequest.findById(id).lean();
}
