import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getTokenSecret } from './RuntimeSecrets.js';

const TOKEN_NAMESPACE = 'samsar.private-asset-access.v1';
export const PRIVATE_ASSET_TOKEN_TTL_SECONDS = 15 * 60;
export const PROVIDER_ASSET_TOKEN_TTL_SECONDS = 5 * 60;
const ACTOR_TYPES = new Set([
  'auth_token', 'api_key', 'app_key', 'external_auth', 'customer_sub_account_api_key',
]);

function optionalId(value) {
  const normalized = typeof value === 'string' ? value.trim() : value?.toString?.();
  return typeof normalized === 'string' && normalized && normalized.length <= 256
    && !/[\0\r\n]/.test(normalized) && normalized !== '[object Object]'
    ? normalized : null;
}

/** Canonical storage-relative path; accepts URL encoding, never a full URL. */
export function normalizePrivateAssetPath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value !== value.trim()) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || /%2f|%5c/i.test(value)) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\\\0\r\n?#%]/.test(decoded)) return null;
  const parts = decoded.replace(/^\//, '').split('/');
  if (!['assets', 'assets_v2'].includes(parts[0]) || parts.length < 2) return null;
  if (parts.some(part => !part || part.startsWith('.'))) return null;
  return parts.join('/');
}

export function privateAssetActorScope(actor) {
  if (!actor || !ACTOR_TYPES.has(actor.authType)) return null;
  const internalUserId = optionalId(actor.internalUserId);
  const externalUserId = optionalId(actor.externalUserId || actor.externalUser?._id || actor.externalUser?.id);
  const customerSubAccountId = optionalId(actor.customerSubAccountId || actor.customerSubAccount?._id || actor.customerSubAccount?.id);
  const shareSessionId = actor.readOnlyShareSessionId;
  const shareTokenHash = actor.readOnlyShareTokenHash;
  const hasShareGrant = shareSessionId !== undefined || shareTokenHash !== undefined;
  if (hasShareGrant && (typeof shareSessionId !== 'string' || !/^[a-f0-9]{24}$/i.test(shareSessionId)
    || typeof shareTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(shareTokenHash))) return null;
  if (!internalUserId || (actor.authType === 'external_auth' && !externalUserId)
    || (actor.authType === 'customer_sub_account_api_key' && !customerSubAccountId)) return null;
  return {
    authType: actor.authType,
    internalUserId,
    ...(externalUserId ? { externalUserId } : {}),
    ...(customerSubAccountId ? { customerSubAccountId } : {}),
    ...(hasShareGrant ? { readOnlyShareSessionId: shareSessionId, readOnlyShareTokenHash: shareTokenHash } : {}),
  };
}

function signingKey(secret) {
  return createHmac('sha256', secret || getTokenSecret()).update(TOKEN_NAMESPACE).digest();
}

export function mintPrivateAssetToken({
  actor = null, path, purpose = 'user', expiresInSeconds, now = Date.now(), secret,
} = {}) {
  const canonicalPath = normalizePrivateAssetPath(path);
  const scope = privateAssetActorScope(actor);
  if (!canonicalPath || !['user', 'provider'].includes(purpose) || (purpose === 'user' && !scope)) {
    throw new Error('Invalid private asset grant.');
  }
  const maxTtl = purpose === 'provider' ? PROVIDER_ASSET_TOKEN_TTL_SECONDS : PRIVATE_ASSET_TOKEN_TTL_SECONDS;
  const ttl = expiresInSeconds === undefined ? maxTtl : Number(expiresInSeconds);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > maxTtl || !Number.isFinite(now)) {
    throw new Error('Invalid private asset grant lifetime.');
  }
  const issuedAt = Math.floor(now / 1000);
  return jwt.sign({
    type: 'private_asset_access', purpose, path: canonicalPath,
    ...(purpose === 'user' ? { actor: scope } : {}),
    iat: issuedAt, exp: issuedAt + ttl,
  }, signingKey(secret), { algorithm: 'HS256', issuer: TOKEN_NAMESPACE, audience: TOKEN_NAMESPACE });
}

export function verifyPrivateAssetToken(token, { path, purpose, now = Date.now(), secret } = {}) {
  if (typeof token !== 'string' || !token || token.length > 8192 || !Number.isFinite(now)) return null;
  try {
    const claims = jwt.verify(token, signingKey(secret), {
      algorithms: ['HS256'], issuer: TOKEN_NAMESPACE, audience: TOKEN_NAMESPACE,
      clockTimestamp: Math.floor(now / 1000),
    });
    const canonicalPath = normalizePrivateAssetPath(claims.path);
    const expectedPath = path === undefined ? canonicalPath : normalizePrivateAssetPath(path);
    const scope = claims.purpose === 'user' ? privateAssetActorScope(claims.actor) : null;
    const maxTtl = claims.purpose === 'provider' ? PROVIDER_ASSET_TOKEN_TTL_SECONDS : PRIVATE_ASSET_TOKEN_TTL_SECONDS;
    if (claims.type !== 'private_asset_access' || !['user', 'provider'].includes(claims.purpose)
      || (purpose && claims.purpose !== purpose) || !canonicalPath || canonicalPath !== expectedPath
      || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
      || claims.iat > Math.floor(now / 1000) || claims.exp <= claims.iat || claims.exp - claims.iat > maxTtl
      || (claims.purpose === 'user' && !scope)) return null;
    return { actor: scope, path: canonicalPath, purpose: claims.purpose,
      expiresAt: new Date(claims.exp * 1000).toISOString() };
  } catch { return null; }
}
