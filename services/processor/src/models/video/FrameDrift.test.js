import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { processVideoAsFrames } from './VideoProcessor.js';

const binary = process.env.FFMPEG_PATH || ffmpegPath || 'ffmpeg';
ffmpeg.setFfmpegPath(binary);
function run(args) {
  execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
}
function hashes(folder) {
  return fs.readdirSync(folder).filter(name => /^\d+\.png$/.test(name))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map(name => createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex'));
}

for (const fps of [16, 24, 30]) {
  test(`F2P ${fps} fps: repeated extraction and compilation preserve every frame and its order`, async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-frame-drift-'));
    const assetsRoot = path.join(temporaryRoot, 'assets');
    fs.mkdirSync(assetsRoot);
    const previousRoot = process.env.SAMSAR_ASSETS_V2_ROOT;
    process.env.SAMSAR_ASSETS_V2_ROOT = assetsRoot;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.SAMSAR_ASSETS_V2_ROOT;
      else process.env.SAMSAR_ASSETS_V2_ROOT = previousRoot;
      fs.rmSync(temporaryRoot, {recursive: true, force: true});
    });
    const count = fps + 1;
    let videoPath = path.join(temporaryRoot, 'input.mkv');
    run(['-f', 'lavfi', '-i', `nullsrc=s=32x32:r=${fps},geq=lum='20+N*5':cb=128:cr=128`,
      '-frames:v', String(count), '-c:v', 'ffv1', videoPath]);
    let referenceHashes;
    for (let stage = 0; stage < 5; stage += 1) {
      const response = await processVideoAsFrames(videoPath, 'drift-session', `stage-${stage}`,
        {width: 32, height: 32}, fps);
      assert.equal(response.frameCount, count);
      assert.equal(response.duration, count / fps, 'interchange duration must retain full frame precision');
      const folder = path.dirname(response.lastFrame);
      const frameHashes = hashes(folder);
      assert.equal(frameHashes.length, count);
      assert.equal(new Set(frameHashes).size, count, 'each source frame has a distinct identity');
      if (referenceHashes) assert.deepEqual(frameHashes, referenceHashes, `frame sequence drifted at stage ${stage}`);
      else referenceHashes = frameHashes;
      videoPath = path.join(temporaryRoot, `stage-${stage}.mkv`);
      run(['-framerate', String(fps), '-start_number', '0', '-i', path.join(folder, '%d.png'),
        '-frames:v', String(count), '-c:v', 'ffv1', '-pix_fmt', 'bgr0', videoPath]);
    }
  });
}

test('P2P explicit 30 fps whole-second clips retain their duration and boundaries', async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-frame-compatible-'));
  const previousRoot = process.env.SAMSAR_ASSETS_V2_ROOT;
  process.env.SAMSAR_ASSETS_V2_ROOT = temporaryRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.SAMSAR_ASSETS_V2_ROOT;
    else process.env.SAMSAR_ASSETS_V2_ROOT = previousRoot;
    fs.rmSync(temporaryRoot, {recursive:true, force:true});
  });
  const videoPath = path.join(temporaryRoot, 'input.mkv');
  run(['-f','lavfi','-i','testsrc2=s=32x32:r=30','-frames:v','30','-c:v','ffv1',videoPath]);
  const result = await processVideoAsFrames(videoPath, 'compatible-session', 'layer', {width:32,height:32}, 30);
  assert.equal(result.frameCount, 30);
  assert.equal(result.duration, 1);
  assert.equal(path.basename(result.firstFrame), '0.png');
  assert.equal(path.basename(result.lastFrame), '29.png');
});
