import test from 'node:test';
import assert from 'node:assert/strict';
import { TopK } from '../app/live/astra/top-k.ts';
import { ReusableLiveSearchIndex } from '../app/live/astra/live-search-index.ts';
import { ParsedShardCache } from '../app/live/astra/catalog-neighborhood.ts';
import { bruteRank, random } from './helpers/astra-search-oracle.mjs';

test('bounded heap preserves full-sort order, ties, negative scores and infinities',()=>{
  const r=random(963),rows=Array.from({length:1000},(_,i)=>({i,score:i%17===0?Infinity:Math.round(r()*20)/8-.5}));
  const sorted=rows.slice().sort((a,b)=>a.score-b.score||a.i-b.i);
  for(const k of [1,2,16,48,128,1000,1200]) {
    const heap=new TopK(k);
    for(const row of rows.slice().reverse()) heap.offer(row.i,row.score);
    assert.deepEqual(heap.sorted(),sorted.slice(0,k));
  }
});

test('optimized shortlist exactly matches an independent full-sort oracle',()=>{
  const r=random(7229),shapes=[0,3,9,13,27];
  const candidates=Array.from({length:330},(_,i)=>({id:`face-${i}`,feature:Array.from({length:55},(_,d)=>d<3?r()*2-1:r()),geometry:{structure:Float32Array.from({length:shapes[i%5]},()=>r()),projection:i%11===0?undefined:Float32Array.from({length:936},()=>r()*2-1)}}));
  candidates.push({...candidates[12],id:'tied-copy-1'},{...candidates[12],id:'tied-copy-2'});
  const index=new ReusableLiveSearchIndex(candidates);
  for(let n=0;n<45;n++) {
    const source=candidates[Math.floor(r()*candidates.length)],feature=source.feature.map((v,i)=>v+(i<3?(r()-.5)*.05:0));
    const frame={feature,geometry:source.geometry},budget=[1,2,16,48,128,999][n%6];
    const previous=n%3===0?[]:n%3===1?['face-300','missing','face-300']:candidates.filter((_,i)=>i%3===0).map(c=>c.id);
    const got=index.query(frame,{budget,previousIds:previous});
    assert.deepEqual(got.candidates.map(c=>c.id),bruteRank(candidates,frame,budget,previous),`query ${n}`);
    assert.equal(got.inspected,candidates.length);
    assert.ok(index.lastFullyScored<=candidates.length);
  }
});

test('pose bound never drops a tied boundary or a forced far-away recent candidate',()=>{
  const geometry={structure:new Float32Array(27),projection:new Float32Array(936)};
  const candidates=Array.from({length:3000},(_,i)=>({id:String(i),feature:[i<200?0:i/3000,0,0,...Array(52).fill(0)],geometry}));
  const index=new ReusableLiveSearchIndex(candidates),query=candidates[0];
  const result=index.query(query,{budget:48,previousIds:['2999']});
  assert.deepEqual(result.candidates.map(c=>c.id),['2999',...Array.from({length:47},(_,i)=>String(i))]);
  assert.ok(index.lastFullyScored<300,'far candidates should be bounded, not fully rescored');
});

function replay(policy) {
  const cache=new ParsedShardCache(48,policy);let misses=0;
  const visit=names=>{const protectedNames=new Set(names);for(const name of names){cache.touch(name);if(!cache.has(name)){misses++;cache.set(name,[name],protectedNames);}}assert.ok(cache.size<=48);};
  for(let cycle=0;cycle<12;cycle++) {
    for(let pose=0;pose<3;pose++) {
      const hot=Array.from({length:9},(_,i)=>`hot-${pose}-${i}`);
      visit(hot);visit(hot);
      for(let step=0;step<4;step++)visit(Array.from({length:6},(_,i)=>`transition-${cycle}-${pose}-${step}-${i}`));
    }
  }
  return {misses,cache};
}

test('frequency admission resists one-pass scan pollution without increasing 48-shard capacity',()=>{
  const lru=replay('lru'),frequency=replay('frequency');
  assert.ok(frequency.misses<lru.misses,JSON.stringify({lru:lru.misses,frequency:frequency.misses}));
  assert.equal(frequency.cache.size,48);
  assert.ok(frequency.cache.stats().shardHistoryEntries<=768);
});

test('demand history ages, current demand can replace old hot poses, and every cap remains hard',()=>{
  const cache=new ParsedShardCache(2,'frequency');
  cache.set('old-a',1);cache.set('old-b',2);
  for(let i=0;i<50;i++){cache.touch('old-a');cache.touch('old-b');}
  for(let i=0;i<100;i++){const key=`new-${i%2}`;cache.touch(key);cache.set(key,i,new Set(['new-0','new-1']));}
  assert.equal(cache.has('new-0'),true);assert.equal(cache.has('new-1'),true);
  for(let i=0;i<1000;i++){const key=`scan-${i}`;cache.touch(key);cache.set(key,i,new Set(['old-a','old-b',key,...cache.keysNewestFirst()]));assert.ok(cache.size<=2);}
  assert.ok(cache.stats().shardHistoryEntries<=256);
});

test('peek and stats do not create artificial popularity; read-only scans preserve LRU ties',()=>{
  const cache=new ParsedShardCache(2,'frequency');cache.set('a',1);cache.set('b',2);
  const before=cache.stats();for(let i=0;i<100;i++){cache.peek('a');cache.keysNewestFirst();cache.stats();}
  assert.deepEqual(cache.stats(),before);
  cache.set('c',3);assert.equal(cache.has('a'),false);assert.equal(cache.has('b'),true);
});
