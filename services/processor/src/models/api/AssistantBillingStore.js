import User from '../../schema/User.js';
import ExternalUser from '../../schema/ExternalUser.js';
import CustomerSubAccount from '../../schema/CustomerSubAccount.js';
import ExternalUserGenerationCreditTransaction from '../../schema/ExternalUserGenerationCreditTransaction.js';
import AssistantBillingRequest from '../../schema/AssistantBillingRequest.js';
import { deductGenerationCreditsIdempotently, assertAPIKeyUsageLimitForDebit } from '../GenerationCredits.js';
import { isInternalBillingExternalUser } from '../external/User.js';
import { createMongoAssistantRequestStore, debitAssistantOwnerOnce } from './AssistantRequestBilling.js';

export const assistantBillingStore = createMongoAssistantRequestStore(AssistantBillingRequest);

export async function admitAssistantRequest(userId, externalUser = null, dependencies = {}) {
  const Users = dependencies.User || User;
  const ExternalUsers = dependencies.ExternalUser || ExternalUser;
  const Budgets = dependencies.CustomerSubAccount || CustomerSubAccount;
  const owner = externalUser && !isInternalBillingExternalUser(externalUser)
    ? await ExternalUsers.findById(externalUser._id).lean()
    : await Users.findById(userId).lean();
  let balance = Number(owner?.generationCredits);
  if (externalUser?.customerSubAccountId) {
    const budget = await Budgets.findById(externalUser.customerSubAccountId).lean();
    if (budget?.generationCredits !== null && budget?.generationCredits !== undefined) {
      balance = Math.min(balance, Number(budget.generationCredits));
    }
  }
  if (!(balance > 0)) throw Object.assign(new Error('Insufficient credits'), { code: 'INSUFFICIENT_CREDITS', status: 402 });
  await (dependencies.assertAPIKeyUsageLimitForDebit || assertAPIKeyUsageLimitForDebit)(userId, 0.0001, { metadata: { apiKeyUsage: dependencies.apiKeyUsage } });
}

export async function chargeAssistantRequest(userId, credits, { idempotencyKey, billing, response,
  externalUser = null, source = 'assistant_api_completion', metadata = {} }, dependencies = {}) {
  const Users = dependencies.User || User;
  const ExternalUsers = dependencies.ExternalUser || ExternalUser;
  const Budgets = dependencies.CustomerSubAccount || CustomerSubAccount;
  const Ledger = dependencies.ExternalUserGenerationCreditTransaction || ExternalUserGenerationCreditTransaction;
  const deduct = dependencies.deductGenerationCreditsIdempotently || deductGenerationCreditsIdempotently;
  const externalLedger = externalUser ? {
    internalUserId: String(userId), externalUserId: externalUser._id,
    externalIdentityKey: externalUser.externalIdentityKey, externalProvider: externalUser.provider,
    externalUserExternalId: externalUser.externalUserId,
    customerSubAccountId: externalUser.customerSubAccountId,
    customerSubAccountPublicId: externalUser.customerSubAccountPublicId,
    customerSubAccountExternalId: externalUser.customerSubAccountExternalId,
  } : {};
  const audit = { ...metadata, requestType: 'API', category: 'assistant',
    model: response?.model, pricingMultiplier: billing.pricingMultiplier, costUsd: billing.costUsd,
    costSource: billing.costSource, usage: billing.usage, assistantBilling: true };
  if (!externalUser || isInternalBillingExternalUser(externalUser)) {
    // Exact cost is only known after inference; settle incurred usage in full.
    const debit = await deduct(userId, credits, {
      source, metadata: audit, idempotencyKey, settleIncurredUsage: true,
    });
    if (!externalUser) return debit;
    let remainingCredits = debit.remainingCredits;
    if (externalUser.customerSubAccountId) {
      const budget = await Budgets.findById(externalUser.customerSubAccountId).lean();
      if (budget?.generationCredits !== null && budget?.generationCredits !== undefined) {
        const result = await debitAssistantOwnerOnce({ Owner: Budgets,
          ownerId: budget._id, credits, idempotencyKey, increment: { totalCreditsUsed: credits } });
        remainingCredits = result.remainingCredits;
      }
    }
    await debitAssistantOwnerOnce({ Owner: ExternalUsers, ownerId: externalUser._id, credits,
      idempotencyKey, debitBalance: false, increment: { totalCreditsUsed: credits, totalRequests: 1 },
      Ledger,
      ledger: { ...externalLedger, source, metadata: audit, balanceAfter: remainingCredits } });
    const currentOwner = await Users.findById(userId).lean();
    await ExternalUsers.updateOne({ _id: externalUser._id }, { $set: { generationCredits: currentOwner?.generationCredits ?? debit.remainingCredits } });
    return { ...debit, remainingCredits };
  }
  return debitAssistantOwnerOnce({ Owner: ExternalUsers, ownerId: externalUser._id, credits,
    idempotencyKey, increment: { totalCreditsUsed: credits, totalRequests: 1 },
    Ledger,
    ledger: { ...externalLedger, source, metadata: audit } });
}
