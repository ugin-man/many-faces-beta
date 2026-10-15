import assert from 'node:assert/strict';
import test from 'node:test';
import { motionChoiceAtTime, screenRoll, shortestAngle } from '../app/live/video-motion.ts';
import { projectionError } from '../app/projection-matching.ts';
import { faceGeometryFromLandmarks } from '../app/offline-matching.ts';
const rad=d=>d*Math.PI/180;
function item(time,x=.5,roll=0,id='photo'){
 const geometry={structure:[],surface:[],projection:Array.from({length:936},(_,i)=>i%2?Math.floor(i/62)/10:(i%62)/20),layout:[x,.5,.3,.4],roll:rad(roll)};
 const feature=Array(55).fill(0);
 return {time,choice:{frame:{time,geometry,feature},candidate:{id,geometry,feature}}};
}
test('placement interpolates at video time without blending or switching photo identities',()=>{
 const a=item(0,.4,0,'left'),b=item(1/30,.42,20,'right');
 const result=motionChoiceAtTime([a,b],1/60,30);
 assert.equal(result.candidate,a.choice.candidate);
 assert.equal(result.frame.time,1/60);
 assert.ok(Math.abs(result.frame.geometry.layout[0]-.41)<1e-9);
 assert.ok(Math.abs(result.frame.geometry.roll-rad(10))<1e-9);
 assert.equal(a.choice.frame.geometry.layout[0],.4);
 for(const frame of [a,b]){
  const [x,y,w,h]=frame.choice.frame.geometry.layout;
  const [cx,cy,cw,ch]=result.frame.geometry.protectionLayout;
  assert.ok(cx-cw/2<=x-w/2+1e-9&&cx+cw/2>=x+w/2-1e-9);
  assert.ok(cy-ch/2<=y-h/2+1e-9&&cy+ch/2>=y+h/2-1e-9);
 }
});
test('angles take the short path through the signed 180 degree boundary',()=>{
 const result=motionChoiceAtTime([item(0,.5,179),item(1/30,.5,-179)],1/60,30);
 assert.ok(Math.abs(Math.abs(result.frame.geometry.roll)-Math.PI)<1e-9);
 assert.ok(Math.abs(shortestAngle(rad(358))-rad(-2))<1e-9);
});
test('only short bounded missing detections can be bridged; never extrapolate',()=>{
 assert.ok(motionChoiceAtTime([item(0),item(.1,.51,5)],.05,30));
 for(const b of [item(.2),item(.1,.9),item(.1,.5,50)])assert.equal(motionChoiceAtTime([item(0),b],.05,30),null);
 assert.equal(motionChoiceAtTime([item(1),item(2)],.5,30),null);
 assert.equal(motionChoiceAtTime([item(0)],.2,30),null);
 const jumped=item(.1);jumped.choice.frame.feature[0]=1;
 assert.equal(motionChoiceAtTime([item(0),jumped],.05,30),null);
});
test('roll comes from metric eye landmarks including portrait aspect correction',()=>{
 const points=Array.from({length:468},()=>({x:.5,y:.5,z:0}));
 for(const i of [33,133])points[i]={x:.3,y:.4,z:0};
 for(const i of [362,263])points[i]={x:.7,y:.6,z:0};
 const geometry=faceGeometryFromLandmarks(points,.5);
 assert.ok(Math.abs(geometry.roll-Math.PI/4)<1e-9);
 assert.equal(screenRoll({...geometry,roll:undefined},[0,0,.5]),-Math.PI/4);
});
test('only the rotating renderer ignores roll in photo matching; yaw remains significant',()=>{
 const a=item(0).choice.frame,b=item(0).choice.candidate;
 const tilted={...a,feature:[0,0,1,...a.feature.slice(3)]};
 assert.ok(projectionError(tilted,b).poseDegrees>0);
 assert.equal(projectionError({...tilted,compensateRoll:true},b).poseDegrees,0);
 assert.ok(projectionError({...tilted,compensateRoll:true,feature:[.5,0,1,...a.feature.slice(3)]},b).poseDegrees>0);
});

test('video placement can shrink to a distant face without changing legacy alignment', async () => {
  const { alignmentTransform } = await import('../app/offline-matching.ts');
  const geometry = { layout: [.5,.5,.6,.7] };
  const target = [.5,.4,.12,.14];
  assert.ok(Math.abs(alignmentTransform(geometry,target,.05).scale-.2)<1e-10);
  assert.equal(alignmentTransform(geometry,target).scale,.5);
});
