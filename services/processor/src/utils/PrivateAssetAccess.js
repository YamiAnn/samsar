import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runtimeSecretMatches } from './RuntimeSecrets.js';
import { resolveAssetAuthHeaders } from './AssetAuthHeaders.js';
import {
  mintPrivateAssetToken, normalizePrivateAssetPath, verifyPrivateAssetToken,
  privateAssetActorScope, PRIVATE_ASSET_TOKEN_TTL_SECONDS, PROVIDER_ASSET_TOKEN_TTL_SECONDS,
} from './PrivateAssetTokens.js';

export { mintPrivateAssetToken, normalizePrivateAssetPath, verifyPrivateAssetToken } from './PrivateAssetTokens.js';

const DEFAULT_RUNTIME_CONFIG_PATH = '/persistent/config/samsar.config.json';

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.vary('Authorization');
  res.vary('Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function errorResponse(res, code) {
  privateHeaders(res);
  return res.status(code).json({ error: code === 401 ? 'Authentication required.'
    : code === 403 ? 'Asset access denied.' : code === 400 ? 'Invalid asset path.'
    : code === 405 ? 'Method not allowed.' : code === 416 ? 'Requested range not satisfiable.' : 'Asset not found.' });
}

function requestPath(req) {
  return (req.url || '').split('?')[0];
}

function isContained(root, file) {
  return file !== root && file.startsWith(`${root}${path.sep}`);
}

async function containedFile(root, relativePath) {
  try {
    const [realRoot, realFile] = await Promise.all([
      fs.realpath(root), fs.realpath(path.resolve(root, relativePath)),
    ]);
    if (!isContained(realRoot, realFile)) return { denied: true };
    const stat = await fs.stat(realFile);
    return stat.isFile() ? { file: realFile, root: realRoot } : null;
  } catch { return null; }
}

function localOrPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!normalized || !normalized.includes('.') || normalized.includes(':')
    || normalized.endsWith('.localhost') || normalized.endsWith('.local')
    || normalized.endsWith('.internal') || normalized.endsWith('.invalid')) return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || !octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
    || (a === 198 && [18, 19].includes(b));
}

function safeBaseUrl(value, { provider = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash) return null;
    if (provider && (parsed.protocol !== 'https:' || localOrPrivateHostname(parsed.hostname))) return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch { return null; }
}

async function managedTunnelPublicBaseUrl(env) {
  const configPaths = [env.SAMSAR_RUNTIME_CONFIG_FILE, env.SAMSAR_CONFIG_FILE, DEFAULT_RUNTIME_CONFIG_PATH]
    .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
  for (const configPath of configPaths) {
    let config;
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch { continue; }
    for (const tunnel of [config?.localMediaTunnel, config?.mediaTunnel]) {
      if (!tunnel || tunnel.enabled === false) continue;
      const base = safeBaseUrl(tunnel.publicUrl || tunnel.url, { provider: true });
      if (base && new URL(base).pathname === '/') return new URL(base).origin;
    }
  }
  return null;
}

export async function resolvePrivateAssetPublicBaseUrl({
  purpose = 'user', env = process.env, runtimeConfig,
} = {}) {
  let config = runtimeConfig;
  if (!config) {
    try {
      config = JSON.parse(await fs.readFile(env.SAMSAR_PRODUCTION_MEDIA_RUNTIME_CONFIG
        || '/persistent/media-publication/production-media.json', 'utf8'));
    } catch { config = {}; }
  }
  const options = { provider: purpose === 'provider' };
  const publicationBase = safeBaseUrl(config.publication?.publicBaseUrl, { provider: true });
  const mode = config.publication?.mode;
  if (mode === 'external' && config.externalPublish?.enabled === true
    && config.externalPublish?.securityMode === 'processor-token-proxy') {
    const externalBase = safeBaseUrl(config.externalPublish?.publicBaseUrl, { provider: true });
    if (externalBase && externalBase === publicationBase) return externalBase;
  }
  if (['stable', 'tunnel'].includes(mode) && publicationBase) return publicationBase;
  const dockerLocalMode = ['docker-local', 'local-filesystem'].includes(
    String(env.SAMSAR_MEDIA_DELIVERY_MODE || env.MEDIA_DELIVERY_MODE || '').toLowerCase(),
  );
  if (purpose === 'provider' && dockerLocalMode) {
    const tunnelBase = await managedTunnelPublicBaseUrl(env);
    if (tunnelBase) return tunnelBase;
  }
  for (const value of [env.SAMSAR_DOCKER_PUBLIC_PROCESSOR_BASE_URL,
    env.PUBLIC_API_BASE_URL, env.PUBLIC_BASE_URL, env.API_SERVER, config.mediaPublicBaseUrl]) {
    const base = safeBaseUrl(value, options);
    if (base) return base;
  }
  if (purpose === 'provider' && !dockerLocalMode) {
    const tunnelBase = await managedTunnelPublicBaseUrl(env);
    if (tunnelBase) return tunnelBase;
  }
  if (purpose === 'user' && ['1', 'true', 'yes', 'on'].includes(
    String(env.SAMSAR_PRODUCTION_ASSET_ALLOW_HTTP_LOCAL || '').toLowerCase(),
  )) {
    for (const value of [config.localRehearsal?.publicBaseUrl,
      env.SAMSAR_PRODUCTION_API_PUBLIC_URL, env.PROCESSOR_PUBLIC_URL]) {
      const base = safeBaseUrl(value);
      if (base && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) return base;
    }
  }
  return null;
}

function assetUrl(base, canonicalPath, token) {
  const encodedPath = canonicalPath.split('/').map(encodeURIComponent).join('/');
  return `${base || ''}/${encodedPath}?asset_token=${encodeURIComponent(token)}`;
}

/** Install before other static handlers; API routes can be mounted before or after. */
export function installPrivateAssetAccess({
  app, assetsPath, assetsV2Path, setCustomHeaders = () => {}, resolveActor, canAccessAsset,
  signResponse,
} = {}) {
  if (!app || typeof resolveActor !== 'function' || typeof canAccessAsset !== 'function'
    || !assetsPath || !assetsV2Path) throw new Error('Private asset access callbacks and roots are required.');

  const roots = { assets: path.resolve(assetsPath), assets_v2: path.resolve(assetsV2Path) };
  const staticHandlers = new Map();
  function staticHandler(realRoot) {
    if (staticHandlers.has(realRoot)) return staticHandlers.get(realRoot);
    const handler = express.static(realRoot, {
      fallthrough: false, index: false, redirect: false, dotfiles: 'deny',
      cacheControl: false,
      setHeaders(res, filePath, stat) {
        setCustomHeaders(res, filePath, stat);
        const extraMimeTypes = { '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
          '.opus': 'audio/ogg', '.mkv': 'video/x-matroska' };
        const mime = extraMimeTypes[path.extname(filePath).toLowerCase()];
        if (mime) res.setHeader('Content-Type', mime);
        privateHeaders(res);
      },
    });
    staticHandlers.set(realRoot, handler);
    return handler;
  }

  async function actorForRequest(req, canonicalPath) {
    if (Object.prototype.hasOwnProperty.call(req.query || {}, 'asset_token')) {
      const grant = verifyPrivateAssetToken(req.query.asset_token, { path: canonicalPath });
      if (!grant) return null;
      if (grant.purpose === 'user' && Object.keys(req.headers || {}).some(name => (
        /^(authorization|api_key|app_key|app-key|x-app-key|x-samsar-app-key|x-customer-sub-account-api-key|x-customer-subaccount-api-key|x-samsar-customer-sub-account-api-key|x-samsar-sub-account-api-key|customer-sub-account-api-key|customer_sub_account_api_key|x-external-user-api-key|external_user_api_key|external-user-api-key)$/i.test(name)
      ))) {
        try {
          const supplied = privateAssetActorScope(await resolveActor(req.headers));
          const sameIdentity = supplied && ['internalUserId', 'externalUserId', 'customerSubAccountId']
            .every(field => (supplied[field] || null) === (grant.actor[field] || null));
          if (!sameIdentity) return null;
        } catch { return null; }
      }
      return { actor: grant.actor, purpose: grant.purpose };
    }
    try {
      const actor = await resolveActor(resolveAssetAuthHeaders(req.headers || {}));
      return actor ? { actor, purpose: 'user' } : null;
    } catch { return null; }
  }

  async function authorize(req, canonicalPath) {
    const context = await actorForRequest(req, canonicalPath);
    if (!context) return 401;
    // Provider grants are minted only by the internal-secret endpoint below.
    // They authorize exactly one path, for at most five minutes.
    if (context.purpose === 'provider') return 200;
    try { return await canAccessAsset(context.actor, canonicalPath) ? 200 : 403; }
    catch { return 403; }
  }

  function staticGate(prefix, { legacy = false } = {}) {
    return async function privateAssetStaticGate(req, res, next) {
      try {
        const canonicalPath = normalizePrivateAssetPath(`${prefix}/${requestPath(req).replace(/^\//, '')}`);
        if (!canonicalPath) return legacy ? next() : errorResponse(res, 400);
        const relative = canonicalPath.slice(prefix.length + 1);
        let existing;
        if (legacy) {
          existing = await containedFile(roots[prefix], relative);
          if (!existing) return next();
          if (existing.denied) return errorResponse(res, 403);
        }
        const authStatus = await authorize(req, canonicalPath);
        if (authStatus !== 200) return errorResponse(res, authStatus);
        if (!['GET', 'HEAD'].includes(req.method)) return errorResponse(res, 405);
        existing ||= await containedFile(roots[prefix], relative);
        if (existing?.denied) return errorResponse(res, 403);
        if (!existing) return errorResponse(res, 404);
        privateHeaders(res);
        // Serve the checked real path, rather than resolving an original
        // symlink a second time inside express.static.
        const originalUrl = req.url;
        req.url = `/${path.relative(existing.root, existing.file).split(path.sep).map(encodeURIComponent).join('/')}`;
        const restoreUrl = () => { req.url = originalUrl; };
        res.once('finish', restoreUrl);
        res.once('close', restoreUrl);
        return staticHandler(existing.root)(req, res, error => {
          restoreUrl();
          if (error) return errorResponse(res, error.status === 416 ? 416 : 404);
          return errorResponse(res, 404);
        });
      } catch { return errorResponse(res, 404); }
    };
  }

  async function handleAccessUrl(req, res, { provider = false } = {}) {
    privateHeaders(res);
    try {
      if (provider && !runtimeSecretMatches('INTERNAL_SECRET', req.headers?.['x-samsar-internal-secret'])) {
        return errorResponse(res, 404);
      }
      let actor = null;
      if (!provider) {
        try { actor = await resolveActor(req.headers || {}); } catch { /* fail closed */ }
        if (!actor) return errorResponse(res, 401);
      }
      const body = req.body?.input ?? req.body ?? {};
      const requestedPath = body.path ?? body.assetKey ?? body.mediaPath ?? req.query?.path ?? req.query?.mediaPath;
      const canonicalPath = normalizePrivateAssetPath(requestedPath);
      if (!canonicalPath) return errorResponse(res, 400);
      if (!provider && !await canAccessAsset(actor, canonicalPath)) return errorResponse(res, 403);
      const prefix = canonicalPath.split('/')[0];
      const existing = await containedFile(roots[prefix], canonicalPath.slice(prefix.length + 1));
      if (!existing || existing.denied) return errorResponse(res, existing?.denied ? 403 : 404);
      const base = await resolvePrivateAssetPublicBaseUrl({ purpose: provider ? 'provider' : 'user' });
      if (provider && !base) return res.status(503).json({ error: 'Public media delivery is not configured.' });
      const expiresInSeconds = provider ? PROVIDER_ASSET_TOKEN_TTL_SECONDS : PRIVATE_ASSET_TOKEN_TTL_SECONDS;
      const token = mintPrivateAssetToken({ actor, path: canonicalPath,
        purpose: provider ? 'provider' : 'user', expiresInSeconds });
      const grant = verifyPrivateAssetToken(token, { path: canonicalPath });
      const result = { url: assetUrl(base, canonicalPath, token), path: canonicalPath,
        purpose: provider ? 'provider' : 'user',
        expiresAt: grant.expiresAt, expires_at: grant.expiresAt, expires_in_seconds: expiresInSeconds };
      return res.status(200).json(typeof signResponse === 'function' ? await signResponse(result, req) : result);
    } catch { return errorResponse(res, 403); }
  }

  for (const endpoint of ['/v2/assets/access-url', '/api/v2/assets/access-url']) {
    app.get(endpoint, (req, res) => handleAccessUrl(req, res));
    app.post(endpoint, (req, res) => handleAccessUrl(req, res));
  }
  app.post('/internal/production-assets/provider-url', (req, res) => handleAccessUrl(req, res, { provider: true }));
  app.use('/assets_v2', staticGate('assets_v2'));
  app.use('/assets', staticGate('assets'));
  app.use(staticGate('assets', { legacy: true }));
  return { roots };
}
