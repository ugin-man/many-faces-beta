import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogPoseFromWebMatrix } from '../app/catalog-pose.ts';
import { assertCameraEnvironment, inputError, openCameraStream, waitForPlayableVideo } from '../app/live/media-input.ts';
import { captureVideoFrameAt } from '../app/live/video-frame.ts';

const transpose = row => Array.from({length:16},(_,i)=>row[(i%4)*4+Math.floor(i/4)]);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('Web pose is equivalent to the existing Python row-major catalog convention', () => {
  for(const angle of [-0.6,-0.3,0,0.3,0.6]) {
    const c=Math.cos(angle),s=Math.sin(angle);
    for(const row of [[c,0,s,0,0,1,0,0,-s,0,c,0,0,0,0,1],[1,0,0,0,0,c,-s,0,0,s,c,0,0,0,0,1],[c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1]]) {
      const expected=[Math.atan2(-row[8],Math.hypot(row[9],row[10])),Math.atan2(row[9],row[10])*1.4,Math.atan2(row[4],row[0])].map(x=>x/(Math.PI/2));
      assert.deepEqual(catalogPoseFromWebMatrix(transpose(row)),expected);
    }
  }
  assert.equal(catalogPoseFromWebMatrix(null),null);
  assert.equal(catalogPoseFromWebMatrix([1,2]),null);
  assert.equal(catalogPoseFromWebMatrix(Array(16).fill(NaN)),null);
});

test('an embedded camera-policy denial is explicit and does not masquerade as inference failure', () => {
  assert.throws(()=>assertCameraEnvironment({secure:true,available:true,embedded:true,cameraAllowed:false}),{code:'CAMERA_POLICY_BLOCKED'});
  assert.throws(()=>assertCameraEnvironment({secure:false,available:true,embedded:false,cameraAllowed:null}),{code:'CAMERA_INSECURE'});
  assert.doesNotThrow(()=>assertCameraEnvironment({secure:true,available:true,embedded:true,cameraAllowed:true}));
});

test('camera constraints are relaxed only for OverconstrainedError, preserving a chosen device', async () => {
  const requests=[];
  const stream={getTracks:()=>[]};
  const found=await openCameraStream(async constraints=>{
    requests.push(constraints);
    if(requests.length===1)throw Object.assign(new Error('constraints'),{name:'OverconstrainedError'});
    return stream;
  },{signal:new AbortController().signal,deviceId:'selected-device'});
  assert.equal(found,stream);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].video.frameRate,{ideal:30});
  assert.deepEqual(requests[1],{video:{deviceId:{exact:'selected-device'}},audio:false});
});

test('permission denial is not retried or hidden', async () => {
  let calls=0;
  await assert.rejects(openCameraStream(async()=>{calls++;throw new DOMException('Denied','NotAllowedError');},{signal:new AbortController().signal}),{name:'NotAllowedError'});
  assert.equal(calls,1);
  assert.equal(inputError(new DOMException('Denied','NotAllowedError')).code,'CAMERA_PERMISSION_DENIED');
});

test('stop aborts the permission wait immediately and closes a subsequent native stream', async () => {
  let grant,stopped=0;
  const cancellation=new AbortController();
  const promise=openCameraStream(()=>new Promise(resolve=>{grant=resolve;}),{signal:cancellation.signal});
  cancellation.abort();
  await assert.rejects(promise,{name:'AbortError'});
  grant({getTracks:()=>[{stop(){stopped++;}}]});
  await delay(0);
  assert.equal(stopped,1);
});

test('late permission after a timeout cannot leave a camera track running', async () => {
  let grant,stopped=0;
  const promise=openCameraStream(()=>new Promise(resolve=>{grant=resolve;}),{signal:new AbortController().signal,timeoutMs:5});
  await assert.rejects(promise,{code:'CAMERA_PERMISSION_TIMEOUT'});
  grant({getTracks:()=>[{stop(){stopped++;}}]});
  await delay(0);
  assert.equal(stopped,1);
});

test('a resolved play promise without any decoded camera data cannot report input ready', async () => {
  const video=Object.assign(new EventTarget(),{paused:false,readyState:0,videoWidth:0,videoHeight:0,play:async()=>{}});
  await assert.rejects(waitForPlayableVideo(video,new AbortController().signal,10),{code:'VIDEO_START_TIMEOUT'});
});

function stubDrawing(t) {
  const old={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,bitmap:globalThis.createImageBitmap};
  globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),0);
  globalThis.cancelAnimationFrame=clearTimeout;
  globalThis.createImageBitmap=async()=>({width:96,height:96,close(){}});
  t.after(()=>{globalThis.requestAnimationFrame=old.raf;globalThis.cancelAnimationFrame=old.caf;globalThis.createImageBitmap=old.bitmap;});
}
class PausedVideo extends EventTarget {
  time=0; duration=3; currentSrc='fixture.webm'; readyState=2; videoWidth=96; videoHeight=96; paused=true; seeking=false;
  callback=null; callbackWasArmed=false;
  pause(){this.paused=true;}
  get currentTime(){return this.time;}
  set currentTime(value){
    this.callbackWasArmed=typeof this.callback==='function';this.time=value;this.seeking=true;
    queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));const callback=this.callback;this.callback=null;callback?.(performance.now(),{mediaTime:Math.floor(value*12)/12});});
  }
  requestVideoFrameCallback(callback){this.callback=callback;return 1;}
  cancelVideoFrameCallback(){this.callback=null;}
}

test('a seek arms presentation before changing position', async t => {
  stubDrawing(t);const video=new PausedVideo();
  const frame=await captureVideoFrameAt(video,1.2,{timeoutMs:1000});
  assert.equal(video.callbackWasArmed,true);assert.equal(frame.evidence,'presentation-callback');frame.bitmap.close();
});

test('paused initial and repeated frames are acquired without waiting for nonexistent future presentation', async t => {
  stubDrawing(t);const video=new PausedVideo();
  for(let i=0;i<2;i++){
    const frame=await captureVideoFrameAt(video,0,{timeoutMs:1000});
    assert.equal(frame.evidence,'decoded-paused-readback');assert.equal(frame.requestedTime,0);frame.bitmap.close();
  }
});

test('a stalled seek fails closed without returning a bitmap and cleans its operation lock', async t => {
  stubDrawing(t);const video=new PausedVideo();video.readyState=0;
  await assert.rejects(captureVideoFrameAt(video,0,{timeoutMs:10}),/VIDEO_FRAME_TIMEOUT/);
  video.readyState=2;
  const frame=await captureVideoFrameAt(video,0,{timeoutMs:1000});frame.bitmap.close();
});

test('cancellation does not leak a bitmap that resolves after capture was abandoned', async t => {
  stubDrawing(t);const video=new PausedVideo(),cancellation=new AbortController();
  let finish,closed=0;
  globalThis.createImageBitmap=()=>new Promise(resolve=>{finish=resolve;});
  const promise=captureVideoFrameAt(video,1,{signal:cancellation.signal,timeoutMs:1000});
  for(let i=0;i<50&&!finish;i++)await delay(5);
  assert.equal(typeof finish,'function');cancellation.abort();
  await assert.rejects(promise,{name:'AbortError'});
  finish({width:96,height:96,close(){closed++;}});await delay(0);assert.equal(closed,1);
});
