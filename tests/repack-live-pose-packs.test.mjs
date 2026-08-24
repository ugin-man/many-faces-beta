import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repackCatalog } from "../tools/repack-live-pose-packs.mjs";

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

test("repackages every 3-degree pose cell into one local pack without changing image bytes", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "many-faces-live-pack-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await fs.mkdir(path.join(source, "packs"), { recursive: true });
  await fs.mkdir(path.join(source, "shards"), { recursive: true });

  await fs.writeFile(path.join(source, "packs", "old_a.bin"), Buffer.from("AAABBBBCC"));
  await fs.writeFile(path.join(source, "packs", "old_b.bin"), Buffer.from("DDDDD"));
  await writeJson(path.join(source, "shards", "cell_0_0.json"), {
    cell: "0:0",
    items: [
      { id: "face-a", pack: "old_a.bin", offset: 0, length: 3, feature: Array(55).fill(0) },
      { id: "face-b", pack: "old_b.bin", offset: 0, length: 5, feature: Array(55).fill(0) },
    ],
  });
  await writeJson(path.join(source, "shards", "cell_3_0.json"), {
    cell: "3:0",
    items: [
      { id: "face-c", pack: "old_a.bin", offset: 3, length: 4, feature: Array(55).fill(0) },
      { id: "face-d", pack: "old_a.bin", offset: 7, length: 2, feature: Array(55).fill(0) },
    ],
  });
  await writeJson(path.join(source, "manifest.json"), {
    schemaVersion: 3,
    catalogId: "fixture-catalog",
    generatedAt: "2026-01-01T00:00:00.000Z",
    totalFaces: 4,
    searchableFaces: 4,
    poseStep: 3,
    bounds: { yawMin: 0, yawMax: 3, pitchMin: 0, pitchMax: 0 },
    cells: {
      "0:0": { count: 2, shards: ["cell_0_0.json"] },
      "3:0": { count: 2, shards: ["cell_3_0.json"] },
    },
    stats: {
      cleanCore: {
        runtimeImagePolicy: "real-photo-only-v1",
        knownSyntheticFaces: 0,
      },
    },
  });

  const { manifest, report } = await repackCatalog(source, output, { overwrite: true });
  assert.equal(manifest.catalogId, "fixture-catalog-pose-local-v1");
  assert.equal(report.packCount, 2);
  assert.equal(report.poseCells, 2);
  assert.equal(report.totalImageBytes, 14);

  const firstPack = await fs.readFile(path.join(output, "packs", "live_yaw_p000_pitch_p000.bin"));
  const secondPack = await fs.readFile(path.join(output, "packs", "live_yaw_p003_pitch_p000.bin"));
  assert.equal(firstPack.toString(), "AAADDDDD");
  assert.equal(secondPack.toString(), "BBBBCC");

  const firstShard = JSON.parse(await fs.readFile(path.join(output, "shards", "cell_0_0.json"), "utf8"));
  assert.deepEqual(
    firstShard.items.map(({ id, pack, offset, length }) => ({ id, pack, offset, length })),
    [
      { id: "face-a", pack: "live_yaw_p000_pitch_p000.bin", offset: 0, length: 3 },
      { id: "face-b", pack: "live_yaw_p000_pitch_p000.bin", offset: 3, length: 5 },
    ],
  );

  const secondShard = JSON.parse(await fs.readFile(path.join(output, "shards", "cell_3_0.json"), "utf8"));
  assert.deepEqual(
    secondShard.items.map(({ id, pack, offset, length }) => ({ id, pack, offset, length })),
    [
      { id: "face-c", pack: "live_yaw_p003_pitch_p000.bin", offset: 0, length: 4 },
      { id: "face-d", pack: "live_yaw_p003_pitch_p000.bin", offset: 4, length: 2 },
    ],
  );
});
