import test from 'node:test';
import assert from 'node:assert/strict';
import {continueWithFrameFallback, decodeReviewFrames} from '../app/live/video-decoder.ts';

function frame(time, counters, backend='webcodecs') {
 return {bitmap:{width:16,height:9,close(){counters.closed++;}},requestedTime:time,mediaTime:time,evidence:backend==='webcodecs'?'webcodecs':'decoded-paused-readback',backend,timingsMs:{position:0,paint:0,bitmap:0,total:0}};
}
async function collect(iterator){const seen=[];for await(const item of iterator){seen.push(item.requestedTime);item.bitmap.close();}return seen;}

test('a decoder failure resumes from the failed requested sample without replaying earlier frames',async()=>{
 const counters={closed:0};let remaining,preferredClosed=0;
 const preferred=async function*(times){try{yield frame(times[0],counters);yield frame(times[1],counters);throw new Error('codec failed');}finally{preferredClosed++;}};
 const fallback=async function*(times){remaining=[...times];for(const t of times)yield frame(t,counters,'video-element');};
 const seen=await collect(continueWithFrameFallback([0,0,.04,.08],preferred,fallback));
 assert.deepEqual(seen,[0,0,.04,.08]);assert.deepEqual(remaining,[.04,.08]);assert.equal(preferredClosed,1);assert.equal(counters.closed,4);
});

test('a truncated decoder resumes every missing frame through the compatibility path',async()=>{
 const counters={closed:0};let reason;
 const preferred=async function*(){yield frame(0,counters);};
 const fallback=async function*(times){for(const t of times)yield frame(t,counters,'video-element');};
 assert.deepEqual(await collect(continueWithFrameFallback([0,.1,.2],preferred,fallback,{onFallback:r=>reason=r})),[0,.1,.2]);
 assert.match(reason,/INCOMPLETE/);assert.equal(counters.closed,3);
});

test('a wrong decoder timestamp closes that bitmap and retries the same requested time',async()=>{
 const counters={closed:0};let remaining;
 const preferred=async function*(){yield frame(.02,counters);};
 const fallback=async function*(times){remaining=[...times];for(const t of times)yield frame(t,counters,'video-element');};
 assert.deepEqual(await collect(continueWithFrameFallback([0,.1],preferred,fallback)),[0,.1]);
 assert.deepEqual(remaining,[0,.1]);assert.equal(counters.closed,3);
});

test('cancellation cleans up the active iterator and never starts compatibility capture',async()=>{
 const counters={closed:0},controller=new AbortController();let cleaned=0,fallbacks=0;
 const preferred=async function*(){try{yield frame(0,counters);controller.abort();yield frame(.1,counters);}finally{cleaned++;}};
 const fallback=async function*(){fallbacks++;};
 await assert.rejects(collect(continueWithFrameFallback([0,.1],preferred,fallback,{signal:controller.signal})),{name:'AbortError'});
 assert.equal(cleaned,1);assert.equal(fallbacks,0);assert.equal(counters.closed,2);
});

test('stopping consumption releases the decoder without beginning fallback work',async()=>{
 const counters={closed:0};let cleaned=0,fallbacks=0;
 const preferred=async function*(){try{yield frame(0,counters);yield frame(.1,counters);}finally{cleaned++;}};
 const fallback=async function*(){fallbacks++;};
 for await(const item of continueWithFrameFallback([0,.1],preferred,fallback)){item.bitmap.close();break;}
 assert.equal(cleaned,1);assert.equal(fallbacks,0);assert.equal(counters.closed,1);
});

test('invalid and pre-cancelled requests do not open either decoder',async()=>{
 let calls=0;const source=async function*(){calls++;};
 await assert.rejects(collect(continueWithFrameFallback([NaN],source,source)),RangeError);
 const c=new AbortController();c.abort();
 await assert.rejects(collect(continueWithFrameFallback([0],source,source,{signal:c.signal})),{name:'AbortError'});
 assert.equal(calls,0);
});

test('forced WebCodecs comparison does not silently become a legacy comparison',async()=>{
 if(typeof VideoDecoder!=='undefined')return;
 await assert.rejects(collect(decodeReviewFrames({},new Blob(),[0],{backend:'webcodecs'})),/VIDEO_DECODER_UNAVAILABLE/);
});
