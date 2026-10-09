import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {admittedCoreWink, boundedWinkIndex} from '../scripts/rebuild-clean-wink-support.mjs';
import {parseWinkSupport, WINK_SUPPORT_BASE_TREE} from '../app/live/wink-support.ts';
import {FACE_ACTION_FEATURE_INDEX as I} from '../app/face-actions.ts';

// Retained historical photographs are fixtures only; these tests do not admit
// them into a production catalog or bypass the generation-time quality checks.
const pilot=JSON.parse(await readFile(new URL('../data/wink-pilot/catalog.json',import.meta.url),'utf8'));
const policySha256='a'.repeat(64),manifestSha256='b'.repeat(64),reviewSha256='c'.repeat(64),receiptSha256='d'.repeat(64),recordsSha256='e'.repeat(64);
const reviewStamp={schemaVersion:1,documentKind:'clean-core-wink-expression-review',mode:'confirmed-side-only',reviewSha256,candidateAuditSha256:receiptSha256,recordsSha256,reviewer:'assistant-visual-review',humanVerified:false};
const binding={catalogId:'test-admitted-core',manifestSha256,qualityAdmission:{schemaVersion:2,status:'complete',selectedCount:70000,policySha256,receiptSha256,recordsSha256,runtimeExclusionOverlayRequired:false},winkExpressionReview:reviewStamp};
const header={schemaVersion:3,baseCatalogId:binding.catalogId,baseCatalogManifestSha256:manifestSha256,policySha256,winkExpressionReviewSha256:reviewSha256};
const winkReview={sha256:reviewSha256,sides:new Map(),stamp:reviewStamp};
const samples=[];
for(const side of ['left','right']){
 const extra=pilot.items.find(row=>row.side===side);
 const bytes=await readFile(new URL('../data/wink-pilot/images/'+extra.image,import.meta.url));
 const fields={...extra};delete fields.image;
 const imageSha256=createHash('sha256').update(bytes).digest('hex');
 const entry={...fields,id:'clean-v5-'+imageSha256.slice(0,28),pack:'test-admitted.bin',offset:0,length:bytes.length,admissionSha256:imageSha256,admissionPolicySha256:policySha256,cleanProfile:side==='left'?'winkLeft':'winkRight',cleanTier:'observed',winkExpressionEvidence:{schemaVersion:1,encodedSha256:imageSha256,side,reviewSha256}};
 winkReview.sides.set(imageSha256,side);
 samples.push({entry,bytes,row:admittedCoreWink(entry,bytes,policySha256,winkReview)});
}
const payload={...header,items:samples.map(sample=>sample.row)};

test('old unstamped catalogs retain legacy wink behavior, while stamped cores reject legacy support',()=>{
 const legacy={schemaVersion:1,baseCatalogTree:WINK_SUPPORT_BASE_TREE,items:[pilot.items[0]]};
 assert.equal(parseWinkSupport(legacy,'https://example.test')[0].supportKind,'addition');
 assert.equal(parseWinkSupport(legacy,'https://example.test',{catalogId:'old',qualityAdmission:undefined}).length,1);
 assert.throws(()=>parseWinkSupport(legacy,'https://example.test',binding),/LEGACY_UNBOUND/);
 assert.throws(()=>parseWinkSupport({...legacy,schemaVersion:2,items:[samples[0].row]},'https://example.test',binding),/LEGACY_UNBOUND/);
});

test('admitted index uses only current core URLs and carries the exact manifest cache token',()=>{
 const parsed=parseWinkSupport(payload,'https://example.test',binding);
 assert.equal(parsed.length,2);
 for(const [i,row] of parsed.entries()){
  assert.equal(row.supportKind,'core-refresh');
  assert.equal(row.id,'clean-v5-'+samples[i].entry.admissionSha256.slice(0,28));
  assert.deepEqual(row.feature,samples[i].entry.feature);
  assert.equal(row.supportSide,samples[i].entry.winkExpressionEvidence.side);
  assert.equal(payload.items[i].cleanProfile,samples[i].entry.cleanProfile);
  assert.equal(payload.items[i].cleanTier,'observed');
  assert.deepEqual(payload.items[i].winkExpressionEvidence,samples[i].entry.winkExpressionEvidence);
  const url=new URL(row.url);
  assert.equal(url.pathname,'/api/catalog/image');
  assert.equal(url.searchParams.get('source'),'seed');
  assert.equal(url.searchParams.get('catalog'),manifestSha256);
  assert.equal(url.searchParams.get('pack'),'test-admitted.bin');
  assert.equal(url.searchParams.get('winkIndex'),'v3');
 }
});

test('stale manifest, wrong policy, missing stamp and unadmitted image metadata fail closed',()=>{
 for(const change of [{baseCatalogId:'other'},{baseCatalogManifestSha256:'c'.repeat(64)},{policySha256:'c'.repeat(64)}])assert.throws(()=>parseWinkSupport({...payload,...change},'https://example.test',binding),/CATALOG_MISMATCH/);
 assert.throws(()=>parseWinkSupport(payload,'https://example.test'),/ADMISSION_REQUIRED/);
 for(const stamp of [null,{}, {...binding.qualityAdmission,status:'incomplete'}, {...binding.qualityAdmission,runtimeExclusionOverlayRequired:true}])assert.throws(()=>parseWinkSupport(payload,'https://example.test',{...binding,qualityAdmission:stamp}),/ADMISSION_REQUIRED/);
 for(const change of [{supportKind:'addition'},{admissionSha256:'d'.repeat(64)},{admissionPolicySha256:'d'.repeat(64)}])assert.throws(()=>parseWinkSupport({...payload,items:[{...samples[0].row,...change}]},'https://example.test',binding),/UNADMITTED_IMAGE/);
 for(const change of [{id:'clean-v3-legacy-photo'},{image:'separate.webp'},{image:null},{image:undefined},{pack:'../stale.bin'},{offset:-1},{offset:0.5},{length:0}])assert.throws(()=>parseWinkSupport({...payload,items:[{...samples[0].row,...change}]},'https://example.test',binding),/CORE_REFERENCE/);
});

test('an admitted specialist index requires its exact assistant review bound to the original audit',()=>{
 for(const stamp of [undefined,null,{},
  {...reviewStamp,schemaVersion:2}, {...reviewStamp,documentKind:'another-review'},
  {...reviewStamp,mode:'automatic-only'}, {...reviewStamp,reviewSha256:'invalid'},
  {...reviewStamp,candidateAuditSha256:'f'.repeat(64)}, {...reviewStamp,recordsSha256:'f'.repeat(64)},
  {...reviewStamp,reviewer:'human'}, {...reviewStamp,humanVerified:true}, {...reviewStamp,humanVerified:undefined},
 ])assert.throws(()=>parseWinkSupport(payload,'https://example.test',{...binding,winkExpressionReview:stamp}),/REVIEW_REQUIRED/);
 for(const qualityAdmission of [{...binding.qualityAdmission,receiptSha256:undefined},{...binding.qualityAdmission,recordsSha256:undefined}])
  assert.throws(()=>parseWinkSupport(payload,'https://example.test',{...binding,qualityAdmission}),/REVIEW_REQUIRED/);
 for(const winkExpressionReviewSha256 of [undefined,'f'.repeat(64)])
  assert.throws(()=>parseWinkSupport({...payload,winkExpressionReviewSha256},'https://example.test',binding),/REVIEW_MISMATCH/);
});

test('reviewed specialist rows require the same image, side, profile, evidence tier and review',()=>{
 const row=samples[0].row,proof=row.winkExpressionEvidence;
 for(const change of [
  {cleanProfile:undefined},{cleanProfile:'backgroundEyes'},{cleanProfile:'winkRight'},
  {cleanTier:undefined},{cleanTier:'background'},{side:'right'},
  {winkExpressionEvidence:undefined},{winkExpressionEvidence:null},{winkExpressionEvidence:{}},
  {winkExpressionEvidence:{...proof,schemaVersion:2}},
  {winkExpressionEvidence:{...proof,encodedSha256:'f'.repeat(64)}},
  {winkExpressionEvidence:{...proof,side:'right'}},
  {winkExpressionEvidence:{...proof,reviewSha256:'f'.repeat(64)}},
 ])assert.throws(()=>parseWinkSupport({...payload,items:[{...row,...change}]},'https://example.test',binding),/REVIEW_EVIDENCE_MISMATCH/);
 // Both declared evidence tiers still need the same reviewed side and pixels.
 assert.equal(parseWinkSupport({...payload,items:[{...row,cleanTier:'strict'}]},'https://example.test',binding).length,1);
});

test('a confirmed review cannot override the unchanged automatic wink evidence',()=>{
 const row=samples[0].row,feature=[...row.feature];
 feature[I.eyeBlinkLeft]=.01;feature[I.eyeBlinkRight]=.01;
 assert.throws(()=>parseWinkSupport({...payload,items:[{...row,feature}]},'https://example.test',binding),/WINK_SUPPORT_EVIDENCE_MISMATCH/);
});

test('the generator rejects changed bytes, wrong admission policy and separate image paths',()=>{
 const {entry,bytes}=samples[0],changed=Buffer.from(bytes);changed[changed.length-1]^=1;
 assert.throws(()=>admittedCoreWink(entry,changed,policySha256,winkReview),/bytes changed/);
 assert.throws(()=>admittedCoreWink({...entry,admissionPolicySha256:'e'.repeat(64)},bytes,policySha256,winkReview),/admission evidence/);
 assert.throws(()=>admittedCoreWink({...entry,image:'external.webp'},bytes,policySha256,winkReview),/final packed core/);
 assert.throws(()=>admittedCoreWink({...entry,id:'clean-v3-old'},bytes,policySha256,winkReview),/v5 core ID/);
});

test('an oversized specialist index retains both sides without removing any core image',()=>{
 const rows=Array.from({length:10},(_,index)=>samples.map(sample=>({...sample.row,id:sample.row.id+'-'+index}))).flat();
 const unchanged=JSON.stringify(rows);
 const firstTwo=rows.slice(0,2).reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row))+1,0);
 const byteLimit=Buffer.byteLength(JSON.stringify({...header,items:[]}))+1024+firstTwo+1;
 const selected=boundedWinkIndex(rows,header,byteLimit);
 assert.equal(selected.items.length,2);
 assert.deepEqual(new Set(selected.items.map(row=>row.side)),new Set(['left','right']));
 assert.equal(selected.eligibleCoreWinks,20);assert.equal(selected.omittedFromSpecialistIndex,18);
 assert.equal(JSON.stringify(rows),unchanged);
});
