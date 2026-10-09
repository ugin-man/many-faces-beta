import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameArrivalTracker } from '../app/live/frame-arrival.ts';
import { startVideoFramePump } from '../app/live/media-input.ts';
import { LatestFrameGate } from '../app/live/astra/runtime.ts';

test('constant zero PTS does not erase actual compositor arrivals or stall the frame gate', () => {
  const arrivals=new FrameArrivalTracker(),gate=new LatestFrameGate();let processed=0,lastAt=0;
  for(let i=1;i<=360;i++){
    const now=i*1000/30;
    const arrival=arrivals.observe(now,{presentedFrames:i,mediaTime:0});
    assert.ok(arrival);lastAt=arrival.at;
    const id=gate.reserve(now,arrival.sequence,20);
    if(id!==null){processed++;assert.equal(gate.complete(id,now+2),true);}
  }
  assert.equal(processed,240);assert.equal(lastAt,12000);assert.equal(arrivals.snapshot().mediaTime,0);
});

test('decoder increments work with absent callbacks and an unchanging playback clock',()=>{
  const arrivals=new FrameArrivalTracker();
  for(let i=1;i<=10;i++)assert.equal(arrivals.observe(i*33,{decodedFrames:i,mediaTime:0}).evidence,'decoded-frames');
  for(let i=0;i<300;i++)assert.equal(arrivals.observe(400+i*33,{decodedFrames:10,mediaTime:0}),null);
  assert.equal(arrivals.snapshot().arrivals,10);
});

test('timer ticks, repeated callback metadata and an advancing clock cannot hide frozen counters',()=>{
  const arrivals=new FrameArrivalTracker();
  arrivals.observe(0,{presentedFrames:7,decodedFrames:9,mediaTime:0});
  for(let i=1;i<=400;i++)assert.equal(arrivals.observe(i*33,{presentedFrames:7,decodedFrames:9,mediaTime:i/30,presentationTime:i*33}),null);
  assert.equal(arrivals.snapshot().lastArrivalAt,0);
});

test('clock-only legacy playback can loop, counters can reset, and invalid numbers are not arrivals',()=>{
  const tracker=new FrameArrivalTracker();
  assert.equal(tracker.observe(NaN,{mediaTime:0}),null);
  assert.equal(tracker.observe(0,{mediaTime:NaN,presentedFrames:Infinity}),null);
  assert.ok(tracker.observe(1,{mediaTime:2}));assert.equal(tracker.observe(2,{mediaTime:2}),null);
  assert.ok(tracker.observe(3,{mediaTime:0}));
  assert.ok(tracker.observe(4,{decodedFrames:50,mediaTime:0}));
  assert.equal(tracker.observe(5,{decodedFrames:0,mediaTime:0}),null);
  assert.ok(tracker.observe(6,{decodedFrames:1,mediaTime:0}));
});

test('the pump emits distinct identities for real callback evidence and stops scheduling on teardown',()=>{
  let callback=null,cancelled=0;
  const video={paused:false,ended:false,seeking:false,readyState:2,videoWidth:640,videoHeight:480,currentTime:0,srcObject:null,
    requestVideoFrameCallback(cb){callback=cb;return 1;},cancelVideoFrameCallback(){cancelled++;callback=null;}};
  const emitted=[];const stop=startVideoFramePump(video,(_now,id,mode,evidence)=>emitted.push({id,mode,evidence}));
  try{
    for(let i=1;i<=5;i++){const cb=callback;callback=null;cb(performance.now(),{mediaTime:0,presentedFrames:i,presentationTime:i*33});}
    assert.deepEqual(emitted.map(x=>x.id),[1,2,3,4,5]);
    assert.ok(emitted.every(x=>x.evidence.mediaTime===0));
    const late=callback;stop();late?.(performance.now(),{mediaTime:0,presentedFrames:6});
    assert.equal(emitted.length,5);assert.equal(callback,null);assert.equal(cancelled,1);
  }finally{stop();}
});

test('a throwing presentation-callback API falls back without inventing frames',async()=>{
  let decoded=0;
  const video={paused:false,ended:false,seeking:false,readyState:2,videoWidth:640,videoHeight:480,currentTime:0,srcObject:null,
    requestVideoFrameCallback(){throw new Error('not supported');},getVideoPlaybackQuality(){return {totalVideoFrames:decoded,droppedVideoFrames:0};}};
  const emitted=[];const stop=startVideoFramePump(video,(_now,id)=>emitted.push(id));
  try{
    decoded=1;await new Promise(resolve=>setTimeout(resolve,80));
    decoded=2;await new Promise(resolve=>setTimeout(resolve,80));
    const count=emitted.length;await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(count,2);assert.equal(emitted.length,count);
  }finally{stop();}
});
