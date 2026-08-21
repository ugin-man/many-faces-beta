import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

function entry(id, pack, sourceUrl, yaw = 0, pitch = 0) {
  return {
    id,
    pack,
    offset: 0,
    length: 4,
    feature: [yaw / 90, pitch / 90, 0, ...Array(52).fill(0)],
    shape: Buffer.from(new Int16Array(180).buffer).toString("base64"),
    mesh: Buffer.from(new Int16Array(600).buffer).toString("base64"),
    projection: Buffer.from(new Int16Array(936).buffer).toString("base64"),
    layout: [0.5, 0.5, 0.6, 0.7],
    sourceUrl,
  };
}

async function makeCatalog(root, item, cell = "0:0") {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "shards"), { recursive: true });
  await writeFile(path.join(root, "packs", item.pack), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(root, "shards", "cell.json"), JSON.stringify({ cell, items: [item] }));
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 3,
    catalogId: path.basename(root),
    totalFaces: 1,
    sourceFaces: 1,
    searchableFaces: 1,
    featureLength: 55,
    shardsContainGeometry: true,
    poseStep: 3,
    bounds: { yawMin: -45, yawMax: 45, pitchMin: -36, pitchMax: 36 },
    cells: { [cell]: { count: 1, shards: ["cell.json"] } },
  }));
}

test("merge publishes supplement packs and switches the manifest last", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "many-faces-merge-test-"));
  const base = path.join(root, "base");
  const supplement = path.join(root, "supplement");
  await makeCatalog(base, entry("base", "base.bin", "https://example.com/base"));
  await makeCatalog(supplement, entry("new", "new.bin", "https://example.com/new", 18, 9), "18:9");
  await run(process.execPath, [
    "tools/merge-face-catalog.mjs",
    "--base", base,
    "--supplement", supplement,
    "--batch-id", "testbatch",
  ], { cwd: path.resolve(".") });
  const manifest = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
  assert.equal(manifest.totalFaces, 2);
  assert.equal(manifest.searchableFaces, 2);
  assert.equal(manifest.cells["18:9"].count, 1);
  assert.match(manifest.catalogId, /testbatch/);
  const shard = JSON.parse(await readFile(
    path.join(base, "shards", manifest.cells["18:9"].shards[0]),
    "utf8",
  ));
  assert.equal(shard.items[0].id, "add-testbatch-new");
  assert.equal(shard.items[0].pack, "add_testbatch_new.bin");
});
