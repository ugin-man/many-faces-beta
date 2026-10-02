import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  assert.equal(Object.keys(manifest.cells).length,775);
  const ids = new Set();
  for (const [cellKey,cell] of Object.entries(manifest.cells)) {
    let count=0;
    for (const file of cell.shards ?? [cell.shard]) {
      const shard=JSON.parse(await readFile(path.join(root,"shards",file),"utf8"));
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
      }
    }
    assert.equal(count,cell.count,cellKey);
  }
  assert.equal(ids.size,70000);
});
