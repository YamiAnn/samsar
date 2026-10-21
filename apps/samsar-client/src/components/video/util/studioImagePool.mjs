import { getStudioMediaIdentity } from './studioMediaIdentity.mjs';

export function createStudioImagePool({ maxEntries = 12, maxBytes = 96 * 1024 * 1024, onError } = {}) {
  const entries = new Map();
  let disposed = false;
  let preloadGeneration = 0;
  const prune = () => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      if (!entry.image) continue;
      entries.delete(key);
      bytes -= entry.bytes;
    }
  };
  return {
    audioBuffers: new Map(),
    load(url) {
      if (!url || disposed) return Promise.resolve(null);
      const key = getStudioMediaIdentity(url);
      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.promise;
      }
      const entry = {};
      entry.promise = new Promise(resolve => {
        const image = new Image();
        entry.element = image;
        image.crossOrigin = 'anonymous';
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(entry.timeout);
          image.onload = image.onerror = null;
          if (ok && !disposed) {
            entry.image = image;
            entry.bytes = (image.naturalWidth || image.width || 0) * (image.naturalHeight || image.height || 0) * 4;
            prune();
            resolve(image);
          } else {
            entries.delete(key);
            if (!disposed) onError?.(url);
            resolve(null);
          }
        };
        entry.cancel = () => { finish(false); image.src = ''; };
        image.onload = async () => {
          try { if (typeof image.decode === 'function') await image.decode(); finish(true); }
          catch { finish(false); }
        };
        image.onerror = () => finish(false);
        entry.timeout = setTimeout(() => finish(false), 15000);
        image.src = url;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    preload(urls) {
      const generation = ++preloadGeneration;
      // Keep active-scene media first and limit speculative network competition.
      const unique = [...new Set(urls.filter(Boolean))].slice(0, maxEntries);
      let cursor = 0;
      const next = async () => { while (!disposed && generation === preloadGeneration && cursor < unique.length) await this.load(unique[cursor++]); };
      return Promise.all([next(), next()]);
    },
    dispose() {
      disposed = true;
      entries.forEach(entry => { if (!entry.image) entry.cancel?.(); });
      entries.clear();
      this.audioBuffers.clear();
    },
  };
}
