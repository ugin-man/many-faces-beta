import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import {rankProjectionCandidateModesTwoStage as reference} from '../app/projection-matching.ts';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
const out='work/video-rank';await fs.mkdir(out,{recursive:true});
const report={commit:process.env.GITHUB_SHA,reference:'unchanged app/projection-matching.ts .strict',passed:false,queries:[],timings:[]};
const hash=items=>createHash('sha256').update(JSON.stringify(items.map(x=>({id:x.candidate.id,error:x.error})))).digest('hex');
try{
 const root='public/seed-catalog';const manifest=JSON.parse(await fs.readFile(`${root}/manifest.json`,'utf8'));
 assert.equal(manifest.totalFaces,70000);const pool=[];let files=0;
 const shards=[...new Set(Object.values(manifest.cells).flatMap(cell=>cell.shards??[cell.shard]))];
 for(const name of shards){
  const data=JSON.parse(await fs.readFile(path.join(root,'shards',name),'utf8'));
  for(const entry of data.items){const c=liveCandidateFromEntry(entry,name);assert.ok(c);pool.push(c);}files++;
 }
 assert.equal(pool.length,70000);assert.equal(new Set(pool.map(c=>c.id)).size,70000);
 report.catalogFaces=pool.length;report.shards=files;
 const ranker=new ReviewStrictRanker();const input=[];
 for(let i=0;i<24;i++){
  const target=pool[Math.floor(i*(pool.length-1)/23)];const frame={time:i/20,feature:target.feature.slice(),geometry:target.geometry};
  // Also test queries between catalog records, not only exact self-matches.
  if(i%2){frame.feature[0]+=.017;frame.feature[1]-=.011;}
  input.push(frame);
  const old=reference(frame,pool,64,1024).strict,newer=ranker.rank(frame,pool,64,1024);
  assert.deepEqual(newer,old,`all-70k query ${i}`);
  report.queries.push({index:i,source:target.id,resultCount:newer.length,hash:hash(newer)});
 }
 // Warm component timing, not UI wall time: both candidates and descriptors
 // already reside in memory. The separate browser ABBA uses fresh profiles.
 for(const variant of ['before','after','after','before']){
  const started=performance.now();let checksum='';
  for(const frame of input.slice(0,8))checksum+=hash(variant==='before'?reference(frame,pool,64,1024).strict:ranker.rank(frame,pool,64,1024));
  report.timings.push({variant,queries:8,ms:performance.now()-started,checksum});
 }
 assert.equal(new Set(report.timings.map(t=>t.checksum)).size,1);
 report.rankerStats=ranker.stats();ranker.clear();report.passed=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{await fs.writeFile(`${out}/ranker-audit.json`,JSON.stringify(report,null,2));console.log('RANKER_AUDIT '+JSON.stringify(report));}
