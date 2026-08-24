#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const positional = [];
  let overwrite = false;
  for (const value of argv) {
    if (value === "--overwrite") overwrite = true;
    else positional.push(value);
  }
  if (positional.length !== 2) {
    throw new Error("Usage: repack-live-pose-packs.mjs <source-catalog> <output-catalog> [--overwrite]");
  }
  return {
    source: path.resolve(positional[0]),
    output: path.resolve(positional[1]),
    overwrite,
  };
}

function safeCatalogName(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function angleToken(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || Math.abs(number) > 90) {
    throw new Error(`Invalid pose angle: ${value}`);
  }
  const sign = number < 0 ? "n" : "p";
  return `${sign}${String(Math.abs(number)).padStart(3, "0")}`;
}

function posePackName(cellKey) {
  const [yawText, pitchText, extra] = String(cellKey).split(":");
  if (extra !== undefined) throw new Error(`Invalid pose cell: ${cellKey}`);
  return `live_yaw_${angleToken(yawText)}_pitch_${angleToken(pitchText)}.bin`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

async function copyAuxiliaryEntries(source, output) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (["manifest.json", "packs", "shards", "images"].includes(entry.name)) continue;
    await fs.cp(path.join(source, entry.name), path.join(output, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

export async function repackCatalog(source, output, { overwrite = false } = {}) {
  const sourceRoot = path.resolve(source);
  const outputRoot = path.resolve(output);
  if (sourceRoot === outputRoot) throw new Error("Source and output catalogs must differ");

  const manifest = await readJson(path.join(sourceRoot, "manifest.json"));
  if (manifest?.schemaVersion !== 3 || !manifest.cells || typeof manifest.cells !== "object") {
    throw new Error("Expected a schema-v3 catalog with pose cells");
  }

  if (overwrite) await fs.rm(outputRoot, { recursive: true, force: true });
  try {
    const existing = await fs.readdir(outputRoot);
    if (existing.length) throw new Error(`Output directory is not empty: ${outputRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.mkdir(path.join(outputRoot, "packs"), { recursive: true });
  await fs.mkdir(path.join(outputRoot, "shards"), { recursive: true });
  await copyAuxiliaryEntries(sourceRoot, outputRoot);

  const packCache = new Map();
  const loadPack = async (file) => {
    const name = safeCatalogName(file, /^[a-z0-9_.-]+\.bin$/i, "pack name");
    let buffer = packCache.get(name);
    if (!buffer) {
      buffer = await fs.readFile(path.join(sourceRoot, "packs", name));
      packCache.set(name, buffer);
    }
    return buffer;
  };

  const loadImage = async (file) => {
    const name = safeCatalogName(
      file,
      /^[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i,
      "image name",
    );
    return fs.readFile(path.join(sourceRoot, "images", name));
  };

  const cellEntries = Object.entries(manifest.cells).sort(([left], [right]) => {
    const [leftYaw, leftPitch] = left.split(":").map(Number);
    const [rightYaw, rightPitch] = right.split(":").map(Number);
    return leftYaw - rightYaw || leftPitch - rightPitch;
  });

  const ids = new Set();
  const packSizes = [];
  let totalItems = 0;
  let totalImageBytes = 0;
  let shardCount = 0;

  for (const [cellKey, cell] of cellEntries) {
    const shardFiles = Array.isArray(cell?.shards) && cell.shards.length
      ? cell.shards
      : cell?.shard
        ? [cell.shard]
        : [];
    if (!shardFiles.length) throw new Error(`Pose cell ${cellKey} has no shards`);

    const newPack = posePackName(cellKey);
    const chunks = [];
    const updatedShards = [];
    let cursor = 0;
    let cellItemCount = 0;

    for (const rawShardFile of shardFiles) {
      const shardFile = safeCatalogName(rawShardFile, /^[a-z0-9_.+-]+\.json$/i, "shard name");
      const shard = await readJson(path.join(sourceRoot, "shards", shardFile));
      if (!Array.isArray(shard.items)) throw new Error(`Shard has no items: ${shardFile}`);
      const updatedItems = [];

      for (const entry of shard.items) {
        if (!entry?.id || ids.has(entry.id)) throw new Error(`Duplicate or missing face id: ${entry?.id}`);
        ids.add(entry.id);

        let bytes;
        if (entry.pack) {
          const sourcePack = await loadPack(entry.pack);
          const offset = Number(entry.offset);
          const length = Number(entry.length);
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 1 ||
            offset + length > sourcePack.byteLength
          ) {
            throw new Error(`Invalid packed image range for ${entry.id}`);
          }
          bytes = Buffer.from(sourcePack.subarray(offset, offset + length));
        } else if (entry.image) {
          bytes = await loadImage(entry.image);
        } else {
          throw new Error(`Catalog entry has no image payload: ${entry.id}`);
        }

        const updated = {
          ...entry,
          pack: newPack,
          offset: cursor,
          length: bytes.byteLength,
        };
        delete updated.image;
        chunks.push(bytes);
        updatedItems.push(updated);
        cursor += bytes.byteLength;
        totalImageBytes += bytes.byteLength;
        totalItems += 1;
        cellItemCount += 1;
      }

      updatedShards.push({
        file: shardFile,
        payload: {
          ...shard,
          cell: shard.cell ?? cellKey,
          items: updatedItems,
        },
      });
    }

    const expectedCellCount = Number(cell?.count ?? cellItemCount);
    if (cellItemCount !== expectedCellCount) {
      throw new Error(`Pose cell ${cellKey} count mismatch: ${cellItemCount} != ${expectedCellCount}`);
    }

    const packBuffer = Buffer.concat(chunks, cursor);
    await fs.writeFile(path.join(outputRoot, "packs", newPack), packBuffer);
    for (const { file, payload } of updatedShards) {
      await writeJson(path.join(outputRoot, "shards", file), payload);
      shardCount += 1;
    }
    packSizes.push(packBuffer.byteLength);
  }

  const expectedFaces = Number(manifest.searchableFaces ?? manifest.totalFaces ?? 0);
  if (!expectedFaces || totalItems !== expectedFaces) {
    throw new Error(`Catalog face count mismatch: ${totalItems} != ${expectedFaces}`);
  }

  const sortedPackSizes = [...packSizes].sort((left, right) => left - right);
  const generatedAt = new Date().toISOString();
  const originalCatalogId = String(manifest.catalogId || "many-faces-clean-core-v3")
    .replace(/-pose-local-v\d+$/i, "");
  const livePacking = {
    schemaVersion: 1,
    policy: "one-pack-per-3-degree-pose-cell-v1",
    generatedAt,
    packCount: packSizes.length,
    shardCount,
    poseCells: cellEntries.length,
    totalImageBytes,
    minimumPackBytes: sortedPackSizes[0] ?? 0,
    medianPackBytes: percentile(sortedPackSizes, 0.5),
    p95PackBytes: percentile(sortedPackSizes, 0.95),
    maximumPackBytes: sortedPackSizes.at(-1) ?? 0,
  };
  const updatedManifest = {
    ...manifest,
    catalogId: `${originalCatalogId}-pose-local-v1`,
    generatedAt,
    stats: {
      ...(manifest.stats ?? {}),
      packCount: packSizes.length,
      shardCount,
      livePacking,
    },
  };
  await writeJson(path.join(outputRoot, "manifest.json"), updatedManifest);
  await writeJson(path.join(outputRoot, "live-packing-report.json"), {
    schemaVersion: 1,
    sourceCatalogId: manifest.catalogId ?? null,
    outputCatalogId: updatedManifest.catalogId,
    totalFaces: totalItems,
    ...livePacking,
  });
  return {
    manifest: updatedManifest,
    report: livePacking,
  };
}

const executedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (executedAsScript) {
  const args = parseArgs(process.argv.slice(2));
  repackCatalog(args.source, args.output, { overwrite: args.overwrite })
    .then(({ manifest, report }) => {
      console.log(JSON.stringify({ catalogId: manifest.catalogId, ...report }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
