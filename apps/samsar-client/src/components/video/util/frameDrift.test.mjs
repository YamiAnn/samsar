import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerBoundImageItem } from './layerBoundImageItem.js';
import { getLayerDisplayFrameRanges, findLayerIndexAtDisplayFrame } from './studioPreviewTimeline.mjs';
for(const fps of [16,24,30]) {
 test(`F2P studio images store exact ${fps} fps local and global boundaries`,()=>{
  const layer={durationOffset:65/fps,duration:17/fps};
  const item=createLayerBoundImageItem({layer,framesPerSecond:fps,id:'image'});
  assert.equal(item.startFrame,65);assert.equal(item.endFrame,82);
  assert.equal(item.config.frameOffset,0);assert.equal(item.config.frameDuration,17);
  assert.equal(item.config.frameRate,fps);
 });
 test(`F2P studio seeks select the correct scene on a ${fps} fps boundary`,()=>{
  const layers=[{durationOffset:0,duration:17/fps},{durationOffset:17/fps,duration:9/fps}];
  assert.deepEqual(getLayerDisplayFrameRanges(layers,fps),[{startFrame:0,endFrame:17},{startFrame:17,endFrame:26}]);
  assert.equal(findLayerIndexAtDisplayFrame(layers,16,fps),0);
  assert.equal(findLayerIndexAtDisplayFrame(layers,17,fps),1);
 });
 test(`F2P ${fps} fps: fractional scene timing stays aligned after 137 scenes`,()=>{
  let offset=0;const layers=Array.from({length:137},()=>{
    const layer={durationOffset:offset,duration:1.37};offset+=layer.duration;return layer;
  });
  const ranges=getLayerDisplayFrameRanges(layers,fps);
  assert.equal(ranges.at(-1).endFrame,Math.round(offset*fps));
 });
}
test('P2P image helpers retain the legacy display clock when no session is supplied',()=>{
 const item=createLayerBoundImageItem({layer:{durationOffset:2,duration:3},id:'legacy'});
 assert.equal(item.startFrame,60);assert.equal(item.endFrame,150);
 assert.equal(item.config.frameOffset,0);assert.equal(item.config.frameDuration,90);
});
