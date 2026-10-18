import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./VideoSession.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function updateLayerVisualItem(');
const implementation = source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '');
async function update(fps, frameRate, startFrame, endFrame) {
  const layer = {_id:'layer', durationOffset:2, duration:1,
    imageSession:{activeItemList:[{id:'item', type:'image', config:{}}]}};
  const context = vm.createContext({
    TRACK_EDITOR_FRAMES_PER_SECOND:30,
    normalizeFramesPerSecond:value => [16,24,30].includes(Number(value)) ? Number(value) : null,
    getSessionFramesPerSecondWithLog:()=>fps,
    getDBConnectionString:async()=>{},
    requireVideoSessionForStudioAccess:async()=>({layers:[layer]}),
    toPlainActiveItem:item=>({...item}),
    clampNumber:(value,min,max)=>Math.max(min,Math.min(max,value)),
    persistLayerActiveItemList:async(_session,payload)=>payload.activeItemList[0],
  });
  const fn = vm.runInContext(`${implementation}\n;updateLayerVisualItem;`, context);
  return fn('user',{sessionId:'session',layerId:'layer',itemId:'item',startFrame,endFrame,frameRate});
}
for (const fps of [16,24,30]) {
  test(`F2P studio API respects explicit ${fps} fps boundaries`,async()=>{
    const result=await update(fps,fps,(2*fps)+1,(2*fps)+7);
    assert.equal(result.config.frameRate,fps);
    assert.equal(result.config.frameOffset,1);
    assert.equal(result.config.frameDuration,6);
  });
}
test('P2P studio API accepts legacy 30 fps clients for 24 fps sessions',async()=>{
  const result=await update(24,undefined,65,80);
  assert.equal(result.config.frameRate,24);
  assert.equal(result.config.frameOffset,4);
  assert.equal(result.config.frameDuration,12);
});
