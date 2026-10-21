import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { renderCleanupCrontab } from '../src/cron.js';

test('cron accepts unset, empty and selected targets without empty assignments', () => {
  for (const targets of [undefined, '', 'final-session-frames, ai-video-temp-renders']) {
    const source = renderCleanupCrontab({ CLEANUP_TARGETS: targets });
    assert.doesNotMatch(source, /^\w+=\s*$/m);
    assert.match(source, /^CLEANUP_MIN_AGE_HOURS="168"$/m);
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
    CLEANUP_DRY_RUN: 'true',
    CLEANUP_CRON_SCHEDULE: '0 1 * * MON',
  });
  assert.match(source, /^SAMSAR_ASSETS_V2_ROOT="\/media disk\/assets_v2"$/m);
  assert.match(source, /^CLEANUP_MIN_AGE_HOURS="72"$/m);
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

test('Debian cron actually runs cleanup with empty targets and seven-day retention', {
  skip: !realCron,
  timeout: 75000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-cleanup-'));
  const root = path.join(dir, 'media disk', 'assets_v2');
  const oldFile = path.join(root, 'ai_video/temp/old.png');
  const recentFile = path.join(root, 'ai_video/temp/recent.png');
  const finalFile = path.join(root, 'video/output/session/final.mp4');
  for (const [file, hours] of [[oldFile, 169], [recentFile, 167], [finalFile, 169]]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture');
    const mtime = new Date(Date.now() - hours * 3600000);
    await fs.utimes(file, mtime, mtime);
  }
  const cron = spawn('/app/docker-entrypoint.sh', [], {
    env: {
      ...process.env,
      SAMSAR_ASSETS_V2_ROOT: root,
      CLEANUP_CRON_SCHEDULE: '* * * * *',
      CLEANUP_TARGETS: '',
      CLEANUP_MIN_AGE_HOURS: '',
      CLEANUP_ON_START: 'false',
      CLEANUP_DRY_RUN: 'false',
    },
    stdio: 'inherit',
  });
  t.after(async () => {
    cron.kill('SIGTERM');
    await fs.rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    if (cron.exitCode !== null) assert.fail(`cron exited with ${cron.exitCode}`);
    const present = await fs.stat(oldFile).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!present) break;
    await delay(200);
  }
  await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
  await fs.stat(recentFile);
  await fs.stat(finalFile);
});
