// Credentials may rotate while the underlying asset and its content version stay
// unchanged. Resource caches are scoped to a mounted editor, never shared users.
export function getStudioMediaIdentity(value) {
  if (typeof value !== 'string' || !value) return '';
  if (/^(data:|blob:)/i.test(value)) return value;
  try {
    const absolute = /^https?:\/\//i.test(value);
    const url = new URL(value, 'https://relative-media.invalid');
    const isPrivate = url.searchParams.has('asset_token');
    const isCloudFront = url.searchParams.has('Signature') && url.searchParams.has('Key-Pair-Id');
    if (isPrivate) url.searchParams.delete('asset_token');
    if (isCloudFront) for (const key of ['Signature', 'Key-Pair-Id', 'Expires', 'Policy']) url.searchParams.delete(key);
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch { return value; }
}

// Refresh delivery grants without replacing unsaved text, timing, or ordering.
export function mergeStudioMediaCredentials(previous, incoming) {
  if (typeof previous === 'string') {
    return typeof incoming === 'string' && /asset_token=|Key-Pair-Id=/.test(incoming)
      && getStudioMediaIdentity(previous) === getStudioMediaIdentity(incoming) ? incoming : previous;
  }
  if (!previous || typeof previous !== 'object' || !incoming || typeof incoming !== 'object') return previous;
  if (Array.isArray(previous)) {
    const byId = new Map((Array.isArray(incoming) ? incoming : []).filter(value => value && typeof value === 'object')
      .map(value => [String(value._id || value.id || ''), value]));
    let changed = false;
    const values = previous.map((value, index) => {
      const id = value && typeof value === 'object' ? String(value._id || value.id || '') : '';
      const next = mergeStudioMediaCredentials(value, id ? byId.get(id) : incoming[index]);
      if (next !== value) changed = true;
      return next;
    });
    return changed ? values : previous;
  }
  let result = previous;
  for (const key of Object.keys(previous)) {
    const value = mergeStudioMediaCredentials(previous[key], incoming[key]);
    if (value !== previous[key]) {
      if (result === previous) result = { ...previous };
      result[key] = value;
    }
  }
  return result;
}
