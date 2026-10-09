import assert from "node:assert/strict";import test from "node:test";import {parseCatalogQualityOverlay,qualityAllows} from "../app/live/catalog-quality.ts";
import {shouldReadLegacyQualityOverlay} from "../app/live/catalog-quality.ts";
test("quality overlay excludes only reviewed ids",()=>{const m=parseCatalogQualityOverlay({schemaVersion:1,excluded:[{id:"a",reason:"sunglasses"},{id:"b",reason:"face_mask"}]});assert.equal(m.size,2);assert.equal(qualityAllows("a",m),false);assert.equal(qualityAllows("c",m),true);});
test("malformed quality overlay fails open",()=>{assert.equal(parseCatalogQualityOverlay({schemaVersion:2,excluded:[{id:"a",reason:"x"}]}).size,0);assert.equal(parseCatalogQualityOverlay(null).size,0);});
test("an admitted physical core is independent of the old runtime exclusion list",()=>{
  const stamp={schemaVersion:2,status:"complete",selectedCount:70000,runtimeExclusionOverlayRequired:false,policyId:"exact-pixel-clean-core-admission-v1"};
  for(const key of ["policySha256","receiptSha256","recordsSha256","attributeModelSha256","faceModelSha256"]) stamp[key]="a".repeat(64);
  assert.equal(shouldReadLegacyQualityOverlay(undefined),true);
  assert.equal(shouldReadLegacyQualityOverlay(stamp),false);
  for(const invalid of [null,{}, {...stamp,selectedCount:69999},{...stamp,status:"partial"},{...stamp,receiptSha256:""},{...stamp,runtimeExclusionOverlayRequired:true}]) assert.throws(()=>shouldReadLegacyQualityOverlay(invalid),/CATALOG_ADMISSION_INVALID/);
});
