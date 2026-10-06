import test from 'node:test';
import assert from 'node:assert/strict';
import {captureVideoFrameAt} from '../app/live/video-frame.ts';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const unusable=()=>new DOMException("Failed to execute 'createImageBitmap' on 'Window': The image source is not usable.",'InvalidStateError');

function fixture(t, nativeSnapshot, canvasSnapshot) {
 const previous={raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame,bitmap:globalThis.createImageBitmap,document:globalThis.document};
 const state={paints:0,canvases:[],draws:[],snapshots:[]};
 const video=Object.assign(new EventTarget(),{currentTime:0,duration:1,currentSrc:'blob:fixed-video',readyState:2,videoWidth:1920,videoHeight:1080,paused:true,seeking:false,pause(){this.paused=true;},requestVideoFrameCallback(){return 1;},cancelVideoFrameCallback(){}});
 globalThis.requestAnimationFrame=callback=>{state.paints++;return setTimeout(()=>callback(performance.now()),0);};
 globalThis.cancelAnimationFrame=clearTimeout;
 globalThis.document={createElement(name){
  assert.equal(name,'canvas');
  const canvas={width:0,height:0,getContext(){return {setTransform(){},drawImage(...args){state.draws.push(args);}};}};
  state.canvases.push(canvas);return canvas;
 }};
 globalThis.createImageBitmap=source=>{
  state.snapshots.push(source);
  return source===video?nativeSnapshot(source):canvasSnapshot(source);
 };
 t.after(()=>{
  globalThis.requestAnimationFrame=previous.raf;globalThis.cancelAnimationFrame=previous.caf;
  globalThis.createImageBitmap=previous.bitmap;
  if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;
 });
 return {video,state};
}

test('successful native snapshots keep the original source, resolution, and two-paint fast path',async t=>{
 const bitmap={width:1920,height:1080,close(){}};
 const {video,state}=fixture(t,()=>Promise.resolve(bitmap),()=>assert.fail('Unexpected canvas snapshot'));
 const frame=await captureVideoFrameAt(video,0,{timeoutMs:1000});
 assert.equal(frame.bitmap,bitmap);
 assert.deepEqual(state.snapshots,[video]);
 assert.equal(state.canvases.length,0);
 assert.equal(state.paints,2);
 frame.bitmap.close();
});

for(const mode of ['synchronous','rejected-promise'])test(`an unusable ${mode} native source falls back at full source resolution`,async t=>{
 const {video,state}=fixture(t,()=>{if(mode==='synchronous')throw unusable();return Promise.reject(unusable());},source=>Promise.resolve({width:source.width,height:source.height,close(){}}));
 for(let iteration=0;iteration<2;iteration++){
  const frame=await captureVideoFrameAt(video,0,{timeoutMs:1000});
  assert.equal(frame.bitmap.width,1920);assert.equal(frame.bitmap.height,1080);frame.bitmap.close();
 }
 assert.equal(state.canvases.length,1);
 assert.deepEqual(state.draws,[[video,0,0,1920,1080],[video,0,0,1920,1080]]);
 assert.equal(state.paints,4,'Successful fallback must not add a per-frame grace wait');
});

test('a still-unusable canvas gets only one bounded paint retry',async t=>{
 let attempts=0;
 const {video,state}=fixture(t,()=>Promise.reject(unusable()),source=>{
  attempts++;if(attempts===1)return Promise.reject(unusable());
  return Promise.resolve({width:source.width,height:source.height,close(){}});
 });
 const frame=await captureVideoFrameAt(video,0,{timeoutMs:1000});frame.bitmap.close();
 assert.equal(attempts,2);assert.equal(state.paints,3);
});

test('persistent snapshot failure stops after two readbacks and releases the capture lock',async t=>{
 let attempts=0;
 const {video,state}=fixture(t,()=>Promise.reject(unusable()),()=>{attempts++;return Promise.reject(unusable());});
 await assert.rejects(captureVideoFrameAt(video,0,{timeoutMs:1000}),{name:'InvalidStateError'});
 assert.equal(attempts,2);assert.equal(state.paints,3);
 globalThis.createImageBitmap=async()=>({width:1920,height:1080,close(){}});
 (await captureVideoFrameAt(video,0,{timeoutMs:1000})).bitmap.close();
});

test('cancellation prevents a delayed native rejection from starting canvas readback',async t=>{
 let rejectNative;
 const {video,state}=fixture(t,()=>new Promise((_resolve,reject)=>{rejectNative=reject;}),()=>assert.fail('Unexpected cancelled readback'));
 const cancellation=new AbortController();
 const pending=captureVideoFrameAt(video,0,{signal:cancellation.signal,timeoutMs:1000});
 for(let i=0;i<50&&!rejectNative;i++)await delay(2);
 assert.equal(typeof rejectNative,'function');
 cancellation.abort();await assert.rejects(pending,{name:'AbortError'});
 rejectNative(unusable());await delay(0);
 assert.equal(state.canvases.length,0);assert.equal(state.draws.length,0);
});

test('a canvas bitmap resolving after cancellation is closed exactly once',async t=>{
 let finishReadback,closed=0;
 const {video}=fixture(t,()=>Promise.reject(unusable()),()=>new Promise(resolve=>{finishReadback=resolve;}));
 const cancellation=new AbortController();
 const pending=captureVideoFrameAt(video,0,{signal:cancellation.signal,timeoutMs:1000});
 for(let i=0;i<50&&!finishReadback;i++)await delay(2);
 assert.equal(typeof finishReadback,'function');
 cancellation.abort();await assert.rejects(pending,{name:'AbortError'});
 finishReadback({width:1920,height:1080,close(){closed++;}});await delay(0);
 assert.equal(closed,1);
});

test('fallback cannot capture a source that changed while the native snapshot was pending',async t=>{
 let rejectNative;
 const {video,state}=fixture(t,()=>new Promise((_resolve,reject)=>{rejectNative=reject;}),()=>assert.fail('Unexpected changed-source readback'));
 const pending=captureVideoFrameAt(video,0,{timeoutMs:1000});
 for(let i=0;i<50&&!rejectNative;i++)await delay(2);
 video.currentSrc='blob:replacement';rejectNative(unusable());
 await assert.rejects(pending,/VIDEO_POSITION_CHANGED/);
 assert.equal(state.canvases.length,0);
});

test('security failures are propagated without attempting a canvas alternative',async t=>{
 const {video,state}=fixture(t,()=>Promise.reject(new DOMException('Not origin clean','SecurityError')),()=>assert.fail('Unexpected security fallback'));
 await assert.rejects(captureVideoFrameAt(video,0,{timeoutMs:1000}),{name:'SecurityError'});
 assert.equal(state.canvases.length,0);
});
