#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FEATURE_LENGTH = 55;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

async function main() {
  const catalog = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) fail("Usage: validate_face_catalog.mjs <catalog directory>");
  const manifest = JSON.parse(await readFile(path.join(catalog, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 3) fail(`schemaVersion must be 3, got ${manifest.schemaVersion}`);
  if (manifest.featureLength !== FEATURE_LENGTH) {
    fail(`featureLength must be ${FEATURE_LENGTH}, got ${manifest.featureLength}`);
  }
  if (!manifest.shardsContainGeometry) fail("shardsContainGeometry must be true");
  if (manifest.indexFiles?.length) fail("70k sharded catalog must not publish global indexFiles");

  const ids = new Set();
  const packs = new Map();
  const referencedShards = new Set();
  let searchable = 0;
  let largestShard = 0;
  for (const [cellKey, cell] of Object.entries(manifest.cells ?? {})) {
    const shardNames = cell.shards ?? (cell.shard ? [cell.shard] : []);
    let cellFaces = 0;
    for (const shardName of shardNames) {
      if (referencedShards.has(shardName)) fail(`shard referenced twice: ${shardName}`);
      referencedShards.add(shardName);
      const shardPath = path.join(catalog, "shards", shardName);
      const shardSize = (await stat(shardPath)).size;
      largestShard = Math.max(largestShard, shardSize);
      if (shardSize > MAX_OBJECT_BYTES) fail(`shard exceeds 8 MiB: ${shardName}`);
      const payload = JSON.parse(await readFile(shardPath, "utf8"));
      if (payload.cell !== cellKey) fail(`cell mismatch in ${shardName}`);
      for (const entry of payload.items ?? []) {
        if (!entry.id || ids.has(entry.id)) fail(`missing or duplicate id: ${entry.id}`);
        ids.add(entry.id);
        if (!Array.isArray(entry.feature) || entry.feature.length !== FEATURE_LENGTH ||
            entry.feature.some((value) => !Number.isFinite(value))) {
          fail(`invalid feature: ${entry.id}`);
        }
        if (!entry.shape || !entry.mesh || !entry.projection ||
            !Array.isArray(entry.layout) || entry.layout.length !== 4) {
          fail(`missing geometry: ${entry.id}`);
        }
        if (!entry.pack || !Number.isSafeInteger(entry.offset) ||
            !Number.isSafeInteger(entry.length) || entry.offset < 0 || entry.length < 1) {
          fail(`invalid packed image range: ${entry.id}`);
        }
        const rangeEnd = entry.offset + entry.length;
        packs.set(entry.pack, Math.max(packs.get(entry.pack) ?? 0, rangeEnd));
        cellFaces += 1;
      }
    }
    if (cellFaces !== cell.count) fail(`cell ${cellKey}: manifest ${cell.count}, shards ${cellFaces}`);
    searchable += cellFaces;
  }
  if (searchable !== manifest.searchableFaces) {
    fail(`searchableFaces mismatch: manifest ${manifest.searchableFaces}, shards ${searchable}`);
  }
  if (manifest.sourceFaces !== manifest.totalFaces || searchable > manifest.sourceFaces) {
    fail("source/searchable face totals are inconsistent");
  }

  let largestPack = 0;
  for (const [packName, requiredBytes] of packs) {
    const packSize = (await stat(path.join(catalog, "packs", packName))).size;
    largestPack = Math.max(largestPack, packSize);
    if (packSize < requiredBytes) fail(`packed image range exceeds ${packName}`);
    if (packSize > MAX_OBJECT_BYTES) fail(`pack exceeds 8 MiB: ${packName}`);
  }
  const orphanedFinalShards = (await readdir(path.join(catalog, "shards")))
    .filter((name) => /^seed_yaw_.+_[0-9]{3}\.json$/.test(name) && !referencedShards.has(name));
  console.log(JSON.stringify({
    catalogId: manifest.catalogId,
    sourceFaces: manifest.sourceFaces,
    searchableFaces: searchable,
    failedDetections: manifest.sourceFaces - searchable,
    poseCells: Object.keys(manifest.cells ?? {}).length,
    shards: referencedShards.size,
    packs: packs.size,
    largestShardBytes: largestShard,
    largestPackBytes: largestPack,
    coverage: manifest.stats?.coverage ?? null,
    orphanedFinalShards: orphanedFinalShards.length,
  }, null, 2));
}

await main();
