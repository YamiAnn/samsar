import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { renderCleanupCrontab } from '../src/cron.js';
import { checkCleanupHealth } from '../src/healthcheck.js';

test('cron accepts unset, empty and selected targets without empty assignments', () => {
  for (const targets of [undefined, '', 'final-session-frames, ai-video-temp-renders']) {
    const source = renderCleanupCrontab({ CLEANUP_TARGETS: targets });
    assert.doesNotMatch(source, /^\w+=\s*$/m);
    assert.match(source, /^CLEANUP_MIN_AGE_HOURS="168"$/m);
    assert.doesNotMatch(source, /CLEANUP_FRAME_MIN_AGE_HOURS=/);
    assert.doesNotMatch(source, /CLEANUP_TEMP_MIN_AGE_HOURS=/);
    assert.match(source, /^17 \*\/3 \* \* \* root node \/app\/src\/cleanup.js /m);
    if (targets) assert.ok(source.includes(`CLEANUP_TARGETS="${targets}"`));
    else assert.doesNotMatch(source, /CLEANUP_TARGETS=/);
    assert.ok(source.endsWith('\n'));
  }
});

test('cron preserves spaces and explicit settings', () => {
  const source = renderCleanupCrontab({
    SAMSAR_ASSETS_V2_ROOT: '/media disk/assets_v2',
    CLEANUP_MIN_AGE_HOURS: '72',
    CLEANUP_FRAME_MIN_AGE_HOURS: '24',
    CLEANUP_TEMP_MIN_AGE_HOURS: '48',
    CLEANUP_STATUS_FILE: '/run/docker-cleanup/status.json',
    CLEANUP_DRY_RUN: 'true',
    CLEANUP_CRON_SCHEDULE: '0 1 * * MON',
  });
  assert.match(source, /^SAMSAR_ASSETS_V2_ROOT="\/media disk\/assets_v2"$/m);
  assert.match(source, /^CLEANUP_MIN_AGE_HOURS="72"$/m);
  assert.match(source, /^CLEANUP_FRAME_MIN_AGE_HOURS="24"$/m);
  assert.match(source, /^CLEANUP_TEMP_MIN_AGE_HOURS="48"$/m);
  assert.match(source, /^CLEANUP_STATUS_FILE="\/run\/docker-cleanup\/status.json"$/m);
  assert.match(source, /^CLEANUP_DRY_RUN="true"$/m);
  assert.match(source, /^0 1 \* \* MON root node /m);
});

test('malformed configuration cannot create extra cron entries', () => {
  for (const value of ['bad\nvalue', 'bad\rvalue', 'bad"value', 'bad\0value']) {
    assert.throws(() => renderCleanupCrontab({ CLEANUP_TARGETS: value }), /unsupported/);
  }
  for (const value of ['* * * *', '* * * * * root command', '* * * * *\n* * * * *']) {
    assert.throws(() => renderCleanupCrontab({ CLEANUP_CRON_SCHEDULE: value }), /five cron fields/);
  }
});

test('cron rejects invalid field ranges and names before scheduling cleanup', () => {
  for (const schedule of ['99 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '* * * * BOGUS', '*/0 * * * *', '5-2 * * * *', '1,,2 * * * *']) {
    assert.throws(() => renderCleanupCrontab({ CLEANUP_CRON_SCHEDULE: schedule }), /Invalid CLEANUP_CRON_SCHEDULE/);
  }
  for (const schedule of ['*/15 0-23 * JAN-MAR MON-FRI', '0,30 1-10/2 1,15 * 0,7']) {
    assert.doesNotThrow(() => renderCleanupCrontab({ CLEANUP_CRON_SCHEDULE: schedule }));
  }
});

// Run inside the cleanup image so these tests exercise the production cron
// binary and entrypoint, without mounting or touching real media volumes.
const realCron = process.env.CLEANUP_TEST_REAL_CRON === 'true';

test('production image sets separate frame and temp retention defaults', { skip: !realCron }, () => {
  assert.equal(process.env.CLEANUP_MIN_AGE_HOURS, '168');
  assert.equal(process.env.CLEANUP_FRAME_MIN_AGE_HOURS, '24');
  assert.equal(process.env.CLEANUP_TEMP_MIN_AGE_HOURS, '48');
});

test('Debian cron parses defaults, empty targets and custom target settings', { skip: !realCron }, () => {
  for (const targets of [undefined, '', 'final-session-frames, ai-video-temp-renders']) {
    const source = renderCleanupCrontab({
      CLEANUP_TARGETS: targets,
      SAMSAR_ASSETS_V2_ROOT: '/media disk/assets_v2',
    }).replace(' root node ', ' node ');
    const result = spawnSync('crontab', ['-n', '-'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('entrypoint rejects an invalid schedule before startup cleanup', { skip: !realCron }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'invalid-cleanup-cron-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cronFile = path.join(dir, 'cleanup');
  const result = spawnSync('/app/docker-entrypoint.sh', [], {
    env: { ...process.env, CLEANUP_CRON_FILE: cronFile, CLEANUP_CRON_SCHEDULE: '99 * * * *', CLEANUP_ON_START: 'true' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.error, undefined, 'invalid schedules must fail promptly');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Running startup cleanup/);
  await assert.rejects(fs.stat(cronFile), { code: 'ENOENT' });
});

test('entrypoint resets stale success when startup cleanup is disabled', { skip: !realCron }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-restart-'));
  const statusFile = path.join(dir, 'status.json');
  await fs.writeFile(statusFile, JSON.stringify({ state: 'success', completedAt: new Date().toISOString() }));
  const cron = spawn('/app/docker-entrypoint.sh', [], {
    env: {
      ...process.env,
      CLEANUP_CRON_FILE: path.join(dir, 'cron'),
      CLEANUP_STATUS_FILE: statusFile,
      CLEANUP_ON_START: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    cron.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (cron.exitCode !== null) assert.fail(`cron exited with ${cron.exitCode}`);
    const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    if (status.state === 'starting') return;
    await delay(50);
  }
  assert.fail('entrypoint did not reset old health state');
});

test('Debian cron runs cleanup with separate frame and temp retention', {
  skip: !realCron,
  timeout: 85000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-cleanup-'));
  const root = path.join(dir, 'media disk', 'assets_v2');
  const stagedRoot = path.join(dir, 'staged', 'assets_v2');
  const statusFile = path.join(dir, 'status.json');
  const cronCommFile = path.join(dir, 'cron-comm');
  await fs.writeFile(cronCommFile, 'cron\n');
  const oldFile = path.join(stagedRoot, 'ai_video/temp/old.png');
  const recentFile = path.join(stagedRoot, 'ai_video/temp/recent.png');
  const oldFrame = path.join(stagedRoot, 'video/frames/old-session/0.png');
  const recentFrame = path.join(stagedRoot, 'video/frames/recent-session/0.png');
  const finalFile = path.join(stagedRoot, 'video/output/session/final.mp4');
  for (const [file, hours] of [
    [oldFile, 49], [recentFile, 47],
    [oldFrame, 25], [recentFrame, 23],
    [finalFile, 169],
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture');
    const mtime = new Date(Date.now() - hours * 3600000);
    await fs.utimes(file, mtime, mtime);
    if (file === oldFrame || file === recentFrame) {
      await fs.utimes(path.dirname(file), mtime, mtime);
    }
  }
  const env = {
      ...process.env,
      SAMSAR_ASSETS_V2_ROOT: root,
      CLEANUP_STATUS_FILE: statusFile,
      CLEANUP_CRON_SCHEDULE: '* * * * *',
      CLEANUP_TARGETS: '',
      CLEANUP_MIN_AGE_HOURS: '',
      CLEANUP_ON_START: 'true',
      CLEANUP_DRY_RUN: 'false',
  };
  const cron = spawn('/app/docker-entrypoint.sh', [], {
    env,
    stdio: 'inherit',
  });
  t.after(async () => {
    cron.kill('SIGTERM');
    await fs.rm(dir, { recursive: true, force: true });
  });
  const startupDeadline = Date.now() + 10000;
  while (Date.now() < startupDeadline) {
    const status = await fs.readFile(statusFile, 'utf8').then(JSON.parse, (error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (status?.state === 'failure') break;
    await delay(100);
  }
  assert.equal((JSON.parse(await fs.readFile(statusFile, 'utf8'))).state, 'failure');
  assert.match(await checkCleanupHealth({ env, cronCommFile }), /failure/);
  assert.equal(cron.exitCode, null, 'cron must stay alive after startup cleanup fails');
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.rename(stagedRoot, root);
  const deployedPath = (filePath) => path.join(root, path.relative(stagedRoot, filePath));

  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    if (cron.exitCode !== null) assert.fail(`cron exited with ${cron.exitCode}`);
    const oldTempPresent = await fs.stat(deployedPath(oldFile)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const oldFramePresent = await fs.stat(deployedPath(oldFrame)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!oldTempPresent && !oldFramePresent) break;
    await delay(200);
  }
  await assert.rejects(fs.stat(deployedPath(oldFile)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(deployedPath(oldFrame)), { code: 'ENOENT' });
  await fs.stat(deployedPath(recentFile));
  await fs.stat(deployedPath(recentFrame));
  await fs.stat(deployedPath(finalFile));
  assert.equal((JSON.parse(await fs.readFile(statusFile, 'utf8'))).state, 'success');
  assert.equal(await checkCleanupHealth({ env, cronCommFile }), null);
});
