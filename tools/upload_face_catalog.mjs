#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

function parseArgs() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  const catalog = values.get("--catalog");
  const site = values.get("--site");
  if (!catalog || !site) {
    throw new Error("Usage: upload_face_catalog.mjs --catalog <dir> --site <url> [--key <upload key>] [--concurrency 4]");
  }
  return {
    catalog: path.resolve(catalog),
    site: site.replace(/\/$/, ""),
    key: values.get("--key"),
    concurrency: Number(values.get("--concurrency") ?? 4),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry(operation, attempts = 5) {
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

async function main() {
  const args = parseArgs();
  const manifestPath = path.join(args.catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 3 || manifest.shapeVersion !== "mediapipe-projection-468-v4" ||
    !manifest.shardsContainGeometry || !Object.keys(manifest.cells ?? {}).length
  ) {
    throw new Error("Catalog is not a completed geometry-in-shards build");
  }
  const shardNames = [...new Set(Object.values(manifest.cells).flatMap((cell) => cell.shards ?? []))];
  const packNames = new Set();
  for (const name of shardNames) {
    const payload = JSON.parse(await readFile(path.join(args.catalog, "shards", name), "utf8"));
    for (const item of payload.items ?? []) if (item.pack) packNames.add(item.pack);
  }
  // Packs 000-039 are already immutable bundled assets. The Worker falls back to
  // them when no R2 object exists, so only upload the 70k expansion packs.
  const remotePacks = [...packNames]
    .filter((name) => Number(name.match(/[0-9]{3}/)?.[0] ?? 0) >= 40)
    .sort();
  const objects = [
    ...remotePacks.map((name) => ({ remote: `packs/${name}`, local: path.join(args.catalog, "packs", name) })),
    ...shardNames.sort().map((name) => ({ remote: `shards/${name}`, local: path.join(args.catalog, "shards", name) })),
    ...(manifest.indexFiles ?? []).map((name) => ({ remote: name, local: path.join(args.catalog, name) })),
  ];
  for (const object of objects) {
    const size = (await stat(object.local)).size;
    if (!size || size > MAX_OBJECT_BYTES) throw new Error(`${object.remote} is ${size} bytes`);
  }
  let next = 0;
  let uploaded = 0;
  let uploadedBytes = 0;
  const worker = async () => {
    while (next < objects.length) {
      const index = next;
      next += 1;
      const object = objects[index];
      const body = await readFile(object.local);
      await retry(async () => {
        const headers = { "content-length": String(body.byteLength) };
        if (args.key) headers["x-catalog-upload-key"] = args.key;
        const response = await fetch(
          `${args.site}/api/catalog/upload?path=${encodeURIComponent(object.remote)}`,
          { method: "POST", headers, body, signal: AbortSignal.timeout(90_000) },
        );
        if (!response.ok) throw new Error(`${object.remote}: ${response.status} ${await response.text()}`);
      });
      uploaded += 1;
      uploadedBytes += body.byteLength;
      if (uploaded % 10 === 0 || uploaded === objects.length) {
        console.log(`uploaded ${uploaded}/${objects.length} objects (${(uploadedBytes / 1024 / 1024).toFixed(1)} MiB)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, objects.length) }, () => worker()));
  const manifestBody = await readFile(manifestPath);
  const headers = { "content-length": String(manifestBody.byteLength) };
  if (args.key) headers["x-catalog-upload-key"] = args.key;
  const response = await fetch(
    `${args.site}/api/catalog/upload?path=manifest.json`,
    { method: "POST", headers, body: manifestBody, signal: AbortSignal.timeout(90_000) },
  );
  if (!response.ok) throw new Error(`manifest: ${response.status} ${await response.text()}`);
  console.log(`published manifest last: ${manifest.totalFaces.toLocaleString()} source / ${manifest.searchableFaces.toLocaleString()} searchable`);
}

await main();
