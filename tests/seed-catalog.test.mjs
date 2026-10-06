import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
const root = path.resolve("public/seed-catalog");
const hasCatalogPayload = existsSync(path.join(root,"shards")) && existsSync(path.join(root,"packs"));
test("full clean catalog preserves every real-photo entry and packed image", { skip: !hasCatalogPayload }, async () => {
  const manifest = JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8"));
  assert.equal(manifest.schemaVersion,3);
  assert.equal(manifest.totalFaces,70000);
  assert.equal(manifest.searchableFaces,70000);
  assert.equal(manifest.poseStep,3);
  const admission = manifest.qualityAdmission;
  const admitted = admission !== undefined;
  if (!admitted) assert.equal(Object.keys(manifest.cells).length,775);
  else {
    assert.ok(admission && typeof admission === "object" && !Array.isArray(admission));
    assert.equal(admission.schemaVersion,2); assert.equal(admission.status,"complete");
    assert.equal(admission.selectedCount,70000); assert.equal(admission.runtimeExclusionOverlayRequired,false);
    assert.ok(typeof admission.policyId === "string" && admission.policyId.length > 0);
    for (const key of ["policySha256","receiptSha256","recordsSha256","attributeModelSha256","faceModelSha256"]) {
      assert.equal(typeof admission[key],"string",key); assert.match(admission[key],/^[a-f0-9]{64}$/u,key);
    }
    assert.equal(manifest.sourceFaces,70000);
    assert.deepEqual(manifest.bounds,{yawMin:-45,yawMax:45,pitchMin:-36,pitchMax:36});
    assert.equal(manifest.stats.poseCells,Object.keys(manifest.cells).length);
    assert.equal(manifest.stats.cleanCore.selectedFaces,70000);
    assert.equal(manifest.stats.cleanCore.gatePassed,true);
  }
  const ids = new Set(), shards = new Set(), packNames = new Set(), encodedImages = new Set();
  const profileCounts = new Map(), profileCells = new Map();
  for (const [cellKey,cell] of Object.entries(manifest.cells)) {
    if (admitted) {
      assert.match(cellKey,/^-?\d+:-?\d+$/u);
      const [yaw,pitch] = cellKey.split(":").map(Number);
      assert.ok(yaw >= -45 && yaw <= 45 && pitch >= -36 && pitch <= 36 && yaw % 3 === 0 && pitch % 3 === 0,cellKey);
      assert.ok(Number.isSafeInteger(cell.count) && cell.count > 0,cellKey);
    }
    let count=0;
    for (const file of cell.shards ?? [cell.shard]) {
      if (admitted) {
        assert.match(file,/^[a-z0-9_.+-]+\.json$/iu);
        assert.ok(!shards.has(file),`Repeated shard ${file}`); shards.add(file);
      }
      const shard=JSON.parse(await readFile(path.join(root,"shards",file),"utf8"));
      if (admitted) assert.equal(shard.cell,cellKey,file);
      const packs=new Map();
      for (const item of shard.items) {
        assert.ok(!ids.has(item.id),`Duplicate ${item.id}`);ids.add(item.id);count++;
        assert.equal(item.feature.length,55);assert.ok(item.feature.every(Number.isFinite));
        assert.ok(item.shape&&item.mesh&&item.projection);
        assert.equal(Buffer.from(item.projection,"base64").byteLength,468*2*2);
        assert.equal(item.layout.length,4);
        assert.doesNotMatch(`${item.sourceName} ${item.id}`,/synthetic|facs/i);
        assert.ok(item.creator&&item.license&&item.sourceUrl);
        assert.ok(Number.isInteger(item.offset)&&item.offset>=0);
        assert.ok(Number.isInteger(item.length)&&item.length>0);
        if (!packs.has(item.pack)) packs.set(item.pack,await readFile(path.join(root,"packs",item.pack)));
        const pack=packs.get(item.pack);assert.ok(item.offset+item.length<=pack.length);
        const image=pack.subarray(item.offset,item.offset+item.length);
        assert.equal(image.subarray(0,4).toString("ascii"),"RIFF");
        assert.equal(image.subarray(8,12).toString("ascii"),"WEBP");
        if (admitted) {
          assert.equal(image.readUInt32LE(4)+8,image.length,`Incomplete WebP ${item.id}`);
          const digest=createHash("sha256").update(image).digest("hex");
          assert.equal(item.admissionSha256,digest,item.id);
          assert.equal(item.admissionPolicySha256,admission.policySha256,item.id);
          assert.equal(item.id,`clean-v5-${digest.slice(0,28)}`);
          assert.ok(!encodedImages.has(digest),`Repeated encoded image ${item.id}`); encodedImages.add(digest);
          assert.ok(!Object.hasOwn(item,"image"),`Unbound image path ${item.id}`);
          assert.match(item.pack,/^[a-z0-9_.-]+\.bin$/iu); packNames.add(item.pack);
          assert.ok(Object.hasOwn(manifest.stats.cleanCore.profileCounts,item.cleanProfile),`Undeclared profile ${item.cleanProfile}`);
          profileCounts.set(item.cleanProfile,(profileCounts.get(item.cleanProfile) ?? 0)+1);
          if (!profileCells.has(item.cleanProfile)) profileCells.set(item.cleanProfile,new Set());
          profileCells.get(item.cleanProfile).add(cellKey);
        }
      }
    }
    assert.equal(count,cell.count,cellKey);
  }
  assert.equal(ids.size,70000);
  if (admitted) {
    assert.equal(encodedImages.size,70000);
    assert.equal(manifest.stats.shardCount,shards.size);
    assert.equal(manifest.stats.packCount,packNames.size);
    assert.deepEqual(new Set(await readdir(path.join(root,"shards"))),shards);
    assert.deepEqual(new Set(await readdir(path.join(root,"packs"))),packNames);
    for (const [profile,count] of Object.entries(manifest.stats.cleanCore.profileCounts)) {
      assert.equal(profileCounts.get(profile) ?? 0,count,profile);
      assert.equal(profileCells.get(profile)?.size ?? 0,manifest.stats.cleanCore.profilePoseCells[profile],profile);
    }
  }
});
