import assert from "node:assert/strict";
import { readFile, stat, open } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve("public/seed-catalog");

test("the bundled real-photo catalog is internally consistent across every shard", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.shapeVersion, "mediapipe-projection-468-v4");
  assert.equal(manifest.featureLength, 55);
  assert.equal(manifest.shardsContainGeometry, true);
  assert.ok(manifest.totalFaces >= 70_000);
  assert.equal(manifest.stats.cleanCore.runtimeImagePolicy, "real-photo-only-v1");
  assert.equal(manifest.stats.cleanCore.knownSyntheticFaces, 0);
  const ids = new Set();
  const packs = new Map();
  const sources = {};
  const missing = { creator: 0, sourceUrl: 0, license: 0, licenseUrl: 0 };
  let count = 0;
  for (const [cellKey, cell] of Object.entries(manifest.cells)) {
    let inCell = 0;
    for (const filename of cell.shards) {
      assert.match(filename, /^[a-z0-9_.+-]+\.json$/i);
      const shard = JSON.parse(await readFile(path.join(root, "shards", filename), "utf8"));
      for (const item of shard.items) {
        assert.ok(item.id && !ids.has(item.id), `duplicate ID ${item.id}`);
        ids.add(item.id);
        assert.equal(item.feature.length, manifest.featureLength);
        assert.ok(item.feature.every(Number.isFinite), item.id);
        assert.equal(Buffer.from(item.projection, "base64").length, 468 * 2 * 2);
        assert.ok(Buffer.from(item.shape, "base64").length >= 26);
        assert.ok(Buffer.from(item.mesh, "base64").length >= 600);
        assert.equal(item.layout.length, 4);
        assert.ok(item.layout.every(Number.isFinite));
        assert.match(item.pack, /^[a-z0-9_.-]+\.bin$/i);
        assert.ok(Number.isSafeInteger(item.offset) && item.offset >= 0);
        assert.ok(Number.isSafeInteger(item.length) && item.length > 12);
        let pack = packs.get(item.pack);
        if (!pack) {
          pack = { size: (await stat(path.join(root, "packs", item.pack))).size, entries: [] };
          packs.set(item.pack, pack);
        }
        assert.ok(item.offset + item.length <= pack.size, item.id);
        pack.entries.push(item);
        for (const field of Object.keys(missing)) if (!item[field]) missing[field]++;
        const source = item.sourceName || "missing";
        sources[source] = (sources[source] || 0) + 1;
        inCell++;
      }
    }
    assert.equal(inCell, cell.count, `cell ${cellKey}`);
    count += inCell;
  }
  assert.equal(count, manifest.searchableFaces);
  assert.equal(ids.size, manifest.totalFaces);
  for (const [filename, pack] of packs) {
    pack.entries.sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < pack.entries.length; i++) {
      assert.ok(pack.entries[i - 1].offset + pack.entries[i - 1].length <= pack.entries[i].offset, `overlapping ranges in ${filename}`);
    }
    const handle = await open(path.join(root, "packs", filename));
    try {
      for (const item of [pack.entries[0], pack.entries.at(-1)]) {
        const header = Buffer.alloc(12);
        await handle.read(header, 0, 12, item.offset);
        assert.equal(header.toString("ascii", 0, 4), "RIFF");
        assert.equal(header.toString("ascii", 8, 12), "WEBP");
      }
    } finally { await handle.close(); }
  }
  // Metadata absence is reported, never fabricated as public-domain permission.
  console.log("CATALOG_AUDIT", JSON.stringify({ faces: count, packs: packs.size, sources, missingAttributionFields: missing }));
});
