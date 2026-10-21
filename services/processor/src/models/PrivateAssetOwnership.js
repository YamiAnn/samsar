import { createHash } from 'node:crypto';
import VideoSession from '../schema/VideoSession.js';
import Session from '../schema/Session.js';
import GlobalSession from '../schema/GlobalSession.js';
import ExternalUserRequest from '../schema/ExternalUserRequest.js';
import ImageGeneration from '../schema/ImageGeneration.js';
import GeneratedImage from '../schema/generations/GeneratedImage.js';
import GeneratedAIVideo from '../schema/generations/GeneratedAIVideo.js';
import GeneratedMusic from '../schema/generations/GeneratedMusic.js';
import { getDBConnectionString } from './DBString.js';

const INTERNAL_ACTORS = new Set(['auth_token', 'api_key', 'app_key']);
const SCOPED_ACTORS = new Set(['external_auth', 'customer_sub_account_api_key']);
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const VIDEO_FOLDERS = new Set([
  'output', 'frames', 'audio', 'splash', 'outro', 'footer', 'footer_qr', 'uploads', 'render_plans',
]);
const AI_VIDEO_FOLDERS = new Set(['generations', 'frames', 'audio', 'edits', 'temp', 'thumbnails']);
const SESSION_MEDIA_FIELDS = [
  'videoLink', 'remoteURL', 'splashImage', 'audio', 'outroImageURL',
  'layers.aiVideoLayer', 'layers.aiVideoRemoteLink', 'layers.soundEffectVideoLayer',
  'layers.lipSyncVideoLayer', 'layers.userVideoLayer', 'layers.aiLayerStartFrame',
  'layers.aiLayerEndFrame', 'layers.activeImageCandidate.src',
  'layers.imageSession.activeGeneratedImage', 'layers.imageSession.activeEditedImage',
  'layers.imageSession.activeSelectedImage', 'layers.imageSession.activeOutpaintedImage',
  'layers.imageSession.activeItemList.src', 'layers.imageSession.activeItemList.image',
  'layers.imageSession.activeItemList.url', 'generations.src', 'generations.url',
  ...['audioLayers', 'global_audio_layers'].flatMap((field) => [
    `${field}.localAudioLinks`, `${field}.selectedLocalAudioLink`,
    `${field}.remoteAudioLinks`, `${field}.selectedRemoteAudioLink`,
    `${field}.remoteAudioData.audio_url`,
  ]),
  'global_videos.url', 'global_videos.src', 'global_videos.localVideoLink',
];

function id(value) {
  const result = value?.toString?.();
  return typeof result === 'string' && SAFE_ID.test(result) ? result : '';
}

function sameOrAbsent(left, right) {
  return !left || !right || left === right;
}

function normalizeActor(actor = {}) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const suppliedScopes = [actor.externalUserId, actor.externalUser?._id || actor.externalUser?.id,
    actor.customerSubAccountId, actor.customerSubAccount?._id || actor.customerSubAccount?.id];
  if (suppliedScopes.some((value) => value !== undefined && value !== null && !id(value))) return null;
  const internalUserId = id(actor.internalUserId);
  const externalUserId = id(actor.externalUserId);
  const nestedExternalUserId = id(actor.externalUser?._id || actor.externalUser?.id);
  const customerSubAccountId = id(actor.customerSubAccountId);
  const nestedSubAccountId = id(actor.customerSubAccount?._id || actor.customerSubAccount?.id);
  if (!internalUserId || (!INTERNAL_ACTORS.has(actor.authType) && !SCOPED_ACTORS.has(actor.authType)) ||
      !sameOrAbsent(externalUserId, nestedExternalUserId) ||
      !sameOrAbsent(customerSubAccountId, nestedSubAccountId)) return null;
  const normalized = {
    authType: actor.authType,
    internalUserId,
    externalUserId: externalUserId || nestedExternalUserId,
    customerSubAccountId: customerSubAccountId || nestedSubAccountId,
  };
  const hasReadOnlyGrant = actor.readOnlyShareSessionId != null || actor.readOnlyShareTokenHash != null;
  if (hasReadOnlyGrant) {
    if (typeof actor.readOnlyShareSessionId !== 'string' ||
        typeof actor.readOnlyShareTokenHash !== 'string' ||
        !OBJECT_ID.test(actor.readOnlyShareSessionId) ||
        !/^[a-f0-9]{64}$/.test(actor.readOnlyShareTokenHash)) return null;
    normalized.readOnlyShareSessionId = actor.readOnlyShareSessionId.toLowerCase();
    normalized.readOnlyShareTokenHash = actor.readOnlyShareTokenHash;
  }
  if (actor.authType === 'external_auth' && !normalized.externalUserId) return null;
  if (actor.authType === 'customer_sub_account_api_key' && !normalized.customerSubAccountId) return null;
  normalized.scoped = Boolean(normalized.externalUserId || normalized.customerSubAccountId);
  return normalized;
}

function hasReadOnlyGrant(actor, session) {
  return Boolean(actor.readOnlyShareSessionId && session &&
    id(session._id) === actor.readOnlyShareSessionId && session.shareEnabled === true &&
    typeof session.shareToken === 'string' && session.shareToken &&
    createHash('sha256').update(session.shareToken).digest('hex') === actor.readOnlyShareTokenHash);
}

function canonicalAssetPath(value) {
  // HTTP routing must decode and canonicalize first. Do not reinterpret encoded
  // separators, URL queries, dot segments, or alternate roots here.
  if (typeof value !== 'string' || /[\\%?#\u0000-\u001f\u007f]/.test(value)) return '';
  if (!/^(assets|assets_v2)\//.test(value)) return '';
  const parts = value.split('/');
  return parts.length >= 2 && parts.every((part) => part && part !== '.' && part !== '..') ? value : '';
}

function canonicalReference(value, { bareImage = false } = {}) {
  if (typeof value !== 'string') return '';
  let pathname = value.trim();
  if (/^https?:\/\//i.test(pathname)) {
    try { pathname = new URL(pathname).pathname; } catch { return ''; }
  } else pathname = pathname.split(/[?#]/, 1)[0];
  try { pathname = decodeURIComponent(pathname); } catch { return ''; }
  pathname = pathname.replace(/^\//, '');
  if (!pathname.startsWith('assets_v2/') && !pathname.startsWith('assets/')) {
    if (bareImage && !pathname.includes('/')) pathname = `generations/${pathname}`;
    pathname = `assets/${pathname}`;
  }
  return canonicalAssetPath(pathname);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencePattern(assetPath, { bareImage = false } = {}) {
  const alternatives = [assetPath];
  if (assetPath.startsWith('assets/')) alternatives.push(assetPath.slice('assets/'.length));
  if (bareImage && /^assets\/generations\/[^/]+$/.test(assetPath)) {
    alternatives.push(assetPath.split('/').at(-1));
  }
  return new RegExp(`^(?:https?://[^/?#]+)?/?(?:${alternatives.map(escapeRegExp).join('|')})(?:[?#].*)?$`);
}

function referencesPath(record, fields, assetPath, options) {
  return fields.some((field) => dottedValues(record, field.split('.'))
    .some((value) => canonicalReference(value, options) === assetPath));
}

function dottedValues(value, parts) {
  if (Array.isArray(value)) return value.flatMap((entry) => dottedValues(entry, parts));
  if (!parts.length) return [value];
  return value && typeof value === 'object' ? dottedValues(value[parts[0]], parts.slice(1)) : [];
}

function pathScope(assetPath) {
  const [, ...parts] = assetPath.split('/');
  const [folder, second, third, fourth] = parts;
  if (folder === 'user_resources') {
    const sessionFolder = new Set(['ai_videos', 'user_videos', 'images', 'audio']);
    return {
      ownerId: id(second),
      sessionId: sessionFolder.has(third) && parts.length >= 5 ? id(fourth) : '',
      userResources: true,
    };
  }
  if (folder === 'audio_studio') return { ownerId: id(second), userResources: true, sessionId: '' };
  if (['generations', 'intermediates', 'twitter', 'temp', 'temp_images', 'avatar_voiceover'].includes(folder) && parts.length >= 3) {
    return { sessionId: id(second) };
  }
  if (folder === 'video' && second === 'narrator_avatar' &&
      ['audio', 'video', 'frames', 'joined_frames'].includes(third) && parts.length >= 5) {
    return { sessionId: id(fourth) };
  }
  if (((folder === 'video' && VIDEO_FOLDERS.has(second)) ||
       (folder === 'ai_video' && AI_VIDEO_FOLDERS.has(second)) ||
       (folder === 'global_videos' && second === 'frames')) && parts.length >= 4) {
    return { sessionId: id(third) };
  }
  if (folder === 'video' && second === 'audio_visualizers' && /^[a-f0-9]{24}\.json$/i.test(third || '')) {
    return { sessionId: third.slice(0, -5) };
  }
  // Earlier renderer versions placed the final output directly in video/<id>/.
  if (folder === 'video' && OBJECT_ID.test(second || '') && parts.length >= 3) {
    return { sessionId: second };
  }
  return {};
}

async function leanQuery(query, { select, limit } = {}) {
  if (select && typeof query?.select === 'function') query = query.select(select);
  if (limit && typeof query?.limit === 'function') query = query.limit(limit);
  return typeof query?.lean === 'function' ? query.lean() : query;
}

/** Injectable model boundary keeps the policy tests independent of live services. */
export function createPrivateAssetOwnershipPolicy({ models = {}, ensureConnected = getDBConnectionString } = {}) {
  const db = { VideoSession, Session, GlobalSession, ExternalUserRequest, ImageGeneration,
    GeneratedImage, GeneratedAIVideo, GeneratedMusic, ...models };

  async function sessionProof(sessionId, visited = new Set()) {
    if (!id(sessionId) || visited.has(sessionId) || visited.size > 2) return null;
    visited.add(sessionId);
    if (OBJECT_ID.test(sessionId)) {
      for (const model of [db.VideoSession, db.Session]) {
        const session = await leanQuery(model.findOne({ _id: sessionId }), {
          select: '_id userId editableShareEnabled editableShareImportedUserIds shareEnabled shareToken',
        });
        if (session) return { ownerId: id(session.userId), session, sessionIds: [...visited] };
      }
    }
    const global = await leanQuery(db.GlobalSession.findOne({ $or: [
      { sessionId }, { requestId: sessionId }, { apiSessionId: sessionId },
    ] }), { select: 'sessionId requestId apiSessionId userId' });
    if (global) return { ownerId: id(global.userId), sessionIds: [
      ...visited, id(global.sessionId), id(global.requestId), id(global.apiSessionId),
    ].filter(Boolean) };
    if (OBJECT_ID.test(sessionId)) {
      const generation = await leanQuery(db.ImageGeneration.findOne({ _id: sessionId }), {
        select: '_id sessionId videoSessionId',
      });
      const parent = id(generation?.videoSessionId || generation?.sessionId);
      if (parent && parent !== sessionId) return sessionProof(parent, visited);
    }
    return null;
  }

  async function scopedSessionAccess(actor, proof) {
    if (!proof?.ownerId || proof.ownerId !== actor.internalUserId) return false;
    const filters = {
      internalUserId: actor.internalUserId,
      ...(actor.externalUserId ? { externalUserId: actor.externalUserId } : {}),
      ...(actor.customerSubAccountId ? { customerSubAccountId: actor.customerSubAccountId } : {}),
      $or: proof.sessionIds.flatMap((sessionId) => [{ upstreamSessionId: sessionId }, { upstreamRequestId: sessionId }]),
    };
    const request = await leanQuery(db.ExternalUserRequest.findOne(filters));
    return Boolean(request && id(request.internalUserId) === actor.internalUserId &&
      (!actor.externalUserId || id(request.externalUserId?._id || request.externalUserId) === actor.externalUserId) &&
      (!actor.customerSubAccountId || id(request.customerSubAccountId?._id || request.customerSubAccountId) === actor.customerSubAccountId) &&
      proof.sessionIds.some((value) => value === id(request.upstreamSessionId) || value === id(request.upstreamRequestId)));
  }

  async function canReadProof(actor, proof) {
    if (!proof?.ownerId) return false;
    if (actor.scoped) return scopedSessionAccess(actor, proof);
    if (proof.ownerId === actor.internalUserId) return true;
    if (hasReadOnlyGrant(actor, proof.session)) return true;
    return proof.session?.editableShareEnabled === true &&
      Array.isArray(proof.session.editableShareImportedUserIds) &&
      proof.session.editableShareImportedUserIds.some((userId) => id(userId) === actor.internalUserId);
  }

  async function sharedOutputAccess(actor, ownerId, assetPath) {
    if (actor.scoped || !ownerId) return false;
    const bareImage = /^assets\/generations\/[^/]+$/.test(assetPath);
    const pattern = referencePattern(assetPath, { bareImage });
    if (actor.readOnlyShareSessionId) {
      const session = await leanQuery(db.VideoSession.findOne({ _id: actor.readOnlyShareSessionId }), {
        select: ['_id', 'userId', 'shareEnabled', 'shareToken', ...SESSION_MEDIA_FIELDS].join(' '),
      });
      if (id(session?.userId) === ownerId && hasReadOnlyGrant(actor, session) &&
          referencesPath(session, SESSION_MEDIA_FIELDS, assetPath, { bareImage })) return true;
    }
    const sessions = await leanQuery(db.VideoSession.find({
      userId: ownerId,
      editableShareEnabled: true,
      editableShareImportedUserIds: actor.internalUserId,
      $or: SESSION_MEDIA_FIELDS.map((field) => ({ [field]: pattern })),
    }), { limit: 10 });
    return (sessions || []).some((session) => id(session.userId) === ownerId &&
      session.editableShareEnabled === true &&
      session.editableShareImportedUserIds?.some((userId) => id(userId) === actor.internalUserId) &&
      referencesPath(session, SESSION_MEDIA_FIELDS, assetPath, { bareImage }));
  }

  async function canReadOutput(actor, record, assetPath, fields, { bareImage = false, requireSession = false } = {}) {
    if (!referencesPath(record, fields, assetPath, { bareImage })) return false;
    const ownerId = id(record.userId);
    const sessionId = id(record.videoSessionId || record.sessionId);
    const proof = sessionId ? await sessionProof(sessionId) : null;
    if (ownerId && proof?.ownerId && ownerId !== proof.ownerId) return false;
    if (requireSession && !proof) return false;
    if (proof && await canReadProof(actor, proof)) return true;
    if (!requireSession && !actor.scoped && ownerId === actor.internalUserId) return true;
    return sharedOutputAccess(actor, ownerId || proof?.ownerId, assetPath);
  }

  return async function canAccessPrivateAsset(actorValue, pathValue) {
    const actor = normalizeActor(actorValue);
    const assetPath = canonicalAssetPath(pathValue);
    if (!actor || !assetPath) return false;
    const scope = pathScope(assetPath);
    // An explicit user directory is stronger than any reference in a record.
    // In particular, copying another user's URL into one's session cannot make
    // that user's resource directory readable.
    if (scope.userResources && !scope.ownerId) return false;
    if (scope.userResources && !actor.scoped && scope.ownerId === actor.internalUserId) return true;
    try {
      await ensureConnected();
      if (scope.sessionId) {
        const proof = await sessionProof(scope.sessionId);
        if (proof) {
          if (scope.userResources && proof.ownerId !== scope.ownerId) return false;
          return await canReadProof(actor, proof);
        }
      }
      if (scope.userResources) return await sharedOutputAccess(actor, scope.ownerId, assetPath);

      // These are output-only worker/library collections. Mutable session
      // payloads and input URLs are never sufficient ownership evidence.
      for (const [model, fields, bareImage] of [
        [db.GeneratedImage, ['url'], true],
        [db.GeneratedAIVideo, ['url', 'remoteUrl'], false],
        [db.GeneratedMusic, ['url'], false],
      ]) {
        const pattern = referencePattern(assetPath, { bareImage });
        const records = await leanQuery(model.find({ $or: fields.map((field) => ({ [field]: pattern })) }), { limit: 10 });
        for (const record of records || []) {
          if (await canReadOutput(actor, record, assetPath, fields, { bareImage })) return true;
        }
      }
      const pattern = referencePattern(assetPath);
      const globals = await leanQuery(db.GlobalSession.find({ status: 'COMPLETED', $or: [
        { resultUrl: pattern }, { resultUrls: pattern },
      ] }), { limit: 10 });
      for (const record of globals || []) {
        if (record.status !== 'COMPLETED' || !referencesPath(record, ['resultUrl', 'resultUrls'], assetPath)) continue;
        const proof = { ownerId: id(record.userId), sessionIds: [
          id(record.sessionId), id(record.requestId), id(record.apiSessionId),
        ].filter(Boolean) };
        if (await canReadProof(actor, proof)) return true;
        if (await sharedOutputAccess(actor, proof.ownerId, assetPath)) return true;
      }
      const generations = await leanQuery(db.ImageGeneration.find({
        generationStatus: 'COMPLETED', apiGenerationStatus: 'COMPLETED',
        $or: [{ resultUrl: pattern }, { resultUrls: pattern }],
      }), { limit: 10 });
      for (const record of generations || []) {
        if (record.generationStatus !== 'COMPLETED' || record.apiGenerationStatus !== 'COMPLETED') continue;
        if (await canReadOutput(actor, { ...record, sessionId: record.videoSessionId || record.sessionId || id(record._id) },
          assetPath, ['resultUrl', 'resultUrls'], { requireSession: true })) return true;
      }
      return false;
    } catch {
      // Database failures and incomplete historical mappings must not disclose
      // bytes. The caller handles the same denial as an unowned asset.
      return false;
    }
  };
}

export const canAccessPrivateAsset = createPrivateAssetOwnershipPolicy();
