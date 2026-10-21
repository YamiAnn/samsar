// Private media credentials are scoped to a processor path. Keep their query
// string when a legacy static URL is normalized for playback or preview.
export function resolvePrivateMediaUrl(value, {
  processorApiUrl = '',
  staticCdnUrl = 'https://static.samsar.one',
} = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmedValue = value.trim();
  const processorBaseUrl = typeof processorApiUrl === 'string'
    ? processorApiUrl.trim().replace(/\/+$/, '')
    : '';

  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(trimmedValue) || trimmedValue.startsWith('//');
    const parsedUrl = new URL(trimmedValue, 'https://relative-media.invalid/');
    if (!parsedUrl.searchParams.get('asset_token')) {
      return null;
    }
    if (isAbsolute) {
      if (!/^https?:$/.test(parsedUrl.protocol)) return null;
      const allowedHosts = ['static.samsar.one'];
      for (const baseUrl of [staticCdnUrl, processorBaseUrl]) {
        if (baseUrl) allowedHosts.push(new URL(baseUrl).host.toLowerCase());
      }
      if (!allowedHosts.includes(parsedUrl.host.toLowerCase())) return null;
    }
    return `${processorBaseUrl}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return null;
  }
}
