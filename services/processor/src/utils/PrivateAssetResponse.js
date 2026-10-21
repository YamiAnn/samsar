import { mintPrivateAssetToken, normalizePrivateAssetPath } from './PrivateAssetTokens.js';
import { createHash } from 'node:crypto';

const LEGACY_MEDIA_PREFIXES = /^(?:generations|outpaint|video|ai_video|audio|music|temp_images|user_resources|audio_studio|global_videos|intermediates|twitter|temp|avatar_voiceover)\//;
const IMAGE_REFERENCE_FIELDS = new Set([
  'activeGeneratedImage', 'activeEditedImage', 'activeOutpaintedImage', 'activeSelectedImage',
  'activeImage', 'activeImageRemoteLink', 'image', 'imageUrl', 'image_url',
  'thumbnailUrl', 'thumbnail_url', 'previewUrl', 'preview_url', 'displayUrl', 'display_url',
  'url',
]);
const GENERATED_IMAGE_ARRAY_FIELDS = new Set(['generations', 'generationImages', 'generatedImages']);

function canonicalBareImageReference(value) {
  if (typeof value !== 'string') return value;
  const match = /^([a-z0-9][a-z0-9_.-]*\.(?:png|jpe?g|webp|gif))([?#].*)?$/i.exec(value);
  // A bare UUID filename has no generation/outpaint hint for the client URL
  // helper. Give all known image fields the same explicit legacy media path.
  return match ? `/generations/${match[1]}${match[2] || ''}` : value;
}
const ASSET_GRANT_ENDPOINT = /^\/(?:v2\/assets\/access-url|api\/v2\/assets\/access-url|internal\/production-assets\/provider-url)\/?$/;
const AUTH_HEADER = /^(?:authorization|api_key|app_key|app-key|x-app-key|x-samsar-app-key|x-external-user-api-key|external_user_api_key|external-user-api-key|x-customer-sub-account-api-key|x-customer-subaccount-api-key|x-samsar-customer-sub-account-api-key|x-samsar-sub-account-api-key|customer-sub-account-api-key|customer_sub_account_api_key)$/i;

function authenticatedShareActor(actor, body, pathname, req, res) {
  const match = /^\/video_sessions?\/share\/([^/]+)\/?$/.exec(pathname);
  if (!match || (req.method && req.method !== 'GET') || res.statusCode >= 400) return actor;
  const sessionId = (body?._id || body?.sessionId)?.toString?.();
  if (!/^[a-f0-9]{24}$/i.test(sessionId || '')) return actor;
  let shareToken;
  try { shareToken = decodeURIComponent(match[1]).trim(); } catch { return actor; }
  // Match the existing share-token contract, including historical URL-safe
  // tokens, rather than accepting only the currently generated hex format.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(shareToken)) return actor;
  return { ...actor, readOnlyShareSessionId: sessionId,
    readOnlyShareTokenHash: createHash('sha256').update(shareToken).digest('hex') };
}

function knownMediaOrigins(env) {
  const origins = new Set();
  for (const value of [
    'https://static.samsar.one', env.STATIC_CDN_URL, env.PUBLIC_STATIC_CDN_URL,
    env.SAMSAR_DOCKER_PUBLIC_PROCESSOR_BASE_URL, env.SAMSAR_DOCKER_PUBLIC_ASSET_BASE_URL,
    env.SAMSAR_DOCKER_LOCAL_MEDIA_BASE_URL, env.SAMSAR_LOCAL_MEDIA_BASE_URL,
    env.PUBLIC_API_BASE_URL, env.API_SERVER, env.PROCESSOR_API, env.PROCESSOR_URL,
    'http://localhost:3002',
  ]) {
    try { origins.add(new URL(value).origin); } catch { /* Optional configuration. */ }
  }
  return origins;
}

export function signPrivateAssetReference(value, actor, { env = process.env, mint = mintPrivateAssetToken } = {}) {
  if (typeof value !== 'string' || !actor?.internalUserId || !value || value.startsWith('//')) return value;
  let url;
  const absolute = /^https?:\/\//i.test(value);
  try {
    url = new URL(value, 'http://private-assets.invalid');
  } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return value;
  if (absolute && !knownMediaOrigins(env).has(url.origin)) return value;
  // CloudFront already supplies a separate, signed delivery mechanism.
  if (url.searchParams.has('Signature') && url.searchParams.has('Key-Pair-Id')) return value;
  const relative = url.pathname.replace(/^\/+/, '');
  const canonical = normalizePrivateAssetPath(
    /^(?:assets|assets_v2)\//.test(relative) ? relative : LEGACY_MEDIA_PREFIXES.test(relative) ? `assets/${relative}` : '',
  );
  if (!canonical) return value;
  url.searchParams.set('asset_token', mint({ actor, path: canonical }));
  if (absolute) return url.toString();
  const signed = `${url.pathname}${url.search}${url.hash}`;
  return value.startsWith('/') ? signed : signed.slice(1);
}

export function signPrivateAssetResponse(body, actor, options) {
  // Match Express JSON serialization (including Dates, ObjectIds and toJSON).
  const generatedImageArrays = new WeakSet();
  return JSON.parse(JSON.stringify(body, function signMediaField(key, value) {
    if (GENERATED_IMAGE_ARRAY_FIELDS.has(key) && Array.isArray(value)) generatedImageArrays.add(value);
    const imageObject = this?.type === 'image' || this?.kind === 'image' || this?.mediaType === 'image';
    const imageField = IMAGE_REFERENCE_FIELDS.has(key) || (key === 'src' && imageObject)
      || (Array.isArray(this) && generatedImageArrays.has(this));
    return signPrivateAssetReference(imageField ? canonicalBareImageReference(value) : value, actor, options);
  }));
}

export function privateAssetResponseMiddleware({ resolveActor, ...options }) {
  return (req, res, next) => {
    const pathname = (req.originalUrl || req.url || req.path || '').split('?')[0];
    // These handlers have already minted their grant. Signing their canonical
    // path metadata (or changing the provider purpose) would corrupt it.
    // Public JSON responses also need no resolver/database round trip.
    if (ASSET_GRANT_ENDPOINT.test(pathname) || !Object.entries(req.headers || {})
      .some(([name, value]) => AUTH_HEADER.test(name) && typeof value === 'string' && value.trim())) {
      next();
      return;
    }
    const originalJson = res.json;
    const originalSend = res.send;
    let deliveringJson = false;
    function sendJsonWithPrivateAssets(body, response) {
      // Native image/audio/video elements cannot attach an Authorization header.
      // Give each returned file a short-lived, path-bound media credential;
      // ownership is checked again when it is fetched.
      Promise.resolve().then(() => resolveActor(req.headers)).catch(() => null).then((actor) => {
        const signedBody = actor?.internalUserId && body !== undefined
          ? signPrivateAssetResponse(body, authenticatedShareActor(actor, body, pathname, req, response), options) : body;
        // Express res.json ultimately calls this.send(serializedJson). That
        // internal delivery must not enter the serialized-JSON adapter again.
        deliveringJson = true;
        try { return originalJson.call(response, signedBody); }
        finally { deliveringJson = false; }
      }).catch(next);
      return response;
    }
    res.json = function jsonWithPrivateAssets(body) {
      return sendJsonWithPrivateAssets(body, this);
    };
    if (typeof originalSend === 'function') res.send = function sendWithPrivateAssets(body) {
      const contentType = this.getHeader?.('Content-Type') || this.get?.('Content-Type') || '';
      if (!deliveringJson && typeof body === 'string' &&
          /^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return originalSend.call(this, body); }
        return sendJsonWithPrivateAssets(parsed, this);
      }
      return originalSend.call(this, body);
    };
    next();
  };
}
