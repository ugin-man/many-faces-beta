import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureVideoFrameAt} from '../app/live/video-frame.ts';

test('invalid timestamp and cancellation reject before using video APIs',async()=>{
 await assert.rejects(captureVideoFrameAt({},NaN),RangeError);
 const c=new AbortController();c.abort();await assert.rejects(captureVideoFrameAt({},0,{signal:c.signal}),{name:'AbortError'});
});
test('decoded acquisition retains barriers and the error deadline, without a speculative 100 ms timer',async()=>{
 const source=await readFile(new URL('../app/live/video-frame.ts',import.meta.url),'utf8');
 assert.equal((source.match(/await paint\(signal\)/g)||[]).length,2);
 assert.doesNotMatch(source,/setTimeout\(resolve, 100\)/);
 assert.match(source,/VIDEO_FRAME_TIMEOUT/);assert.match(source,/video.currentSrc === source/);
 assert.match(source,/signal.aborted \|\| !positioned\(\)/);assert.match(source,/timingsMs/);
});
