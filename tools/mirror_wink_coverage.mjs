#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const FEATURE_LENGTH = 55;
const PACK_TARGET_BYTES = 2 * 1024 * 1024;

function decodeVector(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const values = new Float32Array(bytes.length / 2);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = bytes.readInt16LE(index * 2) / 4096;
  }
  return values;
}

function isVerifiedLeftWink(entry) {
  if (!entry.projection || Math.abs(Number(entry.feature?.[0] ?? 0) * 90) > 18) return false;
  const leftBlink = Number(entry.feature?.[13] ?? 0);
  const rightBlink = Number(entry.feature?.[14] ?? 0);
  if (leftBlink - rightBlink < 0.28) return false;
  const projection = decodeVector(entry.projection);
  const viewerLeft = Math.abs(projection[159 * 2 + 1] - projection[145 * 2 + 1]);
  const viewerRight = Math.abs(projection[386 * 2 + 1] - projection[374 * 2 + 1]);
  return viewerRight < viewerLeft * 0.76;
}

async function main() {
  const catalogFlag = process.argv.indexOf("--catalog");
  const countFlag = process.argv.indexOf("--count");
  if (catalogFlag < 0 || !process.argv[catalogFlag + 1]) {
    throw new Error("Usage: mirror_wink_coverage.mjs --catalog <dir> [--count 80]");
  }
  const catalog = path.resolve(process.argv[catalogFlag + 1]);
  const target = Math.max(
    1,
    Math.min(300, Number(countFlag >= 0 ? process.argv[countFlag + 1] : 80)),
  );
  const manifestPath = path.join(catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const shardNames = [...new Set(Object.values(manifest.cells).flatMap((cell) => cell.shards ?? []))];
  const verified = [];
  const alreadyMirrored = new Set();
  for (const shardName of shardNames) {
    const payload = JSON.parse(await readFile(path.join(catalog, "shards", shardName), "utf8"));
    for (const entry of payload.items ?? []) {
      if (entry.id?.startsWith("mirror-wink-")) {
        alreadyMirrored.add(entry.id.slice("mirror-wink-".length));
      }
      if (
        entry.id?.startsWith("seed-ffhq-") &&
        !alreadyMirrored.has(entry.id) &&
        isVerifiedLeftWink(entry)
      ) verified.push(entry);
    }
  }
  const remaining = verified.filter((entry) => !alreadyMirrored.has(entry.id));
  remaining.sort((left, right) =>
    (right.feature[13] - right.feature[14]) - (left.feature[13] - left.feature[14])
  );
  const selected = remaining.slice(0, target);
  if (selected.length < target) throw new Error(`Only ${selected.length} verified source winks`);

  const packFiles = await readdir(path.join(catalog, "packs"));
  let nextPack = packFiles.reduce((largest, name) =>
    Math.max(largest, Number(name.match(/[0-9]{3}/)?.[0] ?? -1)),
  -1) + 1;
  const packCache = new Map();
  const encoded = [];
  for (const source of selected) {
    let pack = packCache.get(source.pack);
    if (!pack) {
      pack = await readFile(path.join(catalog, "packs", source.pack));
      packCache.set(source.pack, pack);
    }
    const image = await loadImage(pack.subarray(source.offset, source.offset + source.length));
    const canvas = createCanvas(256, 256);
    const context = canvas.getContext("2d");
    context.translate(256, 0);
    context.scale(-1, 1);
    context.drawImage(image, 0, 0, 256, 256);
    encoded.push({ source, image: await canvas.encode("webp", 80) });
  }

  const newShards = [];
  let pending = [];
  let bytes = 0;
  const flush = async () => {
    if (!pending.length) return;
    const token = String(nextPack).padStart(3, "0");
    const packName = `target_pack_${token}.bin`;
    const shardName = `target_mirror_wink_pack_${token}.json`;
    let offset = 0;
    const items = pending.map(({ source, image }) => {
      const item = {
        id: `mirror-wink-${source.id}`,
        name: `${source.name} / mirrored wink coverage`,
        pack: packName,
        offset,
        length: image.byteLength,
        feature: Array(FEATURE_LENGTH).fill(0),
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        creator: source.creator,
        license: `${source.license} / horizontally mirrored`,
        licenseUrl: source.licenseUrl,
      };
      offset += image.byteLength;
      return item;
    });
    await writeFile(path.join(catalog, "packs", packName), Buffer.concat(pending.map(({ image }) => image)));
    await writeFile(
      path.join(catalog, "shards", shardName),
      JSON.stringify({ cell: "0:0", provisional: true, purpose: "mirrored-wink-coverage", items }),
    );
    newShards.push(shardName);
    nextPack += 1;
    pending = [];
    bytes = 0;
  };
  for (const item of encoded) {
    if (pending.length && bytes + item.image.byteLength > PACK_TARGET_BYTES) await flush();
    pending.push(item);
    bytes += item.image.byteLength;
  }
  await flush();

  const cell = manifest.cells["0:0"] ?? { count: 0, shards: [] };
  manifest.totalFaces += selected.length;
  manifest.sourceFaces += selected.length;
  manifest.catalogId = `${manifest.catalogId}-mirror-wink-staging`;
  manifest.shardsContainGeometry = false;
  manifest.cells["0:0"] = {
    count: Number(cell.count ?? 0) + selected.length,
    shards: [...(cell.shards ?? []), ...newShards],
  };
  manifest.stats = {
    ...(manifest.stats ?? {}),
    mirroredWinkCandidates: selected.length,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(`staged ${selected.length} mirrored, previously verified left-wink photos`);
}

await main();
