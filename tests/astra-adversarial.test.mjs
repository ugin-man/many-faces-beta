import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestFrameGate, qualityBoundedReadyChoice } from '../app/live/astra/runtime.ts';
import { DecodedImageCache } from '../app/live/astra/image-cache.ts';
import { ParsedShardCache } from '../app/live/astra/catalog-neighborhood.ts';
import { decodeCatalogVector } from '../app/live-matching.ts';
import { ReusableLiveSearchIndex } from '../app/live/astra/live-search-index.ts';
import { FACE_ACTION_FEATURE_INDEX } from '../app/face-actions.ts';

const candidate = (id, score = 0.1) => ({ id, score, name:id, url:`https://test.invalid/${id}` });
async function until(predicate, timeout = 1000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail('asynchronous condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
function mockImages(t) {
  const fetch = globalThis.fetch, decode = globalThis.createImageBitmap;
  t.after(() => { globalThis.fetch=fetch; globalThis.createImageBitmap=decode; });
  globalThis.fetch = async () => new Response(new Uint8Array([1]));
  globalThis.createImageBitmap = async () => ({ width:4, height:4, close() {} });
}

test('20 Hz target does not silently become 15 Hz on a 30 Hz camera', () => {
  for (const sourceHz of [30,60]) {
    const gate = new LatestFrameGate();
    for (let i=0;i<sourceHz*3;i++) {
      const now=i*1000/sourceHz, id=gate.reserve(now,i/sourceHz,20);
      if (id!==null) gate.complete(id,now+1);
    }
    assert.equal(gate.accepted,60,`${sourceHz} Hz input`);
  }
});

test('a stalled inference never accumulates catch-up frames', () => {
  const gate=new LatestFrameGate(), first=gate.reserve(0,0,20);
  for (let i=1;i<60;i++) assert.equal(gate.reserve(i*16.7,i/60,20),null);
  gate.complete(first,1000);
  const fresh=gate.reserve(1001,1.1,20);
  assert.notEqual(fresh,null);
  assert.equal(gate.complete(fresh,1002),true);
  assert.equal(gate.reserve(1003,1.2,20),null);
});

test('a cached but now-wrong face can settle after motion has stopped', () => {
  const ranked=[candidate('new',0.01),candidate('old',0.9)];
  assert.equal(qualityBoundedReadyChoice(ranked,()=>true,'old',false)?.id,'new');
  const close=[candidate('new',0.01),candidate('old',0.02)];
  assert.equal(qualityBoundedReadyChoice(close,()=>true,'old',false)?.id,'old');
});

test('three cached, out-of-quality faces cannot starve a new winner', async t => {
  mockImages(t);
  const cache=new DecodedImageCache(()=>{});
  t.after(()=>cache.clear());
  cache.prime(['a','b','c'].map(id=>candidate(id)));
  await until(()=>cache.stats().readyImages===3);
  cache.prime([candidate('winner',0.01),...['a','b','c'].map(id=>candidate(id,0.9))]);
  await until(()=>cache.has(candidate('winner')));
  assert.equal(cache.stats().imageRequests,4);
});

test('best candidate is still fetched when three close but inferior images are cached', async t => {
  mockImages(t);
  const cache=new DecodedImageCache(()=>{});
  t.after(()=>cache.clear());
  cache.prime(['a','b','c'].map(id=>candidate(id)));
  await until(()=>cache.stats().readyImages===3);
  cache.prime([candidate('winner',0.09),...['a','b','c'].map(id=>candidate(id,0.1))]);
  await until(()=>cache.has(candidate('winner')));
});

test('A-to-B-to-A cancellation releases the aborted slot and schedules a fresh A', async t => {
  mockImages(t);
  const cache=new DecodedImageCache(()=>{},1024,8,1);
  t.after(()=>cache.clear());
  cache.prime([candidate('a')]);
  cache.prime([candidate('b')]);
  cache.prime([candidate('a')]);
  await until(()=>cache.has(candidate('a')));
  assert.equal(cache.stats().pendingImages,0);
});

test('even an oversized protected set cannot bypass the shard cache hard limit', () => {
  const cache=new ParsedShardCache(2), protect=new Set(['a','b','c']);
  for (const key of protect) cache.set(key,[],protect);
  assert.equal(cache.size,2);
});

test('direct vector decoder preserves every signed int16 value exactly', () => {
  const bytes=Buffer.alloc(65536*2);
  for (let i=0;i<65536;i++) bytes.writeInt16LE(i-32768,i*2);
  const decoded=decodeCatalogVector(bytes.toString('base64'));
  assert.equal(decoded.length,65536);
  for (let i=0;i<decoded.length;i++) assert.equal(decoded[i],(i-32768)/4096);
  assert.equal(decodeCatalogVector('!invalid'),null);
  assert.equal(decodeCatalogVector('AQ=='),null);
});

test('an exact rare candidate beyond the old 2400 stride limit remains searchable', () => {
  const geometry={structure:new Float32Array(13),projection:new Float32Array(936)};
  const candidates=Array.from({length:3000},(_,i)=>({id:String(i),feature:Array(55).fill(0),geometry}));
  candidates[2999].feature[FACE_ACTION_FEATURE_INDEX.jawOpen]=0.95;
  const index=new ReusableLiveSearchIndex(candidates);
  const result=index.query(candidates[2999],{budget:128});
  assert.equal(index.size,3000);
  assert.equal(result.inspected,3000);
  assert.equal(result.candidates[0].id,'2999');
  assert.ok(index.query(candidates[2999],{budget:16,previousIds:['0']}).candidates.some(c=>c.id==='0'));
});
