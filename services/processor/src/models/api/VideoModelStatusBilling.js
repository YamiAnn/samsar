import GenerationCreditTransaction from '../../schema/GenerationCreditTransaction.js';

/** Reroll clones may retain historical stage receipts. Report only actual
 * completed model debits attributed to this session, including image calls. */
export async function readVideoModelCreditTotal(session, Ledger = GenerationCreditTransaction) {
  if (session.videoBillingPolicy !== 'adapter') return null;
  const rows = await Ledger.find({ userId: session.userId,
    'metadata.sessionId': String(session._id), direction: 'debit',
    source: { $in: ['image_model_completion', 'video_model_completion'] } }).select('amount').lean();
  return Math.round(rows.reduce((total, row) => total + Number(row.amount), 0) * 10000) / 10000;
}
