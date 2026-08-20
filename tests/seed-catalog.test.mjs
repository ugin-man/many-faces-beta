import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve("public/seed-catalog");

test("bundles a validated face catalog across pose and expression groups", {
  skip: !existsSync(path.join(root, "manifest.json")),
}, async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.shapeVersion, "mediapipe-projection-468-v4");
  assert.equal(manifest.projectionPoints, 468);
  if (manifest.totalFaces >= 70_000) {
    assert.equal(manifest.catalogId, "seed-ffhq-70224-actions-v4");
    assert.equal(manifest.totalFaces, 70_224);
    assert.equal(manifest.searchableFaces, 70_099);
    assert.equal(manifest.featureLength, 55);
    assert.equal(manifest.shardsContainGeometry, true);
    assert.equal(Object.keys(manifest.cells).length, 749);
    assert.equal(
      Object.values(manifest.cells).reduce((sum, cell) => sum + cell.count, 0),
      manifest.searchableFaces,
    );
    assert.ok(Object.values(manifest.stats.coverage.deficits).every((value) => value === 0));
    const shardNames = [...new Set(
      Object.values(manifest.cells).flatMap((cell) => cell.shards ?? []),
    )];
    assert.equal(shardNames.length, 761);
    for (const shardName of [shardNames[0], shardNames.at(-1)]) {
      const shard = JSON.parse(
        await readFile(path.join(root, "shards", shardName), "utf8"),
      );
      assert.ok(shard.items.length >= 1);
      for (const item of [shard.items[0], shard.items.at(-1)]) {
        assert.equal(item.feature.length, 55);
        assert.ok(item.feature.every(Number.isFinite));
        assert.ok(item.shape && item.mesh && item.projection);
        assert.equal(item.layout.length, 4);
        const pack = await readFile(path.join(root, "packs", item.pack));
        const image = pack.subarray(item.offset, item.offset + item.length);
        assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
        assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
      }
    }
    return;
  }
  assert.ok(manifest.indexFiles.length >= 11);
  assert.ok(manifest.indexFiles.every((file) => /^index_[0-9]{3}\.json$/.test(file)));
  assert.equal(manifest.totalFaces, 15_000);
  assert.equal(manifest.poseStep, 3);
  assert.deepEqual(manifest.bounds, {
    yawMin: -45,
    yawMax: 45,
    pitchMin: -36,
    pitchMax: 36,
  });
  assert.ok(Object.keys(manifest.cells).length >= 600);
  assert.ok(manifest.stats.packCount >= 35);
  assert.ok(manifest.stats.preindexedFaces >= 14_900);
  assert.ok(manifest.stats.expansion.addedExtremePitchFaces >= 300);
  for (const expression of ["neutral", "smile", "surprise", "frown"]) {
    assert.ok(
      manifest.stats.expressionDistribution[expression] >= 1_000,
      `${expression} is underrepresented`,
    );
  }

  const entryIds = new Set();
  const packs = new Map();
  let totalEntries = 0;
  let strongWinkFaces = 0;
  let upwardFaces = 0;
  let downwardFaces = 0;
  for (const [cellKey, cell] of Object.entries(manifest.cells)) {
    assert.ok(cell.count >= 1 && cell.count <= 64, `${cellKey} has ${cell.count} faces`);
    assert.equal(cell.shards.length, 1);
    const shard = JSON.parse(
      await readFile(path.join(root, "shards", cell.shards[0]), "utf8"),
    );
    assert.equal(shard.cell, cellKey);
    assert.equal(shard.items.length, cell.count);
    for (const item of shard.items) {
      assert.equal(item.feature.length, 22);
      assert.ok(item.feature.every(Number.isFinite));
      if (Math.abs(item.feature[13] - item.feature[14]) >= 0.4) strongWinkFaces += 1;
      if (item.feature[1] * 90 >= 27) upwardFaces += 1;
      if (item.feature[1] * 90 <= -27) downwardFaces += 1;
      assert.match(item.pack, /^seed_pack_[0-9]{3}\.bin$/);
      assert.ok(Number.isInteger(item.offset) && item.offset >= 0);
      assert.ok(Number.isInteger(item.length) && item.length > 1_000);
      assert.ok(item.sourceUrl.startsWith("https://www.flickr.com/"));
      assert.ok(item.creator);
      assert.ok(item.license);
      assert.ok(item.licenseUrl.startsWith("http"));
      if (item.mesh) {
        assert.ok(item.shape);
        assert.ok(item.projection);
        assert.equal(item.layout.length, 4);
        assert.ok(Buffer.from(item.mesh, "base64").byteLength >= 1_000);
        assert.equal(Buffer.from(item.projection, "base64").byteLength, 468 * 2 * 2);
      }
      assert.ok(!entryIds.has(item.id), `duplicate entry ${item.id}`);
      entryIds.add(item.id);
      const entries = packs.get(item.pack) ?? [];
      entries.push(item);
      packs.set(item.pack, entries);
      totalEntries += 1;
    }
  }
  assert.equal(totalEntries, 15_000);
  assert.equal(entryIds.size, 15_000);
  assert.equal(packs.size, manifest.stats.packCount);
  assert.ok(strongWinkFaces >= 80, `only ${strongWinkFaces} strong wink candidates`);
  assert.ok(upwardFaces >= 900, `only ${upwardFaces} upward candidates`);
  assert.ok(downwardFaces >= 900, `only ${downwardFaces} downward candidates`);

  for (const [packName, entries] of packs) {
    const pack = await readFile(path.join(root, "packs", packName));
    const sorted = entries.sort((left, right) => left.offset - right.offset);
    for (let index = 0; index < sorted.length; index += 1) {
      const item = sorted[index];
      assert.ok(item.offset + item.length <= pack.byteLength);
      if (index) assert.ok(sorted[index - 1].offset + sorted[index - 1].length <= item.offset);
      const image = pack.subarray(item.offset, item.offset + item.length);
      assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
    }
  }
});
