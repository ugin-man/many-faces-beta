import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { liveCandidateFromEntry } from '../app/live-matching.ts';
import { ReusableLiveSearchIndex } from '../app/live/astra/live-search-index.ts';
import { ParsedShardCache, compilePoseCells, PoseNeighborhood } from '../app/live/astra/catalog-neighborhood.ts';
import { random } from '../tests/helpers/astra-search-oracle.mjs';

const baseline=process.env.ASTRA_BASELINE_DIR;
assert.ok(baseline,'An exact baseline worktree is required');
const {ReusableLiveSearchIndex:BeforeIndex}=await import(pathToFileURL(path.join(baseline,'app/live/astra/live-search-index.ts')).href);
const {ParsedShardCache:BeforeCache}=await import(pathToFileURL(path.join(baseline,'app/live/astra/catalog-neighborhood.ts')).href);
const root=path.resolve('public/seed-catalog'),out=path.resolve('work/astra-resource-audit');
await fs.mkdir(out,{recursive:true});
const report={testedCommit:process.env.GITHUB_SHA||null,baselineCommit:execFileSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtimeStillPoseLocal:true,physicalCameraVerified:false,privateUserVideoUsed:false,passed:false};
const median=v=>v.slice().sort((a,b)=>a-b)[Math.floor(v.length/2)];
function bench(fn,repeats=9){fn();fn();const values=[];for(let i=0;i<repeats;i++){const t=performance.now();fn();values.push(performance.now()-t);}return {medianMs:median(values),samplesMs:values};}
try {
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  const files=[...new Set(Object.values(manifest.cells).flatMap(c=>c.shards||[c.shard]))].sort();
  const all=[];
  for(const file of files){
    const payload=JSON.parse(await fs.readFile(path.join(root,'shards',file),'utf8'));
    for(const entry of payload.items){const c=liveCandidateFromEntry(entry,file);assert.ok(c,`invalid entry ${entry.id}`);all.push(c);}
  }
  assert.equal(all.length,70000);assert.equal(new Set(all.map(c=>c.id)).size,70000);
  const before=new BeforeIndex(all),after=new ReusableLiveSearchIndex(all),r=random(981551);
  let mismatches=0;const fullyScored=[];
  for(let i=0;i<32;i++){
    const src=all[Math.floor(r()*all.length)];
    const frame={feature:src.feature.map((v,d)=>v+(d<3?(r()-.5)*.025:(r()-.5)*.03)),geometry:src.geometry};
    const options={budget:[1,16,48,128,256][i%5],previousIds:i%2===0?[]:[all[Math.floor(r()*all.length)].id,all[Math.floor(r()*all.length)].id,'missing-id']};
    const a=before.query(frame,options).candidates.map(c=>c.id),b=after.query(frame,options).candidates.map(c=>c.id);
    if(JSON.stringify(a)!==JSON.stringify(b))mismatches++;
    fullyScored.push(after.lastFullyScored);
  }
  assert.equal(mismatches,0,'The bounded search changed a shortlist');
  report.exactSearch={assetRecordsRead:all.length,offlineCandidatesPerQuery:70000,perturbedQueries:32,mismatches,fullyScoredPerQuery:fullyScored,note:'Offline numerical-contract stress test, not global search enabled in the live route and not human-labelled matching accuracy.'};
  const active=all.filter((_,i)=>i%11===0),b=new BeforeIndex(active),a=new ReusableLiveSearchIndex(active);
  const queries=Array.from({length:24},()=>active[Math.floor(r()*active.length)]);
  report.queryTiming={activeCandidates:active.length,queriesPerRepeat:queries.length,before:bench(()=>queries.forEach(q=>b.query(q,{budget:128}))),after:bench(()=>queries.forEach(q=>a.query(q,{budget:128})))};
  const cells=compilePoseCells(manifest.cells),traces={repeatedSweep:[],changingRoute:[],stationary:[]};
  for(let cycle=0;cycle<8;cycle++){
    for(const yaw of [0,0,0,3,6,9,12,15,18,18,18,15,12,9,6,3,0,-3,-6,-9,-12,-15,-18,-18,-18,-15,-12,-9,-6,-3])traces.repeatedSweep.push([yaw,0]);
    for(let step=0;step<40;step++)traces.changingRoute.push([Math.sin((cycle*40+step)/15)*35,Math.cos((cycle*40+step)/19)*20]);
    for(let step=0;step<40;step++)traces.stationary.push([.2*Math.sin(step),.2*Math.cos(step)]);
  }
  const replay=(Cache,trace)=>{
    const cache=new Cache(48),neighborhood=new PoseNeighborhood(cells,manifest.poseStep||3);let misses=0,highWater=0,demands=0;
    for(const [yaw,pitch] of trace){const n=neighborhood.update(yaw,pitch);if(!n.changed)continue;const keep=new Set(n.files);
      for(const name of n.files){demands++;cache.touch(name);if(!cache.has(name)){misses++;cache.set(name,[name],keep);}}
      highWater=Math.max(highWater,cache.size);assert.ok(cache.size<=48);
    }
    return {demands,misses,highWater};
  };
  report.cacheReplay=Object.fromEntries(Object.entries(traces).map(([name,trace])=>[name,{before:replay(BeforeCache,trace),after:replay(ParsedShardCache,trace)}]));
  report.cacheReplayMeaning='Controlled pose paths over real manifest cells with synchronous completed loads; this is not an HTTP request-count forecast.';
  report.catalogTree=execFileSync('git',['rev-parse','HEAD:public/seed-catalog'],{encoding:'utf8'}).trim();
  assert.equal(report.catalogTree,execFileSync('git',['-C',baseline,'rev-parse','HEAD:public/seed-catalog'],{encoding:'utf8'}).trim());
  report.catalogTreeUnchanged=true;report.passed=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'numerical-and-cache-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
