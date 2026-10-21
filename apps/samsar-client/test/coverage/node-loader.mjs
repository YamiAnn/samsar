import { fileURLToPath } from 'node:url';
import { instrumenter, isSource } from './instrumentation.mjs';
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.startsWith('file:') || !isSource(fileURLToPath(url)) || loaded.source == null) return loaded;
  return { ...loaded, source: instrumenter.instrumentSync(String(loaded.source), fileURLToPath(url)) };
}
