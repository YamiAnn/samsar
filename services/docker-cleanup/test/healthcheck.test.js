import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCleanupHealth, evaluateCleanupHealth } from '../src/healthcheck.js';

test('health fails on cleanup failure, stale success, and missing cron', () => {
  const nowMs = Date.parse('2026-10-22T16:00:00Z');
  const freshSuccess = { state: 'success', completedAt: new Date(nowMs - 3_600_000).toISOString() };
  assert.equal(evaluateCleanupHealth(freshSuccess, { nowMs }), null);
  assert.match(evaluateCleanupHealth({ state: 'failure' }, { nowMs }), /failure/);
  assert.equal(evaluateCleanupHealth({ state: 'running', startedAt: new Date(nowMs - 10 * 60_000).toISOString() }, { nowMs }), null);
  assert.match(evaluateCleanupHealth({ state: 'running', startedAt: new Date(nowMs - 31 * 60_000).toISOString() }, { nowMs }), /run limit/);
  assert.match(evaluateCleanupHealth({ state: 'running' }, { nowMs }), /invalid/);
  assert.match(evaluateCleanupHealth(freshSuccess, { nowMs, cronProcessName: 'sh' }), /cron/);
  assert.match(evaluateCleanupHealth({ ...freshSuccess, completedAt: new Date(nowMs - 5 * 3_600_000).toISOString() }, { nowMs }), /stale/);
  assert.match(evaluateCleanupHealth({ ...freshSuccess, completedAt: 'bad' }, { nowMs }), /invalid/);
  assert.match(evaluateCleanupHealth({ ...freshSuccess, completedAt: new Date(nowMs + 120_000).toISOString() }, { nowMs }), /future/);
});

test('CLI cleanup records failed and recovered attempts for the healthcheck', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assetsV2Root = path.join(dir, 'assets_v2');
  const statusFile = path.join(dir, 'status', 'cleanup.json');
  const cronCommFile = path.join(dir, 'cron-comm');
  await fs.writeFile(cronCommFile, 'cron\n');
  const env = {
    ...process.env,
    SAMSAR_ASSETS_V2_ROOT: assetsV2Root,
    CLEANUP_STATUS_FILE: statusFile,
  };

  const failed = spawnSync(process.execPath, ['src/cleanup.js'], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.equal((JSON.parse(await fs.readFile(statusFile, 'utf8'))).state, 'failure');
  assert.match(await checkCleanupHealth({ env, cronCommFile }), /failure/);

  await fs.mkdir(assetsV2Root);
  const preview = spawnSync(process.execPath, ['src/cleanup.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...env, CLEANUP_DRY_RUN: 'true' }, encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal((JSON.parse(await fs.readFile(statusFile, 'utf8'))).state, 'failure', 'a dry run must not mask a failed real cleanup');
  assert.match(await checkCleanupHealth({ env, cronCommFile }), /failure/);

  const recovered = spawnSync(process.execPath, ['src/cleanup.js'], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal((JSON.parse(await fs.readFile(statusFile, 'utf8'))).state, 'success');
  assert.equal(await checkCleanupHealth({ env, cronCommFile }), null);
  assert.deepEqual((await fs.readdir(path.dirname(statusFile))).sort(), ['cleanup.json']);
});

test('health rejects missing, malformed, or unusable status configuration', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const statusFile = path.join(dir, 'status.json');
  const cronCommFile = path.join(dir, 'cron-comm');
  await fs.writeFile(cronCommFile, 'cron\n');
  const env = { CLEANUP_STATUS_FILE: statusFile };
  assert.match(await checkCleanupHealth({ env, cronCommFile }), /unavailable/);
  await fs.writeFile(statusFile, '{');
  assert.match(await checkCleanupHealth({ env, cronCommFile }), /unavailable/);
  assert.match(await checkCleanupHealth({ env: { ...env, CLEANUP_HEALTH_MAX_AGE_HOURS: '0' }, cronCommFile }), /positive number/);
  assert.match(await checkCleanupHealth({ env: { ...env, CLEANUP_HEALTH_MAX_RUN_HOURS: '0' }, cronCommFile }), /positive number/);
});
