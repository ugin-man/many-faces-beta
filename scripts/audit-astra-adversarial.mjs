import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as currentRuntime from '../app/live/astra/runtime.ts';
import { DecodedImageCache } from '../app/live/astra/image-cache.ts';
import { ParsedShardCache } from '../app/live/astra/catalog-neighborhood.ts';
import * as currentMatching from '../app/live-matching.ts';
import { ReusableLiveSearchIndex } from '../app/live/astra/live-search-index.ts';

const baselineDir=path.resolve(process.env.ASTRA_BASELINE_DIR || 'work/astra-baseline');
const out=path.resolve('work/astra-adversarial');
await mkdir(out,{recursive:true});
const load=relative=>import(pathToFileURL(path.join(baselineDir,relative)).href);
const oldRuntime=await load('app/live/astra/runtime.ts');
const oldCache=await load('app/live/astra/image-cache.ts');
const oldNeighborhood=await load('app/live/astra/catalog-neighborhood.ts');
const oldMatching=await load('app/live-matching.ts');
const report={baselineCommit:execFileSync('git',['-C',baselineDir,'rev-parse','HEAD']).toString().trim(),testedCommit:process.env.GITHUB_SHA || null,physicalCameraVerified:false,privateUserVideoUsed:false,reproductions:{},assetAudit:{},benchmarks:{}};
const candidate=(id,score=0.1)=>({id,score,name:id,url:`https://test.invalid/${id}`});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function cadence(Runtime) {
  const gate=new Runtime.LatestFrameGate();
  for(let i=0;i<90;i++){const now=i*1000/30,id=gate.reserve(now,i/30,20);if(id!==null)gate.complete(id,now+1);}
  return gate.accepted;
}
async function starvation(Cache) {
  const originalFetch=globalThis.fetch, originalBitmap=globalThis.createImageBitmap;
  globalThis.fetch=async()=>new Response(new Uint8Array([1]));
  globalThis.createImageBitmap=async()=>({width:4,height:4,close(){}});
  const cache=new Cache(()=>{});
  try {
    cache.prime(['a','b','c'].map(id=>candidate(id)));
    for(let i=0;i<100&&cache.stats().pendingImages;i++) await delay(2);
    assert.equal(cache.stats().readyImages,3);
    cache.prime([candidate('winner',0.01),...['a','b','c'].map(id=>candidate(id,0.9))]);
    for(let i=0;i<100&&cache.stats().pendingImages;i++) await delay(2);
    return {winnerLoaded:cache.has(candidate('winner')),requests:cache.requests};
  } finally {cache.clear();await delay(1);globalThis.fetch=originalFetch;globalThis.createImageBitmap=originalBitmap;}
}
function protectedSize(Cache) {
  const cache=new Cache(2),protectedNames=new Set(['a','b','c']);
  for(const name of protectedNames)cache.set(name,[],protectedNames);
  return cache.size;
}
report.reproductions.cadence={inputHz:30,targetHz:20,seconds:3,before:cadence(oldRuntime),after:cadence(currentRuntime),expected:60};
report.reproductions.prefetchStarvation={before:await starvation(oldCache.DecodedImageCache),after:await starvation(DecodedImageCache)};
const ranking=[candidate('new',0.01),candidate('old',0.9)];
report.reproductions.staticSettling={before:oldRuntime.qualityBoundedReadyChoice(ranking,()=>true,'old',false)?.id ?? null,after:currentRuntime.qualityBoundedReadyChoice(ranking,()=>true,'old',false)?.id ?? null};
report.reproductions.cacheHardCap={before:protectedSize(oldNeighborhood.ParsedShardCache),after:protectedSize(ParsedShardCache),capacity:2};
assert.equal(report.reproductions.cadence.before,45);assert.equal(report.reproductions.cadence.after,60);
assert.equal(report.reproductions.prefetchStarvation.before.winnerLoaded,false);assert.equal(report.reproductions.prefetchStarvation.after.winnerLoaded,true);
assert.equal(report.reproductions.staticSettling.before,null);assert.equal(report.reproductions.staticSettling.after,'new');
assert.equal(report.reproductions.cacheHardCap.before,3);assert.equal(report.reproductions.cacheHardCap.after,2);

const root=path.resolve('public/seed-catalog');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const manifest=await json(path.join(root,'manifest.json'));
const sortedCells=Object.entries(manifest.cells).sort(([a],[b])=>{const [ay,ap]=a.split(':').map(Number),[by,bp]=b.split(':').map(Number);return ay*ay+ap*ap-(by*by+bp*bp);});
const benchmarkFiles=new Set(sortedCells.slice(0,24).flatMap(([,cell])=>cell.shards ?? [cell.shard]));
const allFiles=[...new Set(sortedCells.flatMap(([,cell])=>cell.shards ?? [cell.shard]))];
const ids=new Set(),imageHashes=new Set(),profiles={},pool=[],rawPool=[];
let itemCount=0,duplicateImages=0,vectorCount=0,vectorValuesCompared=0,decodedImageSamples=0;
const require=createRequire(import.meta.url),{loadImage}=require('@napi-rs/canvas');
let retainedPackName=null,retainedPack=null;
for(const file of allFiles) {
  const payload=await json(path.join(root,'shards',file));
  for(let i=0;i<payload.items.length;i++) {
    const item=payload.items[i];itemCount++;
    assert.ok(item.id&&!ids.has(item.id),'duplicate/missing catalog ID');ids.add(item.id);
    assert.equal(item.feature.length,55);assert.ok(item.feature.every(Number.isFinite));
    profiles[item.cleanProfile ?? 'unlabelled']=(profiles[item.cleanProfile ?? 'unlabelled'] ?? 0)+1;
    for(const key of ['shape','mesh','projection']) {
      if(key==='mesh'&&!item[key])continue; // Legacy loader permits projection fallback.
      const before=oldMatching.decodeCatalogVector(item[key]),after=currentMatching.decodeCatalogVector(item[key]);
      assert.ok(before&&after,`invalid ${key}`);assert.equal(before.length,after.length);
      for(let k=0;k<before.length;k++)assert.equal(before[k],after[k],`decoder mismatch ${key}`);
      vectorCount++;vectorValuesCompared+=before.length;
    }
    assert.ok(Number.isSafeInteger(item.offset)&&Number.isSafeInteger(item.length)&&item.offset>=0&&item.length>0);
    assert.equal(path.basename(item.pack),item.pack);
    if(retainedPackName!==item.pack){retainedPack=await readFile(path.join(root,'packs',item.pack));retainedPackName=item.pack;}
    assert.ok(item.offset+item.length<=retainedPack.length,'image range exceeds pack');
    const image=retainedPack.subarray(item.offset,item.offset+item.length);
    assert.equal(image.toString('ascii',0,4),'RIFF');assert.equal(image.toString('ascii',8,12),'WEBP');
    assert.equal(image.readUInt32LE(4)+8,image.length,'RIFF length mismatch');
    const hash=createHash('sha256').update(image).digest('hex');
    if(imageHashes.has(hash))duplicateImages++;imageHashes.add(hash);
    // Actual pixel decoding covers first and last entries of every shard, not all entries.
    if(i===0||i===payload.items.length-1) {
      const decoded=await loadImage(image);
      assert.ok(decoded.width>0&&decoded.height>0);decodedImageSamples++;
    }
    if(benchmarkFiles.has(file)){rawPool.push(item);pool.push(currentMatching.liveCandidateFromEntry(item,file));}
  }
}
assert.equal(itemCount,70000);assert.equal(itemCount,manifest.totalFaces);assert.ok(pool.every(Boolean));
const assetTreeBefore=execFileSync('git',['-C',baselineDir,'rev-parse','HEAD:public/seed-catalog']).toString().trim();
const assetTreeAfter=execFileSync('git',['rev-parse','HEAD:public/seed-catalog']).toString().trim();
assert.equal(assetTreeBefore,assetTreeAfter,'catalog source was changed');
report.assetAudit={itemCount,uniqueIds:ids.size,uniqueEncodedImages:imageHashes.size,duplicateEncodedImages:duplicateImages,checkedImageRanges:itemCount,vectorCount,vectorValuesCompared,decoderMismatchCount:0,pixelDecodedSamples:decodedImageSamples,totalShards:allFiles.length,profileCounts:profiles,catalogTreeUnchanged:true,catalogTree:assetTreeAfter,notVerified:'Human-labelled expression correctness, identity-level diversity, and real-motion matching quality.'};

const samples=rawPool.slice(0,192);
function measure(fn,repeats=9){const times=[];for(let i=0;i<repeats+2;i++){const start=performance.now();fn();if(i>=2)times.push(performance.now()-start);}times.sort((a,b)=>a-b);return {medianMs:times[Math.floor(times.length/2)],p95Ms:times[times.length-1],repeats};}
report.benchmarks.decoder={entries:samples.length,before:measure(()=>samples.forEach(item=>oldMatching.liveCandidateFromEntry(item))),after:measure(()=>samples.forEach(item=>currentMatching.liveCandidateFromEntry(item)))};
const thinned=pool.length<=2400?pool:Array.from({length:2400},(_,i)=>pool[Math.floor(i*pool.length/2400)]);
report.benchmarks.indexRebuild={activeCandidates:pool.length,beforeIndexedCandidates:thinned.length,afterIndexedCandidates:pool.length,before:measure(()=>oldMatching.buildLiveCandidateIndex(thinned)),after:measure(()=>new ReusableLiveSearchIndex(pool))};
const oldIndex=oldMatching.buildLiveCandidateIndex(thinned),newIndex=new ReusableLiveSearchIndex(pool);
const probes=Array.from({length:24},(_,i)=>pool[Math.floor((i+0.5)*pool.length/24)]);
let oldHits=0,newHits=0;
for(const probe of probes){if(oldIndex.query(probe,{budget:128}).candidates.some(c=>c.id===probe.id))oldHits++;if(newIndex.query(probe,{budget:128}).candidates.some(c=>c.id===probe.id))newHits++;}
report.benchmarks.catalogSelfRetrieval={queries:probes.length,beforeHits:oldHits,afterHits:newHits,purpose:'Accessibility regression only: catalog-derived queries are not an independent motion-quality evaluation.'};
report.benchmarks.search24Queries={before:measure(()=>probes.forEach(p=>oldMatching.rankLiveCandidates(oldIndex,p,{budget:128,detailedLimit:48})),5),after:measure(()=>probes.forEach(p=>currentMatching.rankLiveCandidates(newIndex,p,{budget:128,detailedLimit:48})),5)};
report.passed=true;
await writeFile(path.join(out,'adversarial-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
