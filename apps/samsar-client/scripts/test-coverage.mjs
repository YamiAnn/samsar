import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coverageTool, instrumenter, isSource, root, rawDirectory } from '../test/coverage/instrumentation.mjs';

const { createCoverageMap } = coverageTool('istanbul-lib-coverage');
const { createContext } = coverageTool('istanbul-lib-report');
const reports = coverageTool('istanbul-reports');
const reportDirectory = resolve(root, 'coverage');
const results = [];
if (!process.argv.includes('--report-only')) {
  await rm(reportDirectory, { recursive: true, force: true });
  await mkdir(rawDirectory, { recursive: true });
  const files = (await readdir(resolve(root, 'src'), { recursive: true }))
    .filter((file) => file.endsWith('.test.mjs')).sort().map((file) => resolve(root, 'src', file));
  const tasks = [
    ['node', ['--import', './test/coverage/node-register.mjs', '--test', ...files]],
    ['unit', ['./node_modules/vitest/vitest.mjs', 'run', '--config', './test/coverage/vitest.unit.config.mjs', '--reporter=default', '--reporter=json', '--outputFile.json=coverage/unit-results.json']],
    ['chromium', ['./node_modules/vitest/vitest.mjs', 'run', '--config', './test/coverage/vitest.browser.config.mjs', '--reporter=default', '--reporter=json', '--outputFile.json=coverage/chromium-results.json']],
  ];
  // Always run every tier, even when an earlier tier finds a regression.
  for (const [suite, args] of tasks) {
    const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_PROCESSOR_API: '', VITE_STATIC_CDN_URL: '' } });
    results.push({ suite, exitCode: run.status ?? 1, error: run.error?.message });
  }
  await writeFile(resolve(reportDirectory, 'run-results.json'), JSON.stringify(results, null, 2));
} else {
  results.push(...JSON.parse(await readFile(resolve(reportDirectory, 'run-results.json'), 'utf8')));
}
const map = createCoverageMap({});
// Seed ALL application files with zero counters so untouched legacy screens count.
for (const file of (await readdir(resolve(root, 'src'), { recursive: true })).sort()) {
  const filename = resolve(root, 'src', file);
  if (!isSource(filename)) continue;
  instrumenter.instrumentSync(await readFile(filename, 'utf8'), filename);
  map.addFileCoverage(instrumenter.lastFileCoverage());
}
for (const file of await readdir(rawDirectory)) {
  if (file.endsWith('.json')) map.merge(JSON.parse(await readFile(resolve(rawDirectory, file), 'utf8')));
}
const context = createContext({ dir: reportDirectory, coverageMap: map });
for (const reporter of ['text-summary', 'json', 'json-summary', 'lcovonly', 'html']) reports.create(reporter).execute(context);
const summary = map.getCoverageSummary().toJSON();
await writeFile(resolve(reportDirectory, 'coverage-scope.json'), JSON.stringify({
  fileCount: map.files().length,
  include: 'src/**/*.{js,jsx,mjs,ts,tsx}',
  exclude: 'src/**/*.test.* (styles and assets are not executable code)',
  suites: results,
  summary,
}, null, 2));
if (results.some((result) => result.exitCode)) process.exitCode = 1;
if (process.argv.includes('--check') && (summary.lines.pct < 98 || summary.branches.pct < 98)) {
  console.error('Near-100% target not met: lines and branches must each reach 98%.');
  process.exitCode = 1;
}
