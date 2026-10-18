import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ffmpeg from 'fluent-ffmpeg';
import { secondsToFrameCount, frameCountToSeconds } from './utils/FrameClock.js';

const binary = process.env.FFMPEG_PATH || 'ffmpeg';
ffmpeg.setFfmpegPath(binary);
const source = fs.readFileSync(new URL('./GenerationProcessor.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderAndSaveVideoOnce(payload)');
const implementation = source.slice(start, source.indexOf('\n}', start) + 2);
const context = vm.createContext({
  ffmpeg, console, secondsToFrameCount, frameCountToSeconds,
  DEFAULT_FRAMES_PER_SECOND: 24,
  normalizeFramesPerSecond: value => [16,24,30].includes(Number(value)) ? Number(value) : null,
  shouldUseStudioPeakSidechainDucking: () => false,
  resolveFinalRenderFfmpegThreads: () => 1,
  attachFFmpegProcess: () => {},
  formatFFmpegNumber: value => String(Number(Number(value).toFixed(6))),
});
const render = vm.runInContext(`${implementation}\n;renderAndSaveVideoOnce;`, context);
function run(args) {
  return execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 });
}
for (const fps of [16,24,30]) {
  test(`P2P final ${fps} fps renderer retains frame identities over repeated studio renders`, async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'samsar-final-frame-drift-'));
    t.after(() => fs.rmSync(temporaryRoot, {recursive:true,force:true}));
    const count = fps + 1;
    let framePath = path.join(temporaryRoot,'source');
    fs.mkdirSync(framePath);
    run(['-f','lavfi','-i',`nullsrc=s=32x32:r=${fps},geq=lum='20+N*5':cb=128:cr=128`,
      '-frames:v',String(count),'-start_number','0',path.join(framePath,'%d.png')]);
    for(let stage=0;stage<4;stage+=1) {
      const outputPath=path.join(temporaryRoot,`render-${stage}.mp4`);
      await render({duration:count/fps,framePath,outputPath,audioList:[],framesPerSecond:fps,
        applyAudioDucking:false,isExpressGeneration:false,outroImagePath:null});
      const metadata = await new Promise((resolve,reject) => ffmpeg.ffprobe(outputPath,(error,value)=>error?reject(error):resolve(value)));
      const stream=metadata.streams.find(item=>item.codec_type==='video');
      assert.equal(Number(stream.nb_frames),count);
      assert.equal(stream.avg_frame_rate,`${fps}/1`);
      assert.ok(Math.abs(Number(stream.duration)-count/fps)<1/(fps*1000));
      const pixels=run(['-i',outputPath,'-map','0:v:0','-f','rawvideo','-pix_fmt','gray','pipe:1']);
      const pixelsPerFrame=32*32;
      assert.equal(pixels.length,count*pixelsPerFrame);
      const identities=Array.from({length:count},(_,i)=>pixels[i*pixelsPerFrame+16]);
      for(let index=1;index<count;index+=1) assert.ok(identities[index]>identities[index-1],
        `frame ${index} was duplicated or reordered at stage ${stage}`);
      framePath=path.join(temporaryRoot,`frames-${stage}`);fs.mkdirSync(framePath);
      run(['-i',outputPath,'-vf',`setpts=PTS-STARTPTS,fps=${fps}:start_time=0:round=near:eof_action=pass`,
        '-fps_mode','passthrough','-start_number','0',path.join(framePath,'%d.png')]);
    }
  });
}
