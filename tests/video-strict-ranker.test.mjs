import assert from 'node:assert/strict';
import test from 'node:test';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import {rankProjectionCandidateModesTwoStage as reference} from '../app/projection-matching.ts';
import {FACE_ACTION_FEATURE_INDEX as F} from '../app/face-actions.ts';
let seed=92817;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const make=(id,typed=false)=>{
 const data=Array.from({length:936},(_,i)=>(i%2?Math.floor(i/2)/468:Math.sin(i*.17))*.8+(random()-.5)*.09);
 const projection=typed?new Float32Array(data):data;
 return {id,feature:Array.from({length:55},(_,i)=>i<3?(random()-.5)*.8:random()),geometry:{projection,structure:[0],surface:projection,layout:[.5,.5,.7,.8]}};
};
const population=Array.from({length:1600},(_,i)=>make(`c${i}`,i%2===0));
const frame=(i)=>({time:i/20,feature:population[i].feature.slice(),geometry:population[i].geometry});
const compare=(ranker,input,pool,limit=64,detailed=1024)=>{
 const expected=reference(input,pool,limit,detailed).strict;
 const actual=ranker.rank(input,pool,limit,detailed);
 assert.deepEqual(actual,expected);
 assert.equal(actual.length,expected.length);
 for(let i=0;i<actual.length;i++)assert.strictEqual(actual[i].candidate,expected[i].candidate);
};
test('video-only ranks exactly match the independent six-mode oracle on both stage boundaries',()=>{
 const ranker=new ReviewStrictRanker();
 for(const size of [0,1,48,1023,1024,1025,1600])compare(ranker,frame(19),population.slice(0,size));
 for(const limit of [1,7,24,64])compare(ranker,frame(23),population,limit,256);
});
test('mouth, both wink directions, pitch and repeat queries retain every numeric error',()=>{
 const ranker=new ReviewStrictRanker();
 for(let i=0;i<16;i++){
  const input=frame(i*31);input.feature[1]=(i-8)/10;
  input.feature[F.eyeBlinkLeft]=i%3===0?1:0;input.feature[F.eyeBlinkRight]=i%3===1?1:0;
  input.feature[F.jawOpen]=i/16;input.feature[F.mouthPucker]=1-i/16;
  compare(ranker,input,population);
 }
 const counters=ranker.stats();assert.equal(counters.descriptorBuilds,population.length);
 assert.equal(counters.descriptorHits,population.length*15);
});
test('stable ties, duplicate IDs and distinct geometry with the same ID preserve admission order',()=>{
 const one=make('tie');
 const tied=Array.from({length:1500},(_,i)=>({...one,id:`tie-${i}`}));
 const ranker=new ReviewStrictRanker();compare(ranker,{...one,time:0},tied,7,256);
 const duplicates=population.map((item,i)=>({...item,id:String(i%900)}));
 compare(ranker,frame(56),duplicates);
 compare(ranker,frame(92),duplicates.slice().reverse());
});
test('ranker does not mutate input, and a cleared session does not reuse an edited descriptor',()=>{
 const ranker=new ReviewStrictRanker();const pool=population.slice(0,100);
 const input=frame(44);const before=JSON.stringify({input,pool});compare(ranker,input,pool,4,32);
 assert.equal(JSON.stringify({input,pool}),before);
 ranker.clear();const altered=structuredClone(pool);altered[0].geometry.projection[13*2+1]+=.6;
 compare(ranker,input,altered,4,32);
});
test('unsupported limits fail explicitly rather than silently returning fewer candidates',()=>{
 const ranker=new ReviewStrictRanker();
 assert.throws(()=>ranker.rank(frame(0),population,0),RangeError);
 assert.throws(()=>ranker.rank(frame(0),population,64,-1),RangeError);
});
