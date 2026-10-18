import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./GenerationHelper.js',import.meta.url),'utf8');
const start=source.indexOf('export async function adjustFrameOffsetsAndDurations(');
const implementation=source.slice(start,source.indexOf('\n}',start)+2).replace('export ','');
for(const fps of [16,24,30])test(`F2P ${fps} fps: resizing an earlier scene preserves later local item timings`,async()=>{
 const item={config:{frameOffset:3,frameDuration:7}};
 const session={layers:[{duration:3,imageSession:{activeItemList:[]}},
   {duration:1,imageSession:{activeItemList:[item]}}],save:async()=>{}};
 const context=vm.createContext({getDBConnectionString:async()=>{},getFramesPerSecondFromValue:()=>fps});
 const adjust=vm.runInContext(`${implementation}\n;adjustFrameOffsetsAndDurations;`,context);
 for(const diff of [1,-1,1,-1]) await adjust(session,0,diff,fps);
 assert.equal(item.config.frameOffset,3);
 assert.equal(item.config.frameDuration,7);
 await adjust(session,0,1,fps);
 assert.equal(item.config.frameOffset,3);
});
