import { createHash } from 'node:crypto';
import { calculateVideoCallCredits, videoBillingError } from './VideoPricing.js';

export function videoCallId(payload, result = {}) {
  const request = result.videoBillingReceipt?.providerRequestId || payload.generationId ||
    [payload.numRetries || 0].join(':');
  const adapter = result.videoBillingReceipt?.adapter || payload.submittedAdapter || payload.adapterProvider || '';
  return createHash('sha256').update(`${payload._id}:${adapter}:${request}`).digest('hex');
}

/** Keep the completed provider result durable before resolving its price or
 * debiting. Retry/recovery always resumes this receipt, never generation. */
export async function settleCompletedVideoCall({ id, userId, result, adapterReceipt, context = {},
  store, charge, resolveReceipt = async value => value, deferSettlement = false }) {
  let receipt = await store.ensure(id, { userId: String(userId), result, adapterReceipt,
    context, status: 'PENDING', billing: null });
  if (receipt.userId !== String(userId)) throw videoBillingError('Video billing account conflict.');
  if (deferSettlement) return receipt;
  if (receipt.status === 'COMPLETED') return receipt;
  if (!receipt.billing) {
    const pricing = await resolveReceipt(receipt.adapterReceipt, receipt.context);
    const billing = calculateVideoCallCredits(pricing);
    receipt = await store.saveBilling(id, billing);
  }
  const debit = receipt.billing.credits > 0
    ? await charge(receipt.userId, receipt.billing.credits, `video:${id}`, receipt)
    : { remainingCredits: null };
  return store.complete(id, { remainingCredits: debit.remainingCredits ?? null });
}

/** Balance and debit marker live in one Mongo document. A ledger failure can
 * be repaired after restart without decrementing the balance a second time. */
export async function debitVideoOwnerOnce({ Owner, Ledger, userId, credits, idempotencyKey, ledger = {} }) {
  if (!userId || !idempotencyKey || !Number.isFinite(credits) || credits <= 0) {
    throw videoBillingError('A valid video debit amount and billing identity are required.');
  }
  const hash = createHash('sha256').update(idempotencyKey).digest('hex');
  const field = `generationCreditDebitReservations.${hash}`;
  let owner = await Owner.findOneAndUpdate({ _id: userId, [field]: { $exists: false } },
    { $inc: { generationCredits: -credits },
      $set: { [field]: { amount: credits, idempotencyKey, status: 'DEBITED', createdAt: new Date() } } },
    { new: true, projection: { generationCredits: 1, [field]: 1 } });
  if (!owner) owner = await Owner.findOne({ _id: userId }, { generationCredits: 1, [field]: 1 }).lean();
  const marker = owner?.generationCreditDebitReservations?.[hash];
  if (!marker || marker.amount !== credits) throw videoBillingError('The video debit conflicts with its billing account.');
  try {
    await Ledger.updateOne({ idempotencyKey }, { $setOnInsert: { ...ledger, userId,
      amount: credits, direction: 'debit', idempotencyKey, balanceAfter: owner.generationCredits } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return { remainingCredits: owner.generationCredits };
}
