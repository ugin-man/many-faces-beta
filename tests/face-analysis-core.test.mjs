import test from 'node:test';
import assert from 'node:assert/strict';
import {createFrameAnalysisSession,nextInferenceTimestampMs} from '../app/live/face-analysis-core.ts';

const result={faceLandmarks:[],faceBlendshapes:[],facialTransformationMatrixes:[]};
function setup(mode){
 const calls={images:0,timestamps:[],closes:0,bitmapCloses:0,canvases:[],copies:[]};
 const engine={detect(){calls.images++;return result;},detectForVideo(_image,t){calls.timestamps.push(t);return result;},close(){calls.closes++;}};
 const session=createFrameAnalysisSession(engine,mode,(width,height)=>{
  const canvas={width,height,getContext(){return {setTransform(){},drawImage(bitmap,_x,_y,w,h){calls.copies.push([bitmap.width,bitmap.height,w,h]);}};}};
  calls.canvases.push(canvas);return canvas;
 });
 const bitmap=(width=512,height=910)=>({width,height,close(){calls.bitmapCloses++;}});
 return {session,engine,calls,bitmap};
}

test('IMAGE mode retains source dimensions, synchronous results and one reusable canvas',()=>{
 const {session,calls,bitmap}=setup('IMAGE');
 assert.strictEqual(session.analyze(bitmap(),.1).result,result);
 session.analyze(bitmap(1920,1080),0);
 assert.equal(calls.images,2);assert.deepEqual(calls.timestamps,[]);assert.equal(calls.canvases.length,1);
 assert.deepEqual(calls.copies,[[512,910,512,910],[1920,1080,1920,1080]]);assert.equal(calls.bitmapCloses,2);
 session.close();session.close();assert.equal(calls.closes,1);
});

test('VIDEO mode uses requested timestamps, including strictly ordered repeated samples',()=>{
 const {session,calls,bitmap}=setup('VIDEO');
 const samples=[0,0,.04].map(t=>session.analyze(bitmap(),t));
 assert.deepEqual(calls.timestamps,[0,.001,40]);assert.deepEqual(samples.map(x=>x.inferenceTimestampMs),[0,.001,40]);
 assert.equal(calls.images,0);assert.equal(calls.bitmapCloses,3);session.close();
});

test('a new clip has new tracking state and a rewind requires a new session',()=>{
 const a=setup('VIDEO');a.session.analyze(a.bitmap(),2);
 assert.throws(()=>a.session.analyze(a.bitmap(),0),/VIDEO_ANALYSIS_TIME_ORDER/);
 assert.equal(a.calls.bitmapCloses,2);a.session.close();
 const b=setup('VIDEO');b.session.analyze(b.bitmap(),0);assert.deepEqual(b.calls.timestamps,[0]);b.session.close();
});

test('error and closed-session paths release the consumed bitmap',()=>{
 const {session,engine,calls,bitmap}=setup('IMAGE');
 engine.detect=()=>{throw new Error('inference failed');};
 assert.throws(()=>session.analyze(bitmap(),0),/inference failed/);
 assert.throws(()=>session.analyze(bitmap(0,0),0),/ANALYSIS_FRAME_INVALID/);
 session.close();assert.throws(()=>session.analyze(bitmap(),0),{name:'AbortError'});
 assert.equal(calls.bitmapCloses,3);assert.equal(calls.closes,1);
});

test('invalid inference times are rejected before inference',()=>{
 assert.throws(()=>nextInferenceTimestampMs(NaN,null),RangeError);
 assert.throws(()=>nextInferenceTimestampMs(-1,null),RangeError);
 const {session,calls,bitmap}=setup('VIDEO');
 assert.throws(()=>session.analyze(bitmap(),Infinity),RangeError);
 assert.equal(calls.timestamps.length,0);assert.equal(calls.bitmapCloses,1);session.close();
});
