import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const rawDirectory = resolve(root, 'coverage/raw');
const requireTools = createRequire(process.env.SAMSAR_COVERAGE_TOOLS
  ? resolve(process.env.SAMSAR_COVERAGE_TOOLS, 'package.json')
  : new URL('./package.json', import.meta.url));
export const coverageTool = (name) => requireTools(name);
const { createInstrumenter } = coverageTool('istanbul-lib-instrument');
export const instrumenter = createInstrumenter({
  esModules: true,
  produceSourceMap: true,
  compact: false,
  parserPlugins: ['jsx', 'typescript'],
});
export const isSource = (filename) => filename.startsWith(resolve(root, 'src') + '/')
  && /\.(?:mjs|js|jsx|ts|tsx)$/.test(filename) && !/\.test\./.test(filename);
export function writeCoverage(coverage, kind = 'unit') {
  mkdirSync(rawDirectory, { recursive: true });
  writeFileSync(resolve(rawDirectory, `${kind}-${randomUUID()}.json`), JSON.stringify(coverage || {}));
}
export function coverageInstrumentation() {
  return {
    name: 'samsar-test-only-istanbul',
    enforce: 'pre',
    transform(source, id) {
      const filename = id.split('?')[0];
      if (!isSource(filename) || id.includes('?')) return null;
      return {
        code: instrumenter.instrumentSync(source, filename),
        map: instrumenter.lastSourceMap(),
      };
    },
  };
}
