import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupAssetsV2 } from '../src/cleanup.js';

async function writeFileWithAge(filePath, contents, mtimeMs) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  const mtime = new Date(mtimeMs);
  await fs.utimes(filePath, mtime, mtime);
}

async function setTreeMtime(rootPath, mtimeMs) {
  const mtime = new Date(mtimeMs);
  let entries = [];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await setTreeMtime(entryPath, mtimeMs);
    }
    await fs.utimes(entryPath, mtime, mtime);
  }
  await fs.utimes(rootPath, mtime, mtime);
}

test('cleanup removes stale frame transformations and preserves protected assets', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-cleanup-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const assetsV2Root = path.join(tempRoot, 'assets_v2');
  const nowMs = Date.parse('2026-07-06T00:00:00.000Z');
  const oldMs = nowMs - 25 * 60 * 60 * 1000;
  const recentMs = nowMs - 23 * 60 * 60 * 1000;

  await writeFileWithAge(path.join(assetsV2Root, 'video/frames/old-session/layer-a/0.png'), 'old frame', oldMs);
  await setTreeMtime(path.join(assetsV2Root, 'video/frames/old-session'), oldMs);

  await writeFileWithAge(path.join(assetsV2Root, 'ai_video/frames/old-ai-session/layer-a/audio_video/0.png'), 'old ai frame', oldMs);
  await setTreeMtime(path.join(assetsV2Root, 'ai_video/frames/old-ai-session'), oldMs);

  await writeFileWithAge(path.join(assetsV2Root, 'video/narrator_avatar/frames/old-avatar-session/layer-a/0.png'), 'old avatar frame', oldMs);
  await setTreeMtime(path.join(assetsV2Root, 'video/narrator_avatar/frames/old-avatar-session'), oldMs);

  await writeFileWithAge(path.join(assetsV2Root, 'ai_video/temp/old-render.png'), 'old temp render', oldMs);
  await writeFileWithAge(path.join(assetsV2Root, 'video/frames/recent-session/layer-a/0.png'), 'recent frame', recentMs);
  await setTreeMtime(path.join(assetsV2Root, 'video/frames/recent-session'), recentMs);
  await writeFileWithAge(path.join(assetsV2Root, 'video/output/old-session/final.mp4'), 'final render', oldMs);
  await writeFileWithAge(path.join(assetsV2Root, 'video/output/old-session/manifest.json'), 'keep metadata', oldMs);
  await writeFileWithAge(path.join(assetsV2Root, 'video/output/recent-session/final.mp4'), 'recent final render', recentMs);
  await writeFileWithAge(path.join(assetsV2Root, 'generations/old-session/generated.png'), 'api generated image', oldMs);
  await writeFileWithAge(path.join(assetsV2Root, 'ai_video/generations/old-session/generated.mp4'), 'generated ai video', oldMs);
  await writeFileWithAge(path.join(assetsV2Root, 'user_resources/user-1/ai_videos/old-session/video.mp4'), 'returned video', oldMs);

  const counters = await cleanupAssetsV2({
    assetsV2Root,
    minAgeHours: 24,
    nowMs,
    env: {},
  });

  await assert.rejects(fs.stat(path.join(assetsV2Root, 'video/frames/old-session')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(assetsV2Root, 'ai_video/frames/old-ai-session')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(assetsV2Root, 'video/narrator_avatar/frames/old-avatar-session')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(assetsV2Root, 'ai_video/temp/old-render.png')), { code: 'ENOENT' });

  await fs.stat(path.join(assetsV2Root, 'video/frames/recent-session/layer-a/0.png'));
  await fs.stat(path.join(assetsV2Root, 'video/output/old-session/final.mp4'));
  await fs.stat(path.join(assetsV2Root, 'video/output/old-session/manifest.json'));
  await fs.stat(path.join(assetsV2Root, 'video/output/recent-session/final.mp4'));
  await fs.stat(path.join(assetsV2Root, 'generations/old-session/generated.png'));
  await fs.stat(path.join(assetsV2Root, 'ai_video/generations/old-session/generated.mp4'));
  await fs.stat(path.join(assetsV2Root, 'user_resources/user-1/ai_videos/old-session/video.mp4'));

  assert.equal(counters.deletedDirectories, 3);
  assert.equal(counters.deletedFiles, 4);
  assert.equal(counters.errors.length, 0);
});

test('cleanup refuses unknown target paths', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-cleanup-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const assetsV2Root = path.join(tempRoot, 'assets_v2');

  await assert.rejects(
    cleanupAssetsV2({
      assetsV2Root,
      targets: 'video/audio',
    }),
    /Unsupported CLEANUP_TARGETS entry/,
  );
});

test('default retention preserves recent media and dry-run leaves empty directories intact', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-cleanup-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const assetsV2Root = path.join(tempRoot, 'assets_v2');
  const oldFile = path.join(assetsV2Root, 'ai_video/temp/old.png');
  const recentFile = path.join(assetsV2Root, 'ai_video/temp/recent.png');
  const emptyDir = path.join(assetsV2Root, 'ai_video/temp/empty');
  const nowMs = Date.now();
  await writeFileWithAge(oldFile, 'old', nowMs - 169 * 3600000);
  await writeFileWithAge(recentFile, 'recent', nowMs - 167 * 3600000);
  await fs.mkdir(emptyDir);

  const preview = await cleanupAssetsV2({ assetsV2Root, nowMs, env: {}, dryRun: true });
  assert.equal(preview.wouldDeleteFiles, 1);
  assert.equal(preview.deletedFiles, 0);
  await fs.stat(oldFile);
  await fs.stat(emptyDir);
  const result = await cleanupAssetsV2({ assetsV2Root, nowMs, env: {} });
  assert.equal(result.deletedFiles, 1);
  await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
  await fs.stat(recentFile);
});

test('frame and temp overrides apply independently without touching final media', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-cleanup-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const assetsV2Root = path.join(tempRoot, 'assets_v2');
  const nowMs = Date.parse('2026-10-22T00:00:00.000Z');
  const frameRoots = [
    'video/frames',
    'ai_video/frames',
    'video/narrator_avatar/frames',
    'video/narrator_avatar/joined_frames',
  ];

  for (const frameRoot of frameRoots) {
    for (const [sessionId, hours] of [['old-session', 25], ['recent-session', 23]]) {
      const sessionPath = path.join(assetsV2Root, frameRoot, sessionId);
      await writeFileWithAge(path.join(sessionPath, '0.png'), 'frame', nowMs - hours * 3600000);
      await setTreeMtime(sessionPath, nowMs - hours * 3600000);
    }
  }
  const oldTempFile = path.join(assetsV2Root, 'ai_video/temp/old.png');
  const recentTempFile = path.join(assetsV2Root, 'ai_video/temp/recent.png');
  const finalFile = path.join(assetsV2Root, 'video/output/old-session/final.mp4');
  await writeFileWithAge(oldTempFile, 'temp', nowMs - 49 * 3600000);
  await writeFileWithAge(recentTempFile, 'temp', nowMs - 47 * 3600000);
  await writeFileWithAge(finalFile, 'final', nowMs - 200 * 3600000);

  const counters = await cleanupAssetsV2({
    assetsV2Root,
    nowMs,
    env: {
      CLEANUP_MIN_AGE_HOURS: '168',
      CLEANUP_FRAME_MIN_AGE_HOURS: '24',
      CLEANUP_TEMP_MIN_AGE_HOURS: '48',
    },
  });

  for (const frameRoot of frameRoots) {
    await assert.rejects(fs.stat(path.join(assetsV2Root, frameRoot, 'old-session')), { code: 'ENOENT' });
    await fs.stat(path.join(assetsV2Root, frameRoot, 'recent-session', '0.png'));
  }
  await assert.rejects(fs.stat(oldTempFile), { code: 'ENOENT' });
  await fs.stat(recentTempFile);
  await fs.stat(finalFile);
  assert.equal(counters.deletedDirectories, 4);
  assert.equal(counters.deletedFiles, 5);
  assert.deepEqual(counters.errors, []);
});

test('invalid per-target retention fails before cleanup', async () => {
  for (const [name, value] of [
    ['CLEANUP_FRAME_MIN_AGE_HOURS', '0'],
    ['CLEANUP_FRAME_MIN_AGE_HOURS', 'abc'],
    ['CLEANUP_TEMP_MIN_AGE_HOURS', '-1'],
    ['CLEANUP_TEMP_MIN_AGE_HOURS', 'Infinity'],
  ]) {
    await assert.rejects(
      cleanupAssetsV2({ env: { [name]: value } }),
      new RegExp(`${name} must be a positive number`),
    );
  }
});

test('missing media mounts fail instead of reporting a successful empty cleanup', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'samsar-cleanup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(cleanupAssetsV2({ assetsV2Root: path.join(dir, 'assets_v2') }), { code: 'ENOENT' });
});
