#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const catalog = values.get("--catalog");
  if (!catalog) {
    throw new Error(
      "Usage: finalize-supplement-catalog.mjs --catalog <directory> [--catalog-id <id>]",
    );
  }
  return {
    catalog: path.resolve(catalog),
    catalogId: (values.get("--catalog-id") ?? "").trim(),
  };
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function finalizeSupplementCatalog(catalog, catalogId = "") {
  const manifestPath = path.join(catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const shardNames = [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) =>
    cell.shards ?? (cell.shard ? [cell.shard] : []),
  ))];
  if (!shardNames.length) throw new Error("supplement catalog contains no shards");

  const ids = new Set();
  let searchableFaces = 0;
  let sourceUrls = 0;
  let licenseUrls = 0;
  let licensedEntries = 0;
  const failures = [];

  for (const shardName of shardNames) {
    const shardPath = path.join(catalog, "shards", shardName);
    const payload = JSON.parse(await readFile(shardPath, "utf8"));
    for (const entry of payload.items ?? []) {
      searchableFaces += 1;
      if (!entry.id || ids.has(entry.id)) failures.push(`${shardName}: missing or duplicate id ${entry.id ?? ""}`);
      else ids.add(entry.id);

      if (validHttpUrl(entry.sourceUrl)) sourceUrls += 1;
      else failures.push(`${entry.id}: missing sourceUrl`);

      const license = String(entry.license ?? "").trim();
      if (license && license.toLowerCase() !== "unspecified") licensedEntries += 1;
      else failures.push(`${entry.id}: missing license`);

      if (validHttpUrl(entry.licenseUrl)) licenseUrls += 1;
      else failures.push(`${entry.id}: missing licenseUrl`);
    }
  }

  if (!searchableFaces) throw new Error("supplement catalog contains no searchable faces");
  if (failures.length) {
    const preview = failures.slice(0, 12).join("\n");
    throw new Error(`supplement provenance validation failed (${failures.length} entries):\n${preview}`);
  }

  const finalized = {
    ...manifest,
    catalogId: catalogId || manifest.catalogId || `coverage-supplement-${Date.now()}`,
    totalFaces: searchableFaces,
    sourceFaces: searchableFaces,
    searchableFaces,
    indexFiles: [],
    shardsContainGeometry: true,
    stats: {
      ...(manifest.stats ?? {}),
      provenance: {
        entries: searchableFaces,
        sourceUrls,
        licenseUrls,
        licensedEntries,
      },
    },
  };
  const temporary = `${manifestPath}.next`;
  await writeFile(temporary, JSON.stringify(finalized));
  await rename(temporary, manifestPath);
  return {
    catalog: path.resolve(catalog),
    catalogId: finalized.catalogId,
    searchableFaces,
    shards: shardNames.length,
    provenanceComplete: true,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(JSON.stringify(
    await finalizeSupplementCatalog(args.catalog, args.catalogId),
    null,
    2,
  ));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
