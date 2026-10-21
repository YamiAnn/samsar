import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { processVideoAsFrames } from './VideoProcessor.js';

ffmpeg.setFfmpegPath(ffmpegPath);
for (const rate of ['24000/1001', '30000/1001']) {
  for (const fps of [16, 24, 30]) {
    test(`F2P: ${rate} source has one nearest-boundary ${fps} FPS frame budget`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-source-fps-f2p-'));
      const previousRoot = process.env.SAMSAR_ASSETS_V2_ROOT;
      process.env.SAMSAR_ASSETS_V2_ROOT = root;
      t.after(() => {
        if (previousRoot === undefined) delete process.env.SAMSAR_ASSETS_V2_ROOT;
        else process.env.SAMSAR_ASSETS_V2_ROOT = previousRoot;
        fs.rmSync(root, { recursive: true, force: true });
      });
      const input = path.join(root, 'source.mkv');
      execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        `testsrc2=s=32x32:r=${rate}`, '-t', '2', '-c:v', 'ffv1', input], { stdio: 'pipe' });
      const result = await processVideoAsFrames(input, 'session', 'layer', { width: 32, height: 32 }, fps);
      assert.equal(result.frameCount, Math.round(2.002 * fps));
      assert.equal(result.duration, result.frameCount / fps);
      assert.equal(path.basename(result.lastFrame), `${result.frameCount - 1}.png`);
    });
  }
}
