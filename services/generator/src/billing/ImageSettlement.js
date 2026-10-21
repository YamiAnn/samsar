import { createHash } from 'node:crypto';
import { calculateImageCallCredits, imageBillingError } from './ImagePricing.js';

export function imageCallId(payload, result = {}) {
  const request = result.imageBillingReceipt?.providerRequestId || payload.apiRequestId ||
    [payload.failureRetryCount || 0, payload.filterRetryCount || 0, payload.refilterImagePassNumber || 0, payload.retryCount || 0].join(':');
  const adapter = result.imageBillingReceipt?.adapter || payload.submittedAdapter || payload.adapterProvider || '';
  return createHash('sha256').update(`${payload._id}:${adapter}:${request}`).digest('hex');
}

/** Keep the completed provider result durable before resolving its price or
 * debiting. Retry/recovery always resumes this receipt, never generation. */
export async function settleCompletedImageCall({ id, userId, result, adapterReceipt, context = {},
  store, charge, resolveReceipt = async value => value }) {
  let receipt = await store.ensure(id, { userId: String(userId), result, adapterReceipt,
    context, status: 'PENDING', billing: null });
  if (receipt.userId !== String(userId)) throw imageBillingError('Image billing account conflict.');
  if (receipt.status === 'COMPLETED') return receipt;
  if (!receipt.billing) {
    const pricing = await resolveReceipt(receipt.adapterReceipt, receipt.context);
    const billing = calculateImageCallCredits(pricing);
    receipt = await store.saveBilling(id, billing);
  }
  const debit = receipt.billing.credits > 0
    ? await charge(receipt.userId, receipt.billing.credits, `image:${id}`, receipt)
    : { remainingCredits: null };
  return store.complete(id, { remainingCredits: debit.remainingCredits ?? null });
}

/** Balance and debit marker live in one Mongo document. A ledger failure can
 * be repaired after restart without decrementing the balance a second time. */
export async function debitImageOwnerOnce({ Owner, Ledger, userId, credits, idempotencyKey, ledger = {} }) {
  if (!userId || !idempotencyKey || !Number.isFinite(credits) || credits <= 0) {
    throw imageBillingError('A valid image debit amount and billing identity are required.');
  }
  const hash = createHash('sha256').update(idempotencyKey).digest('hex');
  const field = `generationCreditDebitReservations.${hash}`;
  let owner = await Owner.findOneAndUpdate({ _id: userId, [field]: { $exists: false } },
    { $inc: { generationCredits: -credits },
      $set: { [field]: { amount: credits, idempotencyKey, status: 'DEBITED', createdAt: new Date() } } },
    { new: true, projection: { generationCredits: 1, [field]: 1 } });
  if (!owner) owner = await Owner.findOne({ _id: userId }, { generationCredits: 1, [field]: 1 }).lean();
  const marker = owner?.generationCreditDebitReservations?.[hash];
  if (!marker || marker.amount !== credits) throw imageBillingError('The image debit conflicts with its billing account.');
  try {
    await Ledger.updateOne({ idempotencyKey }, { $setOnInsert: { ...ledger, userId,
      amount: credits, direction: 'debit', idempotencyKey, balanceAfter: owner.generationCredits } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return { remainingCredits: owner.generationCredits };
}
