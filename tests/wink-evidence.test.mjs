import test from 'node:test';
import assert from 'node:assert/strict';
import {winkEvidence} from '../app/live/wink-evidence.ts';
import {FACE_ACTION_FEATURE_INDEX as I} from '../app/face-actions.ts';
function fixture(left=.6,right=.1,leftOpening=.08,rightOpening=.25){
 const feature=Array(55).fill(0);feature[I.eyeBlinkLeft]=left;feature[I.eyeBlinkRight]=right;
 const p=Array(936).fill(0);const pt=(i,x,y)=>{p[i*2]=x;p[i*2+1]=y;};
 pt(362,0,0);pt(263,1,0);pt(386,.5,leftOpening/2);pt(374,.5,-leftOpening/2);
 pt(33,2,0);pt(133,3,0);pt(159,2.5,rightOpening/2);pt(145,2.5,-rightOpening/2);
 return {feature,p};
}
test('separates anatomical wink sides using independent eyelid and action signals',()=>{
 let x=fixture();assert.equal(winkEvidence(x.feature,x.p)?.side,'left');
 x=fixture(.1,.6,.25,.08);assert.equal(winkEvidence(x.feature,x.p)?.side,'right');
});
test('neutral, bilateral blink, squint, pose occlusion and disagreeing signals cannot activate support',()=>{
 for(const x of [fixture(.1,.1,.25,.25),fixture(.8,.8,.08,.08),fixture(.6,.2,.14,.15),fixture(.6,.1,.25,.08)])assert.equal(winkEvidence(x.feature,x.p),null);
 const x=fixture();x.feature[0]=.5;assert.equal(winkEvidence(x.feature,x.p),null);
 x.feature[0]=NaN;assert.equal(winkEvidence(x.feature,x.p),null);
});
test('does not fabricate stronger raw values or require a blendshape to be a confidence score',()=>{
 const x=fixture(.411,.217,.132,.228),copy=[...x.feature];assert.equal(winkEvidence(x.feature,x.p)?.side,'left');assert.deepEqual(x.feature,copy);
 assert.equal(winkEvidence([],[]),null);
});
