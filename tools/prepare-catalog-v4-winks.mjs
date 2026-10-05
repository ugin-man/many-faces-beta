import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {liveCandidateFromEntry} from '../app/live-matching.ts';
import {winkEvidence} from '../app/live/wink-evidence.ts';
import {parseWinkSupport} from '../app/live/wink-support.ts';
const root=path.resolve(process.argv[2]||'public/seed-catalog');
const out=path.resolve(process.argv[3]||'work/v4-winks');
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.totalFaces,70000);
assert.match(manifest.catalogId,/^many-faces-visible-v4-/);
assert.equal(manifest.stats.quality.policy,'visible-exact-pixels-v4.1');
const groups=new Map(),all=new Map();
for(const cell of Object.values(manifest.cells))for(const file of cell.shards??[cell.shard]){
 const payload=JSON.parse(await fs.readFile(path.join(root,'shards',file),'utf8'));
 for(const entry of payload.items){
  all.set(entry.id,entry);
  const candidate=liveCandidateFromEntry(entry,file);
  if(!candidate)throw new Error('Malformed admitted face '+entry.id);
  const e=winkEvidence(candidate.feature,candidate.geometry.projection);
  if(!e)continue;
  const key=[e.side,Math.round(entry.feature[0]*90/9),Math.round(entry.feature[1]*90/9),entry.qualityV4.expression].join('|');
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push({...entry,side:e.side,supportKind:'core-refresh',imageSha256:entry.qualityV4.pixelSha256});
 }
}
assert.equal(all.size,70000);
for(const values of groups.values())values.sort((a,b)=>b.qualityV4.sharpness-a.qualityV4.sharpness||a.id.localeCompare(b.id));
const items=[],keys=[...groups.keys()].sort();
let available=true;
while(items.length<512&&available){available=false;for(const key of keys){const next=groups.get(key).shift();if(next){items.push(next);available=true;}if(items.length===512)break;}}
const payload={schemaVersion:3,baseCatalogId:manifest.catalogId,policy:'same-physical-catalog-descriptors-v4',items};
while(Buffer.byteLength(JSON.stringify(payload))>3800000)items.pop();
const parsed=parseWinkSupport(payload,'https://catalog.test',manifest.catalogId);
const sides={left:parsed.filter(x=>x.supportSide==='left').length,right:parsed.filter(x=>x.supportSide==='right').length};
assert(sides.left>0&&sides.right>0,'Missing a wink side in admitted catalog');
for(const item of items){
 const original=all.get(item.id);
 for(const key of ['feature','shape','mesh','projection','layout','pack','offset','length'])assert.deepEqual(item[key],original[key]);
}
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'catalog.json'),JSON.stringify(payload));
const report={catalogId:manifest.catalogId,indexedPhotos:items.length,sides,bytes:Buffer.byteLength(JSON.stringify(payload)),
 outsidePhotos:0,descriptorOverrides:0,originalBaseTreeUsed:false,allRowsFromAdmittedPhysicalCatalog:true,humanVerified:false};
await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify(report,null,2)+'\n');
console.log('V4_WINK_RECEIPT '+JSON.stringify(report));
