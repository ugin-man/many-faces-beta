// Independent full-sort oracle for the pre-optimization numerical contract.
// This is a code-equivalence oracle, not a perceptual facial-match ground truth.
import { FACE_ACTION_FEATURE_INDEX } from '../../app/face-actions.ts';
const actions = ['jawOpen','mouthFunnel','mouthPucker','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthStretchLeft','mouthStretchRight','eyeBlinkLeft','eyeBlinkRight','eyeWideLeft','eyeWideRight','eyeLookUpLeft','eyeLookUpRight','eyeLookDownLeft','eyeLookDownRight','browInnerUp','browDownLeft','browDownRight','noseSneerLeft','noseSneerRight'];
const landmarks = [10,152,234,454,33,133,362,263,1,98,327,61,291,13,14,159,145,386,374,105,334];
const finite = v => Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0;
function sketch(c) {
  const s=c.geometry.structure;
  const structure=Array.from({length:Math.min(9,s.length)},(_,i)=>finite(s[i]));
  if(s.length>9) for(let i=0;i<18;i++) structure.push(finite(s[9+Math.floor((s.length-10)*i/17)]));
  return {pose:c.feature.slice(0,3).map(v=>finite(v)*90),structure,action:actions.map(k=>finite(c.feature[FACE_ACTION_FEATURE_INDEX[k]])),local:landmarks.flatMap(i=>[finite(c.geometry.projection?.[i*2]),finite(c.geometry.projection?.[i*2+1])])};
}
function meanSquare(a,b) {let sum=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i++){const d=a[i]-b[i];sum+=d*d;}return n?sum/n:0;}
export function bruteRank(candidates,frame,budget=128,previousIds=[]) {
  const q=sketch(frame),previous=new Set(previousIds);
  const measured=candidates.map((c,i)=>{
    const s=sketch(c),yaw=(q.pose[0]-s.pose[0])/18,pitch=(q.pose[1]-s.pose[1])/21,roll=(q.pose[2]-s.pose[2])/45;
    const score=yaw*yaw*.72+pitch*pitch+roll*roll*.08+meanSquare(q.structure,s.structure)*1.55+meanSquare(q.action,s.action)*1.3+meanSquare(q.local,s.local)*.42-(previous.has(c.id)?.035:0);
    return {c,i,score};
  }).sort((a,b)=>a.score-b.score||a.i-b.i);
  budget=Math.min(candidates.length,Math.max(1,Math.round(budget)));
  const reserve=Math.min(previous.size,Math.max(1,Math.floor(budget/4)));
  const forced=measured.filter(x=>previous.has(x.c.id)).slice(0,reserve),ids=new Set(forced.map(x=>x.i));
  return [...forced,...measured.filter(x=>!ids.has(x.i)).slice(0,budget-forced.length)].map(x=>x.c.id);
}
export function random(seed=1) {let s=seed>>>0;return()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;};}
