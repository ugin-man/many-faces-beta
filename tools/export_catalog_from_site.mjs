#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONCURRENCY = 8;

function parseArgs(argv) {
  const options = { site: "", output: "", concurrency: DEFAULT_CONCURRENCY };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--site") options.site = value, index += 1;
    else if (flag === "--output") options.output = value, index += 1;
    else if (flag === "--concurrency") options.concurrency = Number(value), index += 1;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.site || !options.output) {
    throw new Error("Usage: export_catalog_from_site.mjs --site <url> --output <directory> [--concurrency 8]");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
    throw new Error("--concurrency must be an integer from 1 to 32");
  }
  options.site = options.site.replace(/\/$/, "");
  options.output = path.resolve(options.output);
  return options;
}

async function fetchWithRetry(url, attempts = 4) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      failure = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw failure;
}

function exportUrl(site, objectPath) {
  return `${site}/api/catalog/export?path=${encodeURIComponent(objectPath)}`;
}

async function isPresent(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function downloadObject(site, output, objectPath) {
  const destination = path.join(output, objectPath);
  if (await isPresent(destination)) return { skipped: true, objectPath };
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetchWithRetry(exportUrl(site, objectPath));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error(`Empty object: ${objectPath}`);
  const temporary = `${destination}.part-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return { skipped: false, objectPath, bytes: bytes.byteLength };
}

async function runPool(items, concurrency, task, label) {
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
      completed += 1;
      if (completed === items.length || completed % 25 === 0) {
        console.log(`${label}: ${completed}/${items.length}`);
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const options = parseArgs(process.argv);
  await mkdir(options.output, { recursive: true });

  const manifestResponse = await fetchWithRetry(exportUrl(options.site, "manifest.json"));
  const manifestText = await manifestResponse.text();
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 3 || manifest.featureLength !== 55 || !manifest.shardsContainGeometry) {
    throw new Error("The site did not return a compatible 55-feature sharded catalog");
  }

  const shards = [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) => cell.shards ?? []))].sort();
  if (!shards.length) throw new Error("Catalog manifest contains no shards");
  await runPool(
    shards,
    options.concurrency,
    (name) => downloadObject(options.site, options.output, `shards/${name}`),
    "shards",
  );

  const packs = new Set();
  let searchableFaces = 0;
  for (const shard of shards) {
    const payload = JSON.parse(await readFile(path.join(options.output, "shards", shard), "utf8"));
    for (const item of payload.items ?? []) {
      if (item.pack) packs.add(item.pack);
      searchableFaces += 1;
    }
  }
  if (searchableFaces !== manifest.searchableFaces) {
    throw new Error(`Searchable face mismatch: expected ${manifest.searchableFaces}, got ${searchableFaces}`);
  }

  await runPool(
    [...packs].sort(),
    options.concurrency,
    (name) => downloadObject(options.site, options.output, `packs/${name}`),
    "packs",
  );
  await writeFile(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    catalogId: manifest.catalogId,
    sourceFaces: manifest.sourceFaces,
    searchableFaces,
    shards: shards.length,
    packs: packs.size,
    output: options.output,
  }, null, 2));
}

await main();
