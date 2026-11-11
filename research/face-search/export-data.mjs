#!/usr/bin/env node
/** Export the complete pinned catalog into canonical-ID-ordered float64 arrays.
 * No face photographs, raw arrays, or per-face results should be committed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {liveCandidateFromEntry} from '../../app/live-matching.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PIN='ec97e233003e272cc203580953a180377945228d';
const config={catalog:path.join(root,'public/seed-catalog'),out:path.join(root,'work/face-search')};
for(let i=2;i<process.argv.length;i+=2) {
  const key={'--catalog':'catalog','--out':'out'}[process.argv[i]];
  if(!key||!process.argv[i+1])throw new Error(`Unknown or missing argument ${process.argv[i]}`);
  config[key]=path.resolve(process.argv[i+1]);
}
assert.equal(os.endianness(),'LE');
await fs.mkdir(config.out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const gitSha=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const sourceTree=execFileSync('git',['ls-tree','-r',PIN,'--','public/seed-catalog/manifest.json','public/seed-catalog/shards'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
const tree=new Map(sourceTree.trim().split('\n').filter(Boolean).map(line=>{const [head,file]=line.split('\t');return[file,head.split(' ')[2]];}));
const startedAt=new Date().toISOString();
const manifestBytes=await fs.readFile(path.join(config.catalog,'manifest.json'));
assert.equal(gitSha(manifestBytes),tree.get('public/seed-catalog/manifest.json'),'Catalog manifest differs from source pin');
const manifest=JSON.parse(manifestBytes);
assert.equal(manifest.totalFaces,70000);
const shards=[...new Set(Object.values(manifest.cells).flatMap(cell=>cell.shards?.length?cell.shards:cell.shard?[cell.shard]:[]))].sort();
assert.equal(shards.length,775);
const seen=new Set(),records=[],hashes=[];
for(let i=0;i<shards.length;i++) {
  const file=shards[i];
  assert.match(file,/^[A-Za-z0-9_.+-]+\.json$/);
  const bytes=await fs.readFile(path.join(config.catalog,'shards',file));
  const hash=gitSha(bytes);
  assert.equal(hash,tree.get(`public/seed-catalog/shards/${file}`),`Catalog shard differs from source pin: ${file}`);
  const payload=JSON.parse(bytes); assert.ok(Array.isArray(payload.items));
  hashes.push({file,bytes:bytes.length,sha256:sha(bytes),gitBlobSha1:hash,records:payload.items.length});
  for(const entry of payload.items) {
    assert.equal(entry.feature.length,55);assert.ok(entry.feature.every(Number.isFinite));
    assert.ok(!seen.has(entry.id),`Duplicate ID ${entry.id}`);seen.add(entry.id);
    const candidate=liveCandidateFromEntry(entry,file);
    assert.ok(candidate,`Production admission rejected ${entry.id}`);
    assert.equal(candidate.geometry.projection.length,936);
    assert.ok(candidate.geometry.projection.every(Number.isFinite));
    records.push({id:candidate.id,feature:candidate.feature,projection:candidate.geometry.projection,shard:file});
  }
  if((i+1)%100===0||i+1===shards.length)console.log('CATALOG_PROGRESS '+JSON.stringify({shards:i+1,total:shards.length,records:records.length}));
}
assert.equal(records.length,70000);assert.equal(seen.size,70000);
records.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
const files={};
await fs.writeFile(path.join(config.out,'source-catalog-manifest.json'),manifestBytes);
files['source-catalog-manifest.json']={bytes:manifestBytes.length,sha256:sha(manifestBytes)};
for(const [name,key,dimension] of [['candidates.features.f64','feature',55],['candidates.projections.f64','projection',936]]) {
  const handle=await fs.open(path.join(config.out,name),'w'); const digest=createHash('sha256');let bytes=0;
  try {
    for(let start=0;start<records.length;start+=1024) {
      const batch=records.slice(start,start+1024),array=new Float64Array(batch.length*dimension);
      for(let i=0;i<batch.length;i++)array.set(batch[i][key],i*dimension);
      const buffer=Buffer.from(array.buffer);await handle.write(buffer);digest.update(buffer);bytes+=buffer.length;
    }
  } finally {await handle.close();}
  files[name]={shape:[records.length,dimension],dtype:'<f8',bytes,sha256:digest.digest('hex')};
}
for(const [name,value] of [['candidate-ids.json',records.map(x=>x.id)],['candidate-shards.json',records.map(x=>x.shard)]]) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');await fs.writeFile(path.join(config.out,name),bytes);files[name]={bytes:bytes.length,sha256:sha(bytes)};
}
const metadata={schema:'many-faces-catalog-arrays-v1',sourceCommit:PIN,catalogId:manifest.catalogId,startedAt,finishedAt:new Date().toISOString(),
  records:records.length,uniqueIds:seen.size,shards:shards.length,order:'Ascending JavaScript string ID order, shared by all arrays and shard labels',
  manifestSha256:sha(manifestBytes),sourceManifestGitBlobSha1:gitSha(manifestBytes),
  catalogContentSha256:sha(JSON.stringify({manifest:sha(manifestBytes),shards:hashes.map(x=>[x.file,x.sha256])})),
  preparation:'All original catalog records admitted through production liveCandidateFromEntry. Signed little-endian int16 / 4096 projection decoded to production Float32 then promoted exactly to float64. Original feature doubles retained. No candidate removed, synthesized, or duplicated.',
  files,sourceShards:hashes};
await fs.writeFile(path.join(config.out,'catalog.manifest.json'),JSON.stringify(metadata,null,2)+'\n');
console.log('CATALOG_COMPLETE '+JSON.stringify({records:metadata.records,catalogContentSha256:metadata.catalogContentSha256,out:config.out}));
