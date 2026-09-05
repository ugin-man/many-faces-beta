import test from 'node:test';
import assert from 'node:assert/strict';
import { DecodedImageCache } from '../app/live/astra/image-cache.ts';
const candidate = (id) => ({id,name:id,score:0,url:`http://fixture/${id}`});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve,ms));

test('decode timeout releases the slot and closes a bitmap that arrives too late', async (t) => {
  const oldFetch=globalThis.fetch, oldDecode=globalThis.createImageBitmap;
  t.after(() => { globalThis.fetch=oldFetch; globalThis.createImageBitmap=oldDecode; });
  globalThis.fetch=async () => new Response(new Uint8Array([1]),{headers:{'content-type':'image/webp'}});
  let finishDecode;
  globalThis.createImageBitmap=() => new Promise((resolve)=>{finishDecode=resolve;});
  const cache=new DecodedImageCache(()=>{},1024,2,1,20);
  t.after(()=>cache.clear());
  cache.prime([candidate('slow')]);
  await delay(50);
  assert.equal(cache.stats().pendingImages,0);
  assert.equal(cache.stats().imageFailures,1);
  let closed=0;
  finishDecode({width:2,height:2,close(){closed++;}});
  await delay(0);
  assert.equal(closed,1);
  assert.equal(cache.stats().readyImages,0);
});

test('cache has bounded bytes and closes evicted and cleared native image resources', async (t) => {
  const oldFetch=globalThis.fetch, oldDecode=globalThis.createImageBitmap;
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.createImageBitmap=oldDecode;});
  globalThis.fetch=async()=>new Response(new Uint8Array([1]));
  let closed=0;
  globalThis.createImageBitmap=async()=>({width:4,height:4,close(){closed++;}});
  const cache=new DecodedImageCache(()=>{},128,2,1);
  t.after(()=>cache.clear());
  cache.prime([candidate('a'),candidate('b'),candidate('c')]);
  await delay(30);
  assert.equal(cache.stats().readyImages,2);
  assert.equal(cache.stats().imageBytes,128);
  assert.equal(closed,1);
  cache.clear();
  assert.equal(closed,3);
  assert.equal(cache.stats().imageBytes,0);
});

test('clearing a session aborts image requests and never dispatches its queued work', async (t) => {
  const oldFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  let active=0,maximum=0,requests=0;
  globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
    active++;requests++;maximum=Math.max(maximum,active);
    signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true});
  });
  const cache=new DecodedImageCache(()=>{},1024,3,3);
  cache.prime(Array.from({length:8},(_,i)=>candidate(String(i))));
  assert.equal(maximum,3);
  cache.clear();
  await delay(0);
  assert.equal(requests,3);
  assert.equal(active,0);
  assert.equal(cache.stats().pendingImages,0);
});
