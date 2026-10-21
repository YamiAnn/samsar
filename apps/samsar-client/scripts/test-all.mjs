import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suites = [
  { name: 'node', args: ['scripts/test-node.mjs'] },
  { name: 'unit', args: ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.mjs'] },
  { name: 'chromium', args: ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.config.mjs'] },
];

export function runClientSuites(run) {
  return suites.map(({ name, args }) => {
    try {
      const result = run(args);
      return {
        suite: name,
        exitCode: result.status ?? 1,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.error ? { error: result.error.message } : {}),
      };
    } catch (error) {
      return { suite: name, exitCode: 1, error: error.message };
    }
  });
}

if (import.meta.url.startsWith('file:') && process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const results = runClientSuites((args) => spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }));
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(resolve(root, 'test-results/all-suites.json'), JSON.stringify(results, null, 2) + '\n');
  process.exitCode = results.some(({ exitCode }) => exitCode !== 0) ? 1 : 0;
}
