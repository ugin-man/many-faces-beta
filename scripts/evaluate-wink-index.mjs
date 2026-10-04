import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import {poseWindowCellKeys,shardFilesForCells} from '../app/live/review-local-catalog.ts';
import {winkEvidence} from '../app/live/wink-evidence.ts';
import {parseWinkSupport,supportForFrame,rankWinkSupport} from '../app/live/wink-support.ts';
const root='public/seed-catalog',out='work/wink-index',qa='public/__wink_eval';
await fs.mkdir(out,{recursive:true});await fs.mkdir(qa,{recursive:true});
const manifest=JSON.parse(await fs.readFile(`${root}/manifest.json`,'utf8'));
const raw=JSON.parse(await fs.readFile('public/wink-support/v1/catalog.json','utf8'));
const support=parseWinkSupport(raw,'http://127.0.0.1:4183'),all=[],byFile=new Map(),byId=new Map();
const key=source=>{try{const u=new URL(source);const p=decodeURIComponent(u.pathname).replaceAll(' ','_').replace(/\/$/,'');const flickr=p.match(/^\/photos\/[^/]+\/(\d+)/);return flickr?'flickr:'+flickr[1]:u.hostname.toLowerCase()+p;}catch{return source??'';}};
for(const cell of Object.values(manifest.cells))for(const file of cell.shards??[cell.shard]){
 const entries=JSON.parse(await fs.readFile(`${root}/shards/${file}`,'utf8')).items,candidates=[];
 for(const entry of entries){const c=liveCandidateFromEntry(entry,file);assert(c);assert(!byId.has(c.id));byId.set(c.id,c);all.push(c);candidates.push(c);}
 byFile.set(file,candidates);
}
assert.equal(all.length,70000);
let checkedPhotos=0;
async function photo(candidate){
 if(candidate.supportKind==='addition')return fs.readFile(`public/wink-support/v1/images/${candidate.image}`);
 if(candidate.image)return fs.readFile(`${root}/images/${candidate.image}`);
 const h=await fs.open(`${root}/packs/${candidate.pack}`);try{const bytes=Buffer.alloc(candidate.length);const read=await h.read(bytes,0,candidate.length,candidate.offset);assert.equal(read.bytesRead,candidate.length);return bytes;}finally{await h.close();}
}
for(const entry of raw.items){const c=support.find(x=>x.id===entry.id);assert(c);if(c.supportKind==='core-refresh'){const original=byId.get(c.id);assert(original);assert.equal(original.pack,c.pack);assert.equal(original.offset,c.offset);assert.equal(original.length,c.length);assert.equal(original.image,c.image);}
 assert.equal(createHash('sha256').update(await photo(c)).digest('hex'),entry.imageSha256);checkedPhotos++;}
function pool(frame){let files=shardFilesForCells(manifest,poseWindowCellKeys(manifest,frame.feature,12,15));let p=files.flatMap(file=>byFile.get(file)??[]);if(p.length<384){files=shardFilesForCells(manifest,poseWindowCellKeys(manifest,frame.feature,18,21));p=files.flatMap(file=>byFile.get(file)??[]);}return [...new Map(p.map(c=>[c.id,c])).values()];}
const ranker=new ReviewStrictRanker(),exports=new Map();
const sources=[...support.filter(c=>c.supportKind==='addition'),...['left','right'].flatMap(side=>support.filter(c=>c.supportKind==='core-refresh'&&c.supportSide===side).sort((a,b)=>(Math.abs(a.feature[0])+Math.abs(a.feature[1]))-(Math.abs(b.feature[0])+Math.abs(b.feature[1]))).slice(0,12))];
const report={commit:process.env.GITHUB_SHA,originalFaces:70000,refreshedOriginals:support.filter(x=>x.supportKind==='core-refresh').length,addedPhotos:support.filter(x=>x.supportKind==='addition').length,indexBytes:(await fs.stat('public/wink-support/v1/catalog.json')).size,checkedPhotoHashes:checkedPhotos,querySelection:'six external sources plus nearest-front twelve originals per anatomical side; every query photo/source is held out; not independent human labels or a person-disjoint test',cases:[],neutralNoOp:0};
const summary=r=>({id:r.candidate.id,sourceUrl:r.candidate.sourceUrl,supportKind:r.candidate.supportKind??null,error:r.error,evidence:winkEvidence(r.candidate.feature,r.candidate.geometry.projection)});
for(const source of sources){
 const frame={time:0,feature:source.feature,geometry:source.geometry},excluded=key(source.sourceUrl);
 const base=pool(frame).filter(c=>key(c.sourceUrl)!==excluded&&c.id!==source.id);
 const heldout=support.filter(c=>key(c.sourceUrl)!==excluded&&c.id!==source.id);
 const ordinary=ranker.rank(frame,base,64,Math.min(1024,base.length));
 const replacements=new Map(supportForFrame(frame,heldout).map(c=>[c.id,c]));
 const enriched=base.map(c=>replacements.get(c.id)??c);const ids=new Set(base.map(c=>c.id));enriched.push(...[...replacements.values()].filter(c=>!ids.has(c.id)));
 const dataOnly=ranker.rank(frame,enriched,64,Math.min(1024,enriched.length));
 const coreOnly=rankWinkSupport(frame,heldout.filter(c=>c.supportKind==='core-refresh'),ranker);
 const corrected=rankWinkSupport(frame,heldout,ranker);
 const after=corrected??ordinary;
 const row={sourceId:source.id,sourceKind:source.supportKind,expectedSide:source.supportSide,baseCandidates:base.length,sameSidePool:supportForFrame(frame,heldout).length,before:summary(ordinary[0]),dataOnly:summary(dataOnly[0]),coreOnly:summary((coreOnly??ordinary)[0]),after:summary(after[0]),fallback:!corrected};
 report.cases.push(row);
 for(const c of [source,ordinary[0].candidate,dataOnly[0].candidate,(coreOnly??ordinary)[0].candidate,after[0].candidate])exports.set(c.id,c);
}
for(const c of all.filter(c=>Math.abs(c.feature[0]*90)<20&&Math.abs(c.feature[1]*90)<20&&!winkEvidence(c.feature,c.geometry.projection)).filter((_,i)=>i%197===0).slice(0,40)){
 const frame={time:0,feature:c.feature,geometry:c.geometry};assert.equal(rankWinkSupport(frame,support,ranker),null);report.neutralNoOp++;
}
report.totals=Object.fromEntries(['before','dataOnly','coreOnly','after'].map(variant=>[variant,report.cases.filter(row=>row[variant].evidence?.side===row.expectedSide).length]));
report.externalTotals=Object.fromEntries(['before','dataOnly','coreOnly','after'].map(variant=>[variant,report.cases.filter(row=>row.sourceKind==='addition'&&row[variant].evidence?.side===row.expectedSide).length]));
report.tradeoffs=Object.fromEntries(['before','dataOnly','coreOnly','after'].map(variant=>[variant,{yaw:report.cases.reduce((s,r)=>s+Math.abs(r[variant].error.yawDegrees),0)/report.cases.length,pitch:report.cases.reduce((s,r)=>s+Math.abs(r[variant].error.pitchDegrees),0)/report.cases.length,mouth:report.cases.reduce((s,r)=>s+r[variant].error.mouth,0)/report.cases.length,total:report.cases.reduce((s,r)=>s+r[variant].error.total,0)/report.cases.length}]));
const files={};for(const c of exports.values()){const name=`photo-${Object.keys(files).length}.webp`;await fs.writeFile(`${qa}/${name}`,await photo(c));files[c.id]=name;}
await fs.writeFile(`${qa}/cases.json`,JSON.stringify({files,cases:report.cases}));
await fs.writeFile(`${out}/heldout.json`,JSON.stringify(report,null,2));
console.log('WINK_INDEX_EVALUATION '+JSON.stringify({...report,cases:undefined}));
