import assert from 'node:assert/strict';
import test from 'node:test';
import { getCleanupMinAgeHours, getProcessorAssetsRoot } from '../src/CleanupConfig.js';
import { getTaskProcessorSchedule } from '../src/TaskScheduler.js';

test('hosted and standalone containers use mounted media paths and recurring maintenance', () => {
  for (const runtime of ['docker', 'container', 'compose', 'kubernetes', 'k8s']) {
    for (const edition of ['production', 'standalone']) {
      const env = { SAMSAR_RUNTIME: runtime, CURRENT_ENV: edition };
      for (const folder of ['assets', 'assets_v2']) {
        assert.equal(getProcessorAssetsRoot(folder, { env, dockerMarkerPresent: false }), `/${folder}`);
      }
      assert.equal(getTaskProcessorSchedule(env, false).intervalMs, 3 * 3600000);
    }
  }
  assert.equal(getProcessorAssetsRoot('assets_v2', { env: {}, dockerMarkerPresent: true }), '/assets_v2');
});

test('native cron paths follow the installed sources, independent of its working directory', () => {
  for (const [projectRoot, expectedRoot] of [
    ['/srv/workspace/samsar_task_processor', '/srv/workspace/samsar_processor'],
    ['/srv/samsar/services/task-processor', '/srv/samsar/services/processor'],
  ]) {
    for (const folder of ['assets', 'assets_v2']) {
      assert.equal(getProcessorAssetsRoot(folder, {
        env: {}, dockerMarkerPresent: false, projectRoot,
      }), `${expectedRoot}/${folder}`);
    }
  }
});

test('explicit media roots override native and container defaults', () => {
  for (const dockerMarkerPresent of [true, false]) {
    const options = { env: { SAMSAR_ASSETS_ROOT: '/mnt/assets', SAMSAR_ASSETS_V2_ROOT: '/mnt/assets_v2' }, dockerMarkerPresent };
    assert.equal(getProcessorAssetsRoot('assets', options), '/mnt/assets');
    assert.equal(getProcessorAssetsRoot('assets_v2', options), '/mnt/assets_v2');
  }
});

test('both cleanup stages inherit the shared retention unless explicitly overridden', () => {
  for (const setting of ['STALE_SESSION_FRAME_CLEANUP_HOURS', 'INTERMEDIATE_MEDIA_CLEANUP_HOURS']) {
    assert.equal(getCleanupMinAgeHours(setting, {}), 168);
    assert.equal(getCleanupMinAgeHours(setting, { CLEANUP_MIN_AGE_HOURS: '72' }), 72);
    assert.equal(getCleanupMinAgeHours(setting, { CLEANUP_MIN_AGE_HOURS: '72', [setting]: '' }), 72);
    assert.equal(getCleanupMinAgeHours(setting, { CLEANUP_MIN_AGE_HOURS: '72', [setting]: '96' }), 96);
    for (const value of ['invalid', '24hours', '0', '-1', 'Infinity']) {
      assert.throws(() => getCleanupMinAgeHours(setting, { CLEANUP_MIN_AGE_HOURS: value }), /positive number/);
      assert.throws(() => getCleanupMinAgeHours(setting, { [setting]: value }), /positive number/);
    }
  }
});
