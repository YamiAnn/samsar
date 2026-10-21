import User from '../../schema/User.js';
import { getDBConnectionString } from '../DBString.js';
import { assertAPIKeyUsageLimitForDebit } from '../GenerationCredits.js';
import { getCurrentAPIKeyUsageContext } from './RequestAuthContext.js';
import { shouldBypassGenerationCredits } from '../../utils/EnvironmentUtils.js';
import { createHash } from 'node:crypto';
import ImageGeneration from '../../schema/ImageGeneration.js';

export async function prepareImageRequestBilling(userId, { includedInPipeline = false, apiKeyId, skipAdmission = false } = {}, dependencies = {}) {
  const apiKeyUsage = apiKeyId ? { apiKeyId } : getCurrentAPIKeyUsageContext();
  const policy = includedInPipeline ? 'pipeline' : 'adapter';
  if (!includedInPipeline && !skipAdmission && !shouldBypassGenerationCredits(dependencies.env || process.env)) {
    await (dependencies.connect || getDBConnectionString)();
    const owner = await (dependencies.User || User).findById(userId).select('generationCredits').lean();
    if (!(Number(owner?.generationCredits) > 0)) {
      throw Object.assign(new Error('Insufficient credits'), { code: 'INSUFFICIENT_CREDITS', status: 402 });
    }
    await (dependencies.assertAPIKeyUsageLimitForDebit || assertAPIKeyUsageLimitForDebit)(userId, 0.0001,
      { metadata: { apiKeyUsage } });
  }
  return { userId: String(userId), imageBillingPolicy: policy,
    ...(policy === 'adapter' ? { expireAt: null } : {}),
    imageBillingPending: policy === 'adapter' && !shouldBypassGenerationCredits(dependencies.env || process.env),
    imageBillingAPIKeyUsage: apiKeyUsage || null };
}

export function imageSubmissionCreditReceipt() {
  return { creditsCharged: 0, remainingCredits: null, billingStatus: 'PENDING' };
}

export function imageSubmissionIdentity(userId, scope, key, input) {
  if (typeof key !== 'string' || !key.trim() || key.length > 512) {
    throw Object.assign(new Error('Image request keys must be non-empty strings of at most 512 characters.'), { status: 400 });
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  return {
    id: createHash('sha256').update(`${userId}:${scope}:${key.trim()}`).digest('hex').slice(0, 24),
    fingerprint: createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex'),
  };
}

export async function saveImageAPIRequest(document, idempotencyKey, input, dependencies = {}) {
  // Retain opted-in API jobs so delayed retries cannot recreate expired work.
  document.expireAt = null;
  if (idempotencyKey === undefined || idempotencyKey === null) return document.save({});
  const Model = dependencies.ImageGeneration || ImageGeneration;
  const identity = imageSubmissionIdentity(document.userId, document.case_type, idempotencyKey, input);
  const fields = document.toObject();
  delete fields._id;
  let saved;
  try {
    saved = await Model.findOneAndUpdate({ _id: identity.id },
      { $setOnInsert: { ...fields, imageBillingFingerprint: identity.fingerprint } },
      { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    saved = await Model.findById(identity.id);
  }
  if (saved.imageBillingFingerprint !== identity.fingerprint) {
    throw Object.assign(new Error('Image request key was already used with a different payload.'), { status: 409 });
  }
  return saved;
}

export async function findImageAPIReplay(userId, scope, idempotencyKey, input, dependencies = {}) {
  if (idempotencyKey === undefined || idempotencyKey === null) return null;
  const identity = imageSubmissionIdentity(userId, scope, idempotencyKey, input);
  await (dependencies.connect || getDBConnectionString)();
  const saved = await (dependencies.ImageGeneration || ImageGeneration).findById(identity.id).lean();
  if (!saved) return null;
  if (saved.imageBillingFingerprint !== identity.fingerprint || String(saved.userId) !== String(userId)) {
    throw Object.assign(new Error('Image request key was already used with a different payload.'), { status: 409 });
  }
  return { request_id: String(saved._id), session_id: String(saved._id), global_status_id: String(saved._id),
    status: saved.imageBillingPending || saved.imageDeliveryPending ? 'queued' : saved.generationStatus || saved.editStatus || 'queued',
    creditsCharged: saved.imageCreditsCharged || 0, remainingCredits: saved.imageCreditsRemaining ?? null,
    billingStatus: saved.imageBillingPending ? 'PENDING' : 'COMPLETED' };
}
