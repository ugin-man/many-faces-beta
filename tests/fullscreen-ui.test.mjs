import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { shouldExitSwipe, clipPlaybackTime, timeLabel } from "../app/studio-controls.ts";
import { optimizeDistinctProjectionSequence, projectionError } from "../app/projection-matching.ts";
test("only deliberate downward or left-edge gestures exit",()=>{
 const start={x:12,y:100,at:0};
 assert.equal(shouldExitSwipe(start,{x:130,y:108,at:300}),true);
 assert.equal(shouldExitSwipe({x:150,y:100,at:0},{x:156,y:260,at:400}),true);
 assert.equal(shouldExitSwipe(start,{x:16,y:106,at:300}),false);
 assert.equal(shouldExitSwipe(start,{x:140,y:230,at:300}),false);
 assert.equal(shouldExitSwipe(start,{x:140,y:103,at:3000}),false);
 assert.equal(shouldExitSwipe({x:150,y:100,at:0},{x:280,y:102,at:300}),false);
});
test("playback positions stay in the analyzed interval",()=>{
 assert.equal(clipPlaybackTime(8,5),5);assert.equal(clipPlaybackTime(-1,5),0);
 assert.equal(clipPlaybackTime(NaN,5),0);assert.equal(timeLabel(65.7),"01:05");
});
test("the review may keep the exact match instead of forcing a worse identity",()=>{
 const projection=Array.from({length:468},(_,i)=>[((i%31)-15)/20,(Math.floor(i/31)-4)/10]).flat();
 const geometry={structure:Array(120).fill(0),surface:Array(600).fill(0),projection,layout:[.5,.5,.6,.75]};
 const feature=Array(55).fill(0),good={id:"good",feature,geometry};
 const bad={id:"bad",feature:[.35,...feature.slice(1)],geometry};
 const frames=Array.from({length:6},(_,i)=>({time:i/20,feature,geometry}));
 const beams=frames.map(frame=>[good,bad].map(candidate=>({candidate,error:projectionError(frame,candidate)})));
 const current=optimizeDistinctProjectionSequence(frames,beams,{allowRepeats:true});
 assert.equal(current.length,6);assert.ok(current.every(choice=>choice.candidate.id==="good"));
 const old=optimizeDistinctProjectionSequence(frames,beams);
 assert.ok(old.some(choice=>choice.candidate.id==="bad"));
 assert.ok(current.reduce((sum,x)=>sum+x.error.total,0)<old.reduce((sum,x)=>sum+x.error.total,0));
});
test("one studio entry replaces the old three-tab navigation and keeps atomic capture",async()=>{
 const layout=await readFile(new URL("../app/layout.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(layout,/ModeNav|next\/font/);
 const video=await readFile(new URL("../app/live/review-client-lite.tsx",import.meta.url),"utf8");
 assert.match(video,/reference-face-motion\.mp4/);assert.match(video,/captureVideoFrameAt/);
 assert.match(video,/video.currentTime >= clipDuration/);
 assert.doesNotMatch(video,/recordFiveSeconds|styles\.(?:guideBox|faceFrame)\b/);
 const shell=await readFile(new URL("../app/call-stage.tsx",import.meta.url),"utf8");
 assert.match(shell,/source-pip/);assert.match(shell,/result-stage/);assert.match(shell,/shouldExitSwipe/);
});

test("a sustained expression and tilted pose are not calibrated away at startup",async()=>{
 const {catalogFeatureFromResult}=await import("../app/catalog-feature.ts");
 const {FACE_ACTION_FEATURE_INDEX}=await import("../app/face-actions.ts");
 const angle=20*Math.PI/180;
 const matrix=[1,0,0,0,0,Math.cos(angle),Math.sin(angle),0,0,-Math.sin(angle),Math.cos(angle),0,0,0,0,1];
 const result={facialTransformationMatrixes:[{data:matrix}],faceBlendshapes:[{categories:[{categoryName:"mouthSmileLeft",score:.8},{categoryName:"eyeBlinkRight",score:.9}]}]};
 for(let frame=0;frame<24;frame++){
  const feature=catalogFeatureFromResult(result);
  assert.ok(Math.abs(feature[1]*90-28)<1e-8);
  assert.equal(feature[FACE_ACTION_FEATURE_INDEX.mouthSmileLeft],.8);
  assert.equal(feature[FACE_ACTION_FEATURE_INDEX.eyeBlinkRight],.9);
 }
 const worker=await readFile(new URL("../app/live/astra/processor.worker.ts",import.meta.url),"utf8");
 assert.match(worker,/catalogFeatureFromResult/);
 assert.doesNotMatch(worker,/calibrateExpressionFeature|landmarkPitchDegrees/);
});
