import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const unit = [
  'test/unit/StudioTimelineF2P.test.jsx', 'test/unit/StudioToolbarF2P.test.jsx',
  'test/unit/StudioSessionF2P.test.jsx', 'test/unit/StudioMediaF2P.test.jsx', 'test/unit/StudioWaveformF2P.test.jsx',
  'test/unit/StudioMenuF2P.test.jsx',
];
const suites = [
  ['--test', 'src/components/oneshot_editor/previewReadiness.f2p.test.mjs', 'src/components/video/util/studioImagePool.test.mjs'],
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.mjs', ...unit],
];
if (!process.argv.includes('--unit')) suites.push([
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.browser.config.mjs', 'test/browser/StudioLayoutF2P.test.jsx',
]);
let failed = false;
for (const args of suites) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0 || result.error) failed = true;
}
process.exitCode = failed ? 1 : 0;
