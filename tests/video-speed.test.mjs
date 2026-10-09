import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWindowCache, createReviewYield } from '../app/live/review-work-cache.ts';

test('ordered candidate windows preserve reference and tie order',()=>{
 const cache=new ReviewWindowCache(2,6),a=[{id:'a'},{id:'b'}];
 cache.set(['one','two'],a);assert.equal(cache.get(['one','two']),a);
 assert.equal(cache.get(['two','one']),null);
 cache.set(['three'],[{id:'c'}]);cache.get(['one','two']);
 cache.set(['four'],[{id:'d'}]);assert.equal(cache.get(['three']),null);
 assert.equal(cache.get(['one','two']),a);
 cache.clear();assert.equal(cache.stats().references,0);
});
test('window caches bound references and never truncate oversized candidate sets',()=>{
 const cache=new ReviewWindowCache(8,5);const a=[1,2,3],b=[4,5,6];
 cache.set(['a'],a);cache.set(['b'],b);assert.equal(cache.get(['a']),null);assert.equal(cache.get(['b']),b);
 cache.set(['large'],Array(6).fill(1));assert.equal(cache.get(['large']),null);assert.ok(cache.stats().references<=5);
});
test('cooperative yielding processes a real task and closes its ports',async()=>{
 const pause=createReviewYield(10000);try{
  assert.equal(pause.checkpoint(),null);
  let done=false;const promise=pause.checkpoint(true).then(()=>{done=true;});
  assert.equal(done,false);await promise;assert.equal(done,true);
  await Promise.all([pause.checkpoint(true),pause.checkpoint(true)]);
  assert.equal(pause.stats.yields,3);
 }finally{pause.close();}
 assert.throws(()=>pause.checkpoint(),{name:'AbortError'});
});
test('cancelling a pending yield rejects instead of leaking a task',async()=>{
 const pause=createReviewYield();const promise=pause.checkpoint(true);pause.close();
 await assert.rejects(promise,{name:'AbortError'});
});
