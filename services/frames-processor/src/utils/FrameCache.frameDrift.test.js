import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { getFramesPerSecondFromValue } from './FpsUtils.js';
const source=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
function functionSource(name) {
  const start=source.indexOf(`function ${name}(`);
  return source.slice(start,source.indexOf('\n}',start)+2);
}
const context=vm.createContext({fs,getFramesPerSecondFromValue});
const {getFrameSourceIdentity,isFrameSourceManifestCurrent}=vm.runInContext(
  `${functionSource('getFrameSourceIdentity')}\n${functionSource('isFrameSourceManifestCurrent')}\n;({getFrameSourceIdentity,isFrameSourceManifestCurrent});`,context);
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'samsar-cache-clock-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const videoPath=path.join(dir,'source.mp4');fs.writeFileSync(videoPath,'fixture');
  return {videoPath,sourceType:'ai_video',normalizedVideoPath:'/ai_video/source.mp4',framesPerSecond:24,
    canvasDimensions:{width:32,height:32},preserveAspectRatio:false};
}
test('P2P unchanged source and clock reuse extracted frames',t=>{
 const options=fixture(t);const manifest=getFrameSourceIdentity(options);
 assert.equal(isFrameSourceManifestCurrent(manifest,getFrameSourceIdentity(options)),true);
});
for(const fps of [16,30]) test(`F2P cached 24 fps frames are invalidated for ${fps} fps`,t=>{
 const options=fixture(t);const manifest=getFrameSourceIdentity(options);
 assert.equal(isFrameSourceManifestCurrent(manifest,getFrameSourceIdentity({...options,framesPerSecond:fps})),false);
});
test('F2P cache identity includes dimensions, fitting, and source stage',t=>{
 const options=fixture(t);const manifest=getFrameSourceIdentity(options);
 for(const patch of [{canvasDimensions:{width:64,height:64}},{preserveAspectRatio:true},{sourceType:'lip_sync'}]) {
  assert.equal(isFrameSourceManifestCurrent(manifest,getFrameSourceIdentity({...options,...patch})),false);
 }
});

function frameWorkerResult(paths, expectedCount, existingPaths = paths) {
 const start=source.indexOf('  const framesList = ',source.indexOf('const results = await Promise.all(workerPromises)'));
 const end=source.indexOf('  // Re-fetch session',start);
 const context=vm.createContext({results:[{framesList:paths}],frameCount:expectedCount,layerId:'layer',sessionId:'session',
   frameDirectory:'/frames',path,fs:{existsSync:file=>existingPaths.some(value=>path.basename(value)===path.basename(file))}});
 return Array.from(vm.runInContext(`(()=>{${source.slice(start,end)};return framesList;})()`,context));
}
test('F2P incomplete frame-worker results cannot mark a scene complete',()=>{
 assert.throws(()=>frameWorkerResult(['/frames/0.png'],3));
 assert.throws(()=>frameWorkerResult(['/frames/0.png','/frames/2.png'],2));
});
test('F2P metadata lists cannot hide missing frame files',()=>{
 assert.throws(()=>frameWorkerResult(['/frames/0.png','/frames/1.png'],2,['/frames/0.png']));
});
test('F2P worker metadata is deduplicated and sorted before downstream timing uses it',()=>{
 assert.deepEqual(frameWorkerResult(['/frames/1.png','/frames/0.png','/frames/1.png'],2),['/frames/0.png','/frames/1.png']);
});
test('P2P complete worker sequences retain their order and frame count',()=>{
 assert.deepEqual(frameWorkerResult(['/frames/0.png','/frames/1.png'],2),['/frames/0.png','/frames/1.png']);
});
