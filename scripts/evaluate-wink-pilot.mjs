import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import {poseWindowCellKeys,shardFilesForCells} from '../app/live/review-local-catalog.ts';
import {winkEvidence} from '../app/live/wink-evidence.ts';
import {parseWinkSupport,supportForFrame} from '../app/live/wink-support.ts';
const root='public/seed-catalog',out='work/wink-heldout',qa='public/__wink_eval';
await fs.mkdir(out,{recursive:true});await fs.mkdir(qa,{recursive:true});
const manifest=JSON.parse(await fs.readFile(`${root}/manifest.json`,'utf8'));
const pilot=JSON.parse(await fs.readFile('data/wink-pilot/catalog.json','utf8'));
const support=parseWinkSupport(pilot,'http://127.0.0.1:4183'),all=[],byFile=new Map(),originalHashes=new Set();
const sourceKey=source=>{
 if(!source)return '';
 try{const u=new URL(source),p=decodeURIComponent(u.pathname).replaceAll(' ','_').replace(/\/$/,'');const flickr=p.match(/^\/photos\/[^/]+\/(\d+)/);return flickr?'flickr:'+flickr[1]:u.hostname.toLowerCase()+p;}catch{return source;}
};
for(const cell of Object.values(manifest.cells))for(const file of cell.shards??[cell.shard]){
 const entries=JSON.parse(await fs.readFile(`${root}/shards/${file}`,'utf8')).items,candidates=[],packs=new Map();
 for(const entry of entries){
  const c=liveCandidateFromEntry(entry,file);assert(c);all.push(c);candidates.push(c);
  let bytes;
  if(entry.image)bytes=await fs.readFile(`${root}/images/${entry.image}`);
  else{if(!packs.has(entry.pack))packs.set(entry.pack,await fs.readFile(`${root}/packs/${entry.pack}`));bytes=packs.get(entry.pack).subarray(entry.offset,entry.offset+entry.length);}
  originalHashes.add(createHash('sha256').update(bytes).digest('hex'));
 }
 byFile.set(file,candidates);
}
assert.equal(all.length,70000);assert.equal(new Set(all.map(x=>x.id)).size,70000);
let photoBytes=0;
for(const entry of pilot.items){const bytes=await fs.readFile(`data/wink-pilot/images/${entry.image}`);photoBytes+=bytes.length;assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.imageSha256);assert(!originalHashes.has(entry.imageSha256),'Exact duplicate core photo');}
const originalKeys=new Set(all.map(c=>sourceKey(c.sourceUrl)));
const report={commit:process.env.GITHUB_SHA,originalFaces:70000,extraFaces:support.length,extraPhotoBytes:photoBytes,exactImageDuplicates:0,sourceUrlOverlaps:pilot.items.filter(x=>originalKeys.has(sourceKey(x.sourceUrl))).map(x=>x.id),screen:'automatic model plus eyelid geometry, not independent perceptual truth',cases:[],nonWinkUnchanged:0};
const ranker=new ReviewStrictRanker(),exports=new Map();
function describe(result){return {id:result.candidate.id,sourceUrl:result.candidate.sourceUrl,error:result.error,evidence:winkEvidence(result.candidate.feature,result.candidate.geometry.projection)};}
function pool(frame){
 let files=shardFilesForCells(manifest,poseWindowCellKeys(manifest,frame.feature,12,15));
 let candidates=files.flatMap(file=>byFile.get(file)??[]);
 if(candidates.length<384){files=shardFilesForCells(manifest,poseWindowCellKeys(manifest,frame.feature,18,21));candidates=files.flatMap(file=>byFile.get(file)??[]);}
 return [...new Map(candidates.map(c=>[c.id,c])).values()];
}
for(const source of support){
 const frame={time:0,feature:source.feature,geometry:source.geometry},key=sourceKey(source.sourceUrl);
 const base=pool(frame).filter(c=>sourceKey(c.sourceUrl)!==key),additional=supportForFrame(frame,support.filter(c=>sourceKey(c.sourceUrl)!==key));
 const before=ranker.rank(frame,base,64,Math.min(1024,base.length));
 const combined=[...base,...additional],after=ranker.rank(frame,combined,64,Math.min(1024,combined.length));
 assert(before[0]&&after[0]);
 const row={sourceId:source.id,expectedSide:source.supportSide,baseCandidates:base.length,addedCandidates:additional.length,before:describe(before[0]),after:describe(after[0])};
 row.beforeSameSide=row.before.evidence?.side===source.supportSide;row.afterSameSide=row.after.evidence?.side===source.supportSide;
 report.cases.push(row);
 for(const c of [source,before[0].candidate,after[0].candidate])exports.set(c.id,c);
}
for(const c of all.filter(c=>Math.abs(c.feature[0]*90)<15&&Math.abs(c.feature[1]*90)<15).filter(c=>!winkEvidence(c.feature,c.geometry.projection)).filter((_,i)=>i%137===0).slice(0,24)){
 const frame={time:0,feature:c.feature,geometry:c.geometry};assert.deepEqual(supportForFrame(frame,support),[]);report.nonWinkUnchanged++;
}
const files={};
for(const c of exports.values()){
 const name=`photo-${Object.keys(files).length}.webp`;let bytes;
 if(c.id.startsWith('wink-extra-'))bytes=await fs.readFile(`data/wink-pilot/images/${c.image}`);
 else if(c.image)bytes=await fs.readFile(`${root}/images/${c.image}`);
 else{const handle=await fs.open(`${root}/packs/${c.pack}`);try{bytes=Buffer.alloc(c.length);await handle.read(bytes,0,c.length,c.offset);}finally{await handle.close();}}
 await fs.writeFile(`${qa}/${name}`,bytes);files[c.id]=name;
}
report.beforeSameSide=report.cases.filter(c=>c.beforeSameSide).length;report.afterSameSide=report.cases.filter(c=>c.afterSameSide).length;
report.changedWinners=report.cases.filter(c=>c.before.id!==c.after.id).length;
await fs.writeFile(`${out}/heldout.json`,JSON.stringify(report,null,2));
await fs.writeFile(`${qa}/cases.json`,JSON.stringify({files,cases:report.cases}));
console.log('WINK_HELDOUT '+JSON.stringify(report));
