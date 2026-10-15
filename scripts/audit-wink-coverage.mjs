import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FACE_ACTION_FEATURE_INDEX as I, classifyFaceCoverage} from '../app/face-actions.ts';
import {decodeCatalogVector,liveCandidateFromEntry} from '../app/live-matching.ts';
import {poseWindowCellKeys,shardFilesForCells} from '../app/live/review-local-catalog.ts';
const root='public/seed-catalog',out='work/wink-coverage';
await fs.mkdir(out,{recursive:true});
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
const all=[],ids=new Set(),categoryCounts={},labels={},sourceCounts={};
for(const [cellKey,cell] of Object.entries(manifest.cells)) {
 for(const file of cell.shards??[cell.shard]) {
  const payload=JSON.parse(await fs.readFile(path.join(root,'shards',file),'utf8'));
  for(const entry of payload.items) {
   assert(!ids.has(entry.id));ids.add(entry.id);
   const feature=entry.feature,l=feature[I.eyeBlinkLeft],r=feature[I.eyeBlinkRight];
   const projection=decodeCatalogVector(entry.projection);
   const dist=(a,b)=>Math.hypot(projection[a*2]-projection[b*2],projection[a*2+1]-projection[b*2+1]);
   const ratios=[dist(159,145)/Math.max(.01,dist(33,133)),dist(386,374)/Math.max(.01,dist(362,263))];
   const actions=classifyFaceCoverage(feature);for(const a of actions)categoryCounts[a]=(categoryCounts[a]??0)+1;
   const label=entry.expressionCategory??entry.category??entry.bucket??'unlabelled';labels[label]=(labels[label]??0)+1;
   sourceCounts[entry.sourceName]=(sourceCounts[entry.sourceName]??0)+1;
   all.push({entry,file,cell:cellKey,l,r,ratios,yaw:feature[0]*90,pitch:feature[1]*90});
  }
 }
}
assert.equal(all.length,70000);
const isWink=(x,side,closed=.55,open=.35,gap=.35)=>{
 const c=side==='left'?x.l:x.r,o=side==='left'?x.r:x.l;
 return c>=closed&&o<=open&&c-o>=gap;
};
const summary={commit:process.env.GITHUB_SHA,catalogFaces:all.length,categoryCounts,labels,sourceCounts,thresholdCounts:{},windows:[],examples:[],identityConfound:'All counts below are automatic descriptor thresholds, not visual labels or independent ground truth.'};
for(const side of ['left','right']) {
 const strong=all.filter(x=>isWink(x,side)),frontal=strong.filter(x=>Math.abs(x.yaw)<=25&&Math.abs(x.pitch)<=25);
 summary.thresholdCounts[side]={loose:all.filter(x=>isWink(x,side,.4,.45,.28)).length,strong:strong.length,frontalStrong:frontal.length,veryStrong:all.filter(x=>isWink(x,side,.7,.25,.45)).length};
 const picked=frontal.sort((a,b)=>(side==='left'?b.l-b.r:a.l-a.r)-(side==='left'?a.l-a.r:b.l-b.r)).slice(0,12);
 for(const x of picked)summary.examples.push({side,id:x.entry.id,file:x.file,cell:x.cell,leftBlink:x.l,rightBlink:x.r,eyeRatios:x.ratios,yaw:x.yaw,pitch:x.pitch,sourceName:x.entry.sourceName,sourceUrl:x.entry.sourceUrl,license:x.entry.license,creator:x.entry.creator});
}
for(const yaw of [-30,-15,0,15,30])for(const pitch of [-15,0,15]) {
 const f=Array(55).fill(0);f[0]=yaw/90;f[1]=pitch/90;
 const files=new Set(shardFilesForCells(manifest,poseWindowCellKeys(manifest,f,12,15)));
 const local=all.filter(x=>files.has(x.file));
 summary.windows.push({yaw,pitch,files:files.size,faces:local.length,left:local.filter(x=>isWink(x,'left')).length,right:local.filter(x=>isWink(x,'right')).length});
}
const sample=all.filter(x=>summary.examples.some(e=>e.id===x.entry.id));
await fs.writeFile(`${out}/wink-candidates.json`,JSON.stringify(sample.map(x=>({side:summary.examples.find(e=>e.id===x.entry.id).side,entry:x.entry,file:x.file})),null,2));
const protectedHashes={manifest:createHash('sha256').update(await fs.readFile(`${root}/manifest.json`)).digest('hex'),reference:createHash('sha256').update(await fs.readFile('public/test-fixtures/reference-face-motion.mp4')).digest('hex')};
summary.protectedHashes=protectedHashes;
await fs.writeFile(`${out}/coverage.json`,JSON.stringify(summary,null,2));
console.log('WINK_COVERAGE '+JSON.stringify(summary));
// Export actual original encoded photographs for a fresh model-only check.
await fs.mkdir('public/__wink_qa',{recursive:true});
const samples=[];
for(let i=0;i<sample.length;i++){
 const {entry,file}=sample[i];let data;
 if(entry.image)data=await fs.readFile(path.join(root,'images',entry.image));
 else{const h=await fs.open(path.join(root,'packs',entry.pack));try{data=Buffer.alloc(entry.length);await h.read(data,0,entry.length,entry.offset);}finally{await h.close();}}
 await fs.writeFile(`public/__wink_qa/photo-${i}.webp`,data);
 samples.push({file:`photo-${i}.webp`,id:entry.id,side:summary.examples.find(e=>e.id===entry.id).side,stored:entry.feature,geometry:liveCandidateFromEntry(entry,file)?.geometry});
}
await fs.writeFile('public/__wink_qa/samples.json',JSON.stringify(samples));
