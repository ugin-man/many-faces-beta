import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FEATURE_LENGTH,
  SHARD_ENTRY_LIMIT,
  cellFor,
  completeEntry,
  loadCatalog,
  poseToken,
} from "./catalog-shard-io.mjs";

function validate(manifest) {
  if (manifest.schemaVersion !== 3) throw new Error("catalog must use schemaVersion 3");
  if (Number(manifest.featureLength) !== FEATURE_LENGTH) {
    throw new Error(`catalog must use featureLength ${FEATURE_LENGTH}`);
  }
  if (!manifest.shardsContainGeometry) throw new Error("catalog must keep geometry in shards");
}

function shardName(batchId, yaw, pitch, index) {
  return `add_${batchId}_yaw_${poseToken(yaw)}_pitch_${poseToken(pitch)}_${String(index).padStart(3, "0")}.json`;
}

async function oldCellEntries(base, manifest, key) {
  const output = [];
  const cell = manifest.cells?.[key];
  for (const name of cell?.shards ?? (cell?.shard ? [cell.shard] : [])) {
    const payload = JSON.parse(await readFile(path.join(base, "shards", name), "utf8"));
    output.push(...(payload.items ?? []));
  }
  return output;
}

export async function mergeFaceCatalog({ base, supplement, batchId, catalogId = "" }) {
  const baseCatalog = await loadCatalog(base);
  const addedCatalog = await loadCatalog(supplement);
  validate(baseCatalog.manifest);
  validate(addedCatalog.manifest);

  const ids = new Set(baseCatalog.entries.map((entry) => entry.id));
  const urls = new Set(baseCatalog.entries.map((entry) => entry.sourceUrl).filter(Boolean));
  const seen = new Set();
  const additions = addedCatalog.entries.filter((entry) => {
    if (!completeEntry(entry) || ids.has(entry.id) || seen.has(entry.id)) return false;
    if (entry.sourceUrl && urls.has(entry.sourceUrl)) return false;
    seen.add(entry.id);
    return true;
  }).map((entry) => ({ ...entry }));
  if (!additions.length) throw new Error("supplement contains no new complete entries");

  await mkdir(path.join(base, "packs"), { recursive: true });
  await mkdir(path.join(base, "shards"), { recursive: true });
  const packMap = new Map();
  for (const name of new Set(additions.map((entry) => entry.pack))) {
    const renamed = `add_${batchId}_${path.basename(name)}`;
    await copyFile(path.join(supplement, "packs", name), path.join(base, "packs", renamed));
    packMap.set(name, renamed);
  }
  for (const entry of additions) {
    entry.pack = packMap.get(entry.pack);
    entry.id = `add-${batchId}-${entry.id}`;
  }

  const grouped = new Map();
  for (const entry of additions) {
    const cell = cellFor(entry, baseCatalog.manifest);
    const group = grouped.get(cell.key) ?? { ...cell, entries: [] };
    group.entries.push(entry);
    grouped.set(cell.key, group);
  }

  const cells = { ...(baseCatalog.manifest.cells ?? {}) };
  let shardsWritten = 0;
  for (const group of grouped.values()) {
    const merged = [...await oldCellEntries(base, baseCatalog.manifest, group.key), ...group.entries]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const names = [];
    for (let start = 0; start < merged.length; start += SHARD_ENTRY_LIMIT) {
      const name = shardName(batchId, group.yaw, group.pitch, start / SHARD_ENTRY_LIMIT);
      const temporary = path.join(base, "shards", `${name}.tmp`);
      await writeFile(temporary, JSON.stringify({
        cell: group.key,
        items: merged.slice(start, start + SHARD_ENTRY_LIMIT),
      }));
      await rename(temporary, path.join(base, "shards", name));
      names.push(name);
      shardsWritten += 1;
    }
    cells[group.key] = { count: merged.length, shards: names };
  }

  const previous = Number(baseCatalog.manifest.sourceFaces ?? baseCatalog.manifest.totalFaces ?? baseCatalog.entries.length);
  const total = previous + additions.length;
  const manifest = {
    ...baseCatalog.manifest,
    catalogId: catalogId || `${baseCatalog.manifest.catalogId ?? "many-faces"}-add-${batchId}`,
    generatedAt: new Date().toISOString(),
    totalFaces: total,
    sourceFaces: total,
    searchableFaces: baseCatalog.entries.length + additions.length,
    indexFiles: [],
    shardsContainGeometry: true,
    cells: Object.fromEntries(Object.entries(cells).sort(([left], [right]) => left.localeCompare(right))),
    stats: {
      ...(baseCatalog.manifest.stats ?? {}),
      previousFaces: previous,
      addedFaces: additions.length,
      latestBatchId: batchId,
      latestBatchPacks: packMap.size,
      latestBatchShards: shardsWritten,
      poseCells: Object.keys(cells).length,
    },
  };
  const temporary = `${baseCatalog.manifestPath}.next`;
  await writeFile(temporary, JSON.stringify(manifest));
  await rename(temporary, baseCatalog.manifestPath);
  return { addedFaces: additions.length, totalFaces: total, searchableFaces: manifest.searchableFaces, packsCopied: packMap.size, shardsWritten };
}
