const SIGNER_ROUTE = '/internal/production-assets/provider-url';
const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(normalizeString(value).toLowerCase());
}

function usesExternalMedia(env) {
  const mode = normalizeString(env.SAMSAR_MEDIA_DELIVERY_MODE || env.MEDIA_DELIVERY_MODE).toLowerCase();
  if (['s3-cloudfront', 'external-s3'].includes(mode)) return true;
  if (['docker-local', 'local-filesystem'].includes(mode)) return false;
  return isTruthy(env.SAMSAR_EXTERNAL_MEDIA_PUBLISH_ENABLED || env.EXTERNAL_MEDIA_PUBLISH_ENABLED);
}

function canonicalAssetPath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 8192
    || value.startsWith('//') || /%2f|%5c/i.test(value)) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\\\0\r\n?#%]/.test(decoded)) return null;
  const parts = decoded.replace(/^\//, '').split('/');
  if (!['assets', 'assets_v2'].includes(parts[0]) || parts.length < 2
    || parts.some(part => !part || part.startsWith('.'))) return null;
  return parts.join('/');
}

function isPrivateOrLocalHostname(hostname) {
  const value = normalizeString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!value || value === 'localhost' || value.endsWith('.localhost')
    || value.endsWith('.local') || value.endsWith('.internal')
    || value.endsWith('.invalid') || !value.includes('.')) return true;
  const octets = value.split('.').map(Number);
  if (octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b));
  }
  // Literal IPv6 addresses are rejected here; signer deployments use a public
  // hostname, and this also excludes IPv4-mapped and link-local variants.
  return value.includes(':');
}

function allowedProviderUrl(value, mediaPath, now = Date.now()) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
      || isPrivateOrLocalHostname(parsed.hostname)
      || canonicalAssetPath(parsed.pathname) !== mediaPath) return null;
    const tokens = parsed.searchParams.getAll('asset_token');
    if (tokens.length !== 1 || tokens[0].length > 8192) return null;
    const segments = tokens[0].split('.');
    if (segments.length !== 3 || segments.some(segment => !segment)) return null;
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    const currentSeconds = Math.floor(now / 1000);
    if (claims.purpose !== 'provider' || canonicalAssetPath(claims.path) !== mediaPath
      || !Number.isInteger(claims.exp) || claims.exp <= currentSeconds
      || claims.exp > currentSeconds + 3600
      || !Number.isInteger(claims.iat) || claims.iat > currentSeconds + 30
      || claims.exp <= claims.iat) return null;
    return parsed;
  } catch { return null; }
}

function signerEndpoint(env) {
  const runtime = normalizeString(env.SAMSAR_RUNTIME || env.SAMSAR_DEPLOYMENT_RUNTIME).toLowerCase();
  const docker = runtime ? ['docker', 'container', 'compose'].includes(runtime)
    : ['docker', 'community', 'standalone', 'staging'].includes(normalizeString(env.CURRENT_ENV).toLowerCase())
      || Boolean(env.SAMSAR_ASSETS_ROOT || env.SAMSAR_ASSETS_V2_ROOT);
  const configured = normalizeString(env.SAMSAR_PRODUCTION_ASSET_SIGNER_URL);
  const parsed = new URL(configured || `http://${docker ? 'processor' : 'localhost'}:3002${SIGNER_ROUTE}`);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) throw new Error('The private asset signer URL is invalid.');
  return parsed.toString();
}

function buildError(message, mediaPath, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'SamsarPrivateAssetUrlError';
  error.code = 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE';
  error.retryable = true;
  error.mediaPath = mediaPath;
  return error;
}

async function cancelBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    else if (typeof response?.body?.destroy === 'function') response.body.destroy();
  } catch {}
}

/** Resolve private local media through the trusted signer before provider dispatch. */
export async function resolvePrivateProviderAssetUrl({
  mediaPath,
  expectedContentTypePrefix = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  if (typeof mediaPath !== 'string' || !/^\/?assets(?:_v2)?\//.test(mediaPath)) return null;
  const internalSecret = normalizeString(env.INTERNAL_SECRET);
  if (internalSecret.length < 32 || /^change-me/i.test(internalSecret) || usesExternalMedia(env)) return null;
  const normalizedPath = canonicalAssetPath(mediaPath);
  if (!normalizedPath) throw buildError('The private provider asset path is invalid.', mediaPath);
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for private assets.');
  const contentTypePrefix = normalizeString(expectedContentTypePrefix).toLowerCase();
  if (contentTypePrefix && !contentTypePrefix.endsWith('/')) {
    throw new TypeError('expectedContentTypePrefix must be a MIME type prefix ending in /.');
  }

  const configuredTimeout = Number(env.SAMSAR_PRODUCTION_ASSET_SIGNER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 100
    ? Math.min(Math.floor(configuredTimeout), 30_000) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let phase = 'signer';
  try {
    // Never derive this endpoint from media candidates, or follow a redirect
    // that could forward the internal credential to another origin.
    const response = await fetchImpl(signerEndpoint(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-samsar-internal-secret': internalSecret },
      body: JSON.stringify({ mediaPath: normalizedPath }),
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 0;
      const detail = status === 503 && payload?.error === 'Public media delivery is not configured.'
        ? ' Public media delivery is not configured.' : '';
      const error = buildError(`The private asset signer returned HTTP ${status || 'unknown'}.${detail}`, normalizedPath);
      error.status = status;
      error.tunnelRefreshRequired = [502, 503, 504].includes(status);
      throw error;
    }
    const signedUrl = allowedProviderUrl(payload?.url, normalizedPath);
    if (!signedUrl || payload.url.includes(internalSecret)) {
      throw buildError('The private asset signer did not return an allowed provider URL.', normalizedPath);
    }
    phase = 'probe';
    const probe = await fetchImpl(signedUrl.toString(), {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const contentType = normalizeString(probe.headers?.get?.('content-type')).toLowerCase();
    const validFinalUrl = allowedProviderUrl(probe.url || signedUrl.toString(), normalizedPath);
    await cancelBody(probe);
    if ((!probe.ok && probe.status !== 206) || !validFinalUrl
      || validFinalUrl.toString() !== signedUrl.toString()
      || (contentTypePrefix && !contentType.startsWith(contentTypePrefix))) {
      const error = buildError('The private provider URL failed its exact media probe.', normalizedPath);
      error.status = probe.status;
      error.tunnelRefreshRequired = true;
      throw error;
    }
    return signedUrl.toString();
  } catch (cause) {
    if (cause?.code === 'SAMSAR_PRIVATE_ASSET_URL_UNREACHABLE') throw cause;
    const error = buildError('The private provider URL could not be created or probed.', normalizedPath, cause);
    error.tunnelRefreshRequired = phase === 'probe';
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
