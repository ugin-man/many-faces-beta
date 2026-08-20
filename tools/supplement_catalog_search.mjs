#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const FEATURE_LENGTH = 55;
const PACK_TARGET_BYTES = 2 * 1024 * 1024;
const DEFAULT_QUERIES = [
  "person winking portrait",
  "woman winking portrait",
  "man winking portrait",
  "winking face portrait",
  "winking woman",
  "winking man",
  "winking girl portrait",
  "winking boy portrait",
];

function args() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  if (!values.get("--catalog")) {
    throw new Error("Usage: supplement_catalog_search.mjs --catalog <dir> [--site <url>] [--pages 2]");
  }
  return {
    catalog: path.resolve(values.get("--catalog")),
    site: (values.get("--site") ?? "https://many-faces-prototype.uginn-poppo.chatgpt.site").replace(/\/$/, ""),
    pages: Math.max(1, Math.min(8, Number(values.get("--pages") ?? 2))),
  };
}

async function retry(operation, attempts = 4) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw failure;
}

async function search(site, query, page) {
  const url = new URL("/api/openverse", site);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", "20");
  const response = await retry(() => fetch(url, { signal: AbortSignal.timeout(30_000) }));
  if (!response.ok) throw new Error(`${query} page ${page}: ${response.status}`);
  return (await response.json()).items ?? [];
}

async function encode(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const image = await loadImage(Buffer.from(encoded, "base64"));
  const canvas = createCanvas(256, 256);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const scale = Math.max(256 / image.width, 256 / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(image, (256 - width) / 2, (256 - height) / 2, width, height);
  return canvas.encode("webp", 80);
}

async function main() {
  const options = args();
  const manifestPath = path.join(options.catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tasks = DEFAULT_QUERIES.flatMap((query) =>
    Array.from({ length: options.pages }, (_, index) => ({ query, page: index + 1 })),
  );
  const found = [];
  for (let index = 0; index < tasks.length; index += 2) {
    const batch = tasks.slice(index, index + 2);
    const results = await Promise.allSettled(batch.map(async (task) => ({
      task,
      items: await search(options.site, task.query, task.page),
    })));
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(`warning ${result.reason}`);
        continue;
      }
      found.push(...result.value.items);
      console.log(`${result.value.task.query} / ${result.value.task.page}: ${result.value.items.length}`);
    }
  }
  const unique = [...new Map(found.map((item) => [item.id, item])).values()]
    .filter((item) => item.id && item.dataUrl && item.sourceUrl && item.license);
  if (!unique.length) throw new Error("No reusable public wink candidates were found");

  const packFiles = await readdir(path.join(options.catalog, "packs"));
  let nextPack = packFiles.reduce((largest, name) => {
    const number = Number(name.match(/[0-9]{3}/)?.[0] ?? -1);
    return Math.max(largest, number);
  }, -1) + 1;
  const newShards = [];
  let pending = [];
  let pendingBytes = 0;
  let accepted = 0;
  const flush = async () => {
    if (!pending.length) return;
    const token = String(nextPack).padStart(3, "0");
    const packName = `target_pack_${token}.bin`;
    const shardName = `target_wink_pack_${token}.json`;
    let offset = 0;
    const items = pending.map(({ source, image }) => {
      const item = {
        id: `target-wink-${source.id}`,
        name: source.title || "Winking portrait",
        pack: packName,
        offset,
        length: image.byteLength,
        feature: Array(FEATURE_LENGTH).fill(0),
        sourceName: source.sourceName || "Openverse / Wikimedia Commons",
        sourceUrl: source.sourceUrl,
        creator: source.creator || "Unknown creator",
        license: source.license,
        licenseUrl: source.licenseUrl || source.sourceUrl,
      };
      offset += image.byteLength;
      return item;
    });
    await writeFile(path.join(options.catalog, "packs", packName), Buffer.concat(pending.map(({ image }) => image)));
    await writeFile(
      path.join(options.catalog, "shards", shardName),
      JSON.stringify({ cell: "0:0", provisional: true, purpose: "wink-coverage", items }),
    );
    newShards.push(shardName);
    accepted += items.length;
    nextPack += 1;
    pending = [];
    pendingBytes = 0;
    console.log(`packed ${accepted}/${unique.length} targeted faces`);
  };

  for (const source of unique) {
    try {
      const image = await encode(source.dataUrl);
      if (pending.length && pendingBytes + image.byteLength > PACK_TARGET_BYTES) await flush();
      pending.push({ source, image });
      pendingBytes += image.byteLength;
    } catch (error) {
      console.warn(`warning ${source.id}: ${error}`);
    }
  }
  await flush();
  if (!accepted) throw new Error("Targeted images could not be encoded");

  const cell = manifest.cells["0:0"] ?? { count: 0, shards: [] };
  manifest.totalFaces += accepted;
  manifest.sourceFaces += accepted;
  manifest.catalogId = `${manifest.catalogId}-wink-staging`;
  manifest.shardsContainGeometry = false;
  manifest.cells["0:0"] = {
    count: Number(cell.count ?? 0) + accepted,
    shards: [...(cell.shards ?? []), ...newShards],
  };
  manifest.stats = {
    ...(manifest.stats ?? {}),
    targetedWinkCandidates: accepted,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(`staged ${accepted} unique CC/PD wink-search candidates`);
}

await main();
