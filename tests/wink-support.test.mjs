import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseWinkSupport,supportForFrame,rankWinkSupport} from '../app/live/wink-support.ts';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import {FACE_ACTION_FEATURE_INDEX as I} from '../app/face-actions.ts';
const raw=JSON.parse(await readFile(new URL('../public/wink-support/v1/catalog.json',import.meta.url),'utf8'));
const manifestBytes=await readFile(new URL('../public/seed-catalog/manifest.json',import.meta.url));
const manifest=JSON.parse(manifestBytes);
const binding={catalogId:manifest.catalogId,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),qualityAdmission:manifest.qualityAdmission};
const parse=value=>parseWinkSupport(value,'https://example.test',binding);
const support=parse(raw);
const frame=c=>({time:0,feature:c.feature,geometry:c.geometry});

test('the published index retains exact raw actions and the correct catalog provenance',()=>{
 assert.equal(support.length,raw.items.length);
 if(raw.schemaVersion===3){
  assert.equal(raw.baseCatalogManifestSha256,binding.manifestSha256);
  assert.equal(support.filter(c=>c.supportKind==='addition').length,0);
  assert.equal(support.filter(c=>c.supportKind==='core-refresh').length,support.length);
 }else{
  assert.equal(support.filter(c=>c.supportKind==='addition').length,6);
  assert.equal(support.filter(c=>c.supportKind==='core-refresh').length,271);
 }
 for(const c of support){
  const r=raw.items.find(x=>x.id===c.id);assert.deepEqual(c.feature,r.feature);
  const url=new URL(c.url);assert.equal(url.origin,'https://example.test');
  if(c.supportKind==='addition')assert.match(url.pathname,/^\/wink-support\/v1\/images\/wink-extra-[a-f0-9]{24}\.webp$/);
  else{assert.equal(url.pathname,'/api/catalog/image');assert.equal(url.searchParams.get('source'),'seed');if(raw.schemaVersion===3)assert.equal(url.searchParams.get('catalog'),binding.manifestSha256);}
 }
});
test('ordinary and bilateral-closure frames never enter the specialist path',()=>{
 const c=support[0],ranker=new ReviewStrictRanker();
 for(const [l,r] of [[0,0],[.8,.8],[.9,.7]]){
  const feature=[...c.feature];feature[I.eyeBlinkLeft]=l;feature[I.eyeBlinkRight]=r;
  const f={...frame(c),feature};assert.deepEqual(supportForFrame(f,support),[]);assert.equal(rankWinkSupport(f,support,ranker),null);
 }
});
test('only matching anatomical side and bounded poses are admitted; no data is mutated',()=>{
 for(const side of ['left','right']){
  const c=support.find(x=>x.supportSide===side),f=frame(c),copy=JSON.stringify(f);
  const candidates=supportForFrame(f,support);assert(candidates.length);
  assert(candidates.every(x=>x.supportSide===side&&Math.abs(x.feature[0]-f.feature[0])*90<=18&&Math.abs(x.feature[1]-f.feature[1])*90<=21));
  const ranked=rankWinkSupport(f,support,new ReviewStrictRanker());assert(ranked.length);assert(ranked.every(x=>x.candidate.supportSide===side));assert.equal(JSON.stringify(f),copy);
  assert.equal(rankWinkSupport(f,[],new ReviewStrictRanker()),null);
 }
});
test('malformed metadata, another base catalog and path escapes are rejected',()=>{
 assert.throws(()=>parse(raw.schemaVersion===3?{...raw,baseCatalogId:'wrong'}:{...raw,baseCatalogTree:'wrong'}));
 const extra=raw.items.find(x=>x.supportKind==='addition')??raw.items[0];
 for(const override of [{image:'../escape.webp'},{sourceUrl:'javascript:alert(1)'},{side:'unknown'},{feature:[]}])assert.throws(()=>parse({...raw,items:[{...extra,...override}]}));
 assert.throws(()=>parse({...raw,items:[extra,extra]}));
});
