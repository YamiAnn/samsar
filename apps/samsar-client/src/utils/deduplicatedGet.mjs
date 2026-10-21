const requestsByClient = new WeakMap();

function stableEntries(value = {}) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

// Share only requests that are still running. Never cache private responses,
// and never combine requests from different authentication contexts.
export function deduplicatedGet(client, url, config = {}) {
  config = config || {};
  if (config.signal || config.cancelToken) return client.get(url, config);
  const resource = new URL(url, 'https://relative-request.invalid');
  resource.searchParams.delete('cacheBust');
  const params = { ...config.params };
  delete params.cacheBust;
  const key = JSON.stringify([
    resource.href,
    stableEntries(params),
    stableEntries(config.headers),
    config.withCredentials,
    config.responseType,
    config.timeout,
  ]);
  let requests = requestsByClient.get(client);
  if (!requests) {
    requests = new Map();
    requestsByClient.set(client, requests);
  }
  if (requests.has(key)) return requests.get(key);
  const request = Promise.resolve().then(() => client.get(url, config));
  const pending = request.finally(() => {
    if (requests.get(key) === pending) requests.delete(key);
  });
  requests.set(key, pending);
  return pending;
}
