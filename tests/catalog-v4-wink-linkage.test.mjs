import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseWinkSupport} from '../app/live/wink-support.ts';
const legacy=JSON.parse(await readFile(new URL('../public/wink-support/v1/catalog.json',import.meta.url),'utf8'));
const original=legacy.items.find(x=>x.supportKind==='core-refresh');
const catalog='many-faces-visible-v4-unit-fixture';
// Schema test double only. These declarations are not image-quality evidence.
const entry={...original,qualityV4:{policy:'visible-exact-pixels-v4.1',pixelSha256:original.imageSha256,attributes:[0,1,0,0,0],faceAttributes:[0,1,0,0,0]}};
const payload={schemaVersion:3,baseCatalogId:catalog,items:[entry]};
test('v4 indexes require the manifest identity, not the old catalog constant',()=>{
 assert.throws(()=>parseWinkSupport(payload,'https://example.test'),/CATALOG_MISMATCH/);
 assert.throws(()=>parseWinkSupport(payload,'https://example.test',catalog+'-wrong'),/CATALOG_MISMATCH/);
 assert.throws(()=>parseWinkSupport(legacy,'https://example.test',catalog),/CATALOG_MISMATCH/);
 const result=parseWinkSupport(payload,'https://example.test',catalog);
 assert.deepEqual(result[0].feature,original.feature);
 assert.equal(new URL(result[0].url).searchParams.get('catalog'),catalog);
});
test('v4 overlay cannot bring back opaque eyewear, masks or outside photos',()=>{
 for(const patch of [{attributes:[0,1,0,0,.9]},{faceAttributes:[0,1,0,.9,0]},{attributes:[0,1,0,.21,0]},{pixelSha256:'0'.repeat(64)}]){
  assert.throws(()=>parseWinkSupport({...payload,items:[{...entry,qualityV4:{...entry.qualityV4,...patch}}]},'https://example.test',catalog));
 }
 assert.throws(()=>parseWinkSupport({...payload,items:[{...entry,supportKind:'addition'}]},'https://example.test',catalog));
});
test('legacy index stays readable only for its original catalog',()=>{
 assert.equal(parseWinkSupport(legacy,'https://example.test','many-faces-clean-core-v3').length,277);
});
