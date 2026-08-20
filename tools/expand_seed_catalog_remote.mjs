#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const DATASET_HOST = "datasets-server.huggingface.co";
const DATASET_PAGE = "https://huggingface.co/datasets/nuwandaa/ffhq128";
const FFHQ_PAGE = "https://github.com/NVlabs/ffhq-dataset";
const LICENSE_URL = "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt";
const FEATURE_LENGTH = 55;
const PACK_TARGET_BYTES = 2 * 1024 * 1024;
const ROW_BATCH_SIZE = 100;
const ROW_BATCHES_PER_WAVE = 10;

function parseArgs() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  const catalog = values.get("--catalog");
  if (!catalog) {
    throw new Error(
      "Usage: expand_seed_catalog_remote.mjs --catalog <seed-catalog dir> [--target 70000] [--concurrency 12] [--site <url>]",
    );
  }
  return {
    catalog: path.resolve(catalog),
    target: Number(values.get("--target") ?? 70_000),
    concurrency: Number(values.get("--concurrency") ?? 12),
    site: (values.get("--site") ?? "https://many-faces-prototype.uginn-poppo.chatgpt.site").replace(/\/$/, ""),
    images: values.get("--images") ? path.resolve(values.get("--images")) : null,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry(operation, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await wait(Math.min(8_000, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  return retry(async () => {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Many Faces Prototype catalog builder/0.4",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`rows ${response.status}`);
    return response.json();
  });
}

function imageUrl(row) {
  const image = row?.row?.image;
  return typeof image === "string" ? image : image?.src;
}

async function fetchRows(offset, length, site) {
  const query = new URLSearchParams({
    dataset: "nuwandaa/ffhq128",
    config: "default",
    split: "train",
    offset: String(offset),
    length: String(length),
  });
  try {
    const payload = await fetchJson(`https://${DATASET_HOST}/rows?${query}`);
    return payload.rows ?? [];
  } catch {
    const fallback = new URLSearchParams({ offset: String(offset), limit: String(Math.min(60, length)) });
    const payload = await fetchJson(`${site}/api/ffhq?${fallback}`);
    return (payload.items ?? []).map((item) => ({
      row_idx: Number(item.id.split("-").at(-1)),
      row: { image: item.imageUrl },
    }));
  }
}

async function encodeCandidate(url, site) {
  const load = async (source) => {
    const response = await fetch(source, {
      headers: { "user-agent": "Many Faces Prototype catalog builder/0.4" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`image ${response.status}`);
    return loadImage(Buffer.from(await response.arrayBuffer()));
  };
  let image;
  try {
    image = await retry(() => load(url), 4);
  } catch {
    image = await retry(() => load(`${site}/api/ffhq?image=${encodeURIComponent(url)}`), 4);
  }
  const canvas = createCanvas(256, 256);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, 256, 256);
  return canvas.encode("webp", 78);
}

async function encodeLocalCandidate(filename) {
  const image = await loadImage(await readFile(filename));
  const canvas = createCanvas(256, 256);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, 256, 256);
  return canvas.encode("webp", 78);
}

async function mapConcurrent(items, concurrency, worker) {
  const output = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await worker(items[index]);
    }
  }));
  return output;
}

async function referencedEntries(catalog, manifest) {
  const shardNames = Object.values(manifest.cells ?? {}).flatMap((cell) =>
    cell.shards ?? (cell.shard ? [cell.shard] : []),
  );
  const staging = (await readdir(path.join(catalog, "shards")))
    .filter((name) => /^seed_expand_pack_[0-9]{3}\.json$/.test(name));
  const names = [...new Set([...shardNames, ...staging])];
  const entries = [];
  for (const name of names) {
    const payload = JSON.parse(await readFile(path.join(catalog, "shards", name), "utf8"));
    entries.push(...(payload.items ?? []));
  }
  return { entries, staging };
}

async function main() {
  const args = parseArgs();
  if (!Number.isSafeInteger(args.target) || args.target < 1 || args.target > 70_000) {
    throw new Error("--target must be between 1 and 70000");
  }
  const manifestPath = path.join(args.catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { entries: currentEntries, staging } = await referencedEntries(args.catalog, manifest);
  const existingIds = new Set(currentEntries.map((entry) => entry.id));
  const packFiles = (await readdir(path.join(args.catalog, "packs")))
    .filter((name) => /^seed_pack_[0-9]{3}\.bin$/.test(name));
  let nextPack = packFiles.reduce(
    (largest, name) => Math.max(largest, Number(name.match(/[0-9]{3}/)?.[0] ?? -1)),
    -1,
  ) + 1;
  const startingFaces = existingIds.size;
  const stagingExistingCount = currentEntries.filter((entry) =>
    /^seed_pack_[0-9]{3}\.bin$/.test(entry.pack ?? "") &&
    Number(entry.pack.match(/[0-9]{3}/)?.[0] ?? 0) >= 40,
  ).length;
  const baseFaces = startingFaces - stagingExistingCount;
  let added = 0;
  let failed = 0;
  const newStaging = [...staging];

  const flushPack = async (encodedRows) => {
    if (!encodedRows.length) return;
    const packName = `seed_pack_${String(nextPack).padStart(3, "0")}.bin`;
    const shardName = `seed_expand_pack_${String(nextPack).padStart(3, "0")}.json`;
    const parts = [];
    const items = [];
    let offset = 0;
    for (const { index, encoded } of encodedRows) {
      const id = `seed-ffhq-${index}`;
      parts.push(encoded);
      items.push({
        id,
        name: `FFHQ ${String(index).padStart(5, "0")}`,
        pack: packName,
        offset,
        length: encoded.byteLength,
        feature: Array(FEATURE_LENGTH).fill(0),
        sourceName: "FFHQ / Flickr",
        sourceUrl: DATASET_PAGE,
        creator: "NVIDIA FFHQ / Flickr photographers",
        license: "CC BY-NC-SA 4.0; original source licenses vary",
        licenseUrl: LICENSE_URL,
      });
      offset += encoded.byteLength;
    }
    await writeFile(path.join(args.catalog, "packs", packName), Buffer.concat(parts));
    await writeFile(
      path.join(args.catalog, "shards", shardName),
      JSON.stringify({ cell: "0:0", provisional: true, items }),
    );
    newStaging.push(shardName);
    items.forEach((item) => existingIds.add(item.id));
    added += items.length;
    nextPack += 1;
    console.log(
      `packed ${existingIds.size.toLocaleString()}/${args.target.toLocaleString()} faces ` +
      `(${nextPack} packs, ${failed} failed)`,
    );
  };

  const flush = async (encodedRows) => {
    let pack = [];
    let bytes = 0;
    for (const row of encodedRows) {
      if (pack.length && bytes + row.encoded.byteLength > PACK_TARGET_BYTES) {
        await flushPack(pack);
        pack = [];
        bytes = 0;
      }
      pack.push(row);
      bytes += row.encoded.byteLength;
    }
    await flushPack(pack);
  };

  for (
    let waveOffset = 0;
    waveOffset < args.target && existingIds.size < args.target;
    waveOffset += ROW_BATCH_SIZE * ROW_BATCHES_PER_WAVE
  ) {
    const offsets = Array.from(
      { length: ROW_BATCHES_PER_WAVE },
      (_, index) => waveOffset + index * ROW_BATCH_SIZE,
    ).filter((offset) => offset < args.target);
    const missing = args.images
      ? Array.from(
          { length: Math.min(ROW_BATCH_SIZE * ROW_BATCHES_PER_WAVE, args.target - waveOffset) },
          (_, index) => waveOffset + index,
        ).filter((index) => !existingIds.has(`seed-ffhq-${index}`)).map((index) => ({
          index,
          filename: path.join(args.images, `${String(index).padStart(5, "0")}.png`),
        }))
      : (await Promise.all(offsets.map((offset) =>
          fetchRows(offset, Math.min(ROW_BATCH_SIZE, args.target - offset), args.site),
        ))).flat().flatMap((row) => {
          const index = Number(row.row_idx);
          const url = imageUrl(row);
          if (!Number.isSafeInteger(index) || index < 0 || index >= args.target || !url) return [];
          return existingIds.has(`seed-ffhq-${index}`) ? [] : [{ index, url }];
        });
    if (!missing.length) continue;
    const encoded = await mapConcurrent(missing, args.concurrency, async (candidate) => {
      try {
        return {
          index: candidate.index,
          encoded: candidate.filename
            ? await encodeLocalCandidate(candidate.filename)
            : await encodeCandidate(candidate.url, args.site),
        };
      } catch (error) {
        failed += 1;
        console.warn(`warning seed-ffhq-${candidate.index}: ${error}`);
        return null;
      }
    });
    const successful = encoded.filter(Boolean);
    // Every completed pack has a matching staging shard, so a stopped run resumes exactly.
    await flush(successful);
  }

  if (existingIds.size < args.target) {
    throw new Error(`Only ${existingIds.size} of ${args.target} source faces were downloaded`);
  }
  const originalZero = manifest.cells?.["0:0"] ?? { count: 0, shards: [] };
  manifest.schemaVersion = 3;
  manifest.catalogId = `seed-ffhq-${args.target}-source-v4`;
  manifest.generatedAt = new Date().toISOString();
  manifest.totalFaces = args.target;
  manifest.sourceFaces = args.target;
  manifest.featureSchema = "mediapipe-face-actions-v2";
  manifest.featureLength = FEATURE_LENGTH;
  manifest.cells = {
    ...(manifest.cells ?? {}),
    "0:0": {
      count: Number(originalZero.count ?? 0) + newStaging.reduce((sum, name) => {
        const match = currentEntries.filter((entry) => entry.pack === name.replace("seed_expand_pack_", "seed_pack_").replace(".json", ".bin"));
        return sum + match.length;
      }, 0) + added,
      shards: [...new Set([...(originalZero.shards ?? []), ...newStaging])],
    },
  };
  // Recount provisional staging directly; this also covers a resumed run.
  let stagingCount = 0;
  for (const name of newStaging) {
    const payload = JSON.parse(await readFile(path.join(args.catalog, "shards", name), "utf8"));
    stagingCount += payload.items?.length ?? 0;
  }
  manifest.cells["0:0"].count = Number(originalZero.count ?? 0) + stagingCount;
  manifest.stats = {
    ...(manifest.stats ?? {}),
    checked: args.target,
    accepted: args.target,
    packCount: (await readdir(path.join(args.catalog, "packs"))).filter((name) => name.endsWith(".bin")).length,
    expansion: {
      fromFaces: baseFaces,
      addedFaces: stagingCount,
      downloadFailuresRecovered: failed,
    },
  };
  manifest.source = {
    ...(manifest.source ?? {}),
    name: "Flickr-Faces-HQ (FFHQ)",
    url: FFHQ_PAGE,
    mirror: DATASET_PAGE,
    license: "CC BY-NC-SA 4.0; original source licenses retained where available",
    licenseUrl: LICENSE_URL,
    changes: `Retained all ${args.target.toLocaleString()} source faces, resized to 256px WebP, and packed for range delivery before MediaPipe indexing.`,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(`source catalog ready: ${existingIds.size.toLocaleString()} faces, ${stagingCount.toLocaleString()} staged`);
}

await main();
