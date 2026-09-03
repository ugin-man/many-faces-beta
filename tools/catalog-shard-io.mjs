import { readFile } from "node:fs/promises";
import path from "node:path";

export const FEATURE_LENGTH = 55;
export const SHARD_ENTRY_LIMIT = 700;

export async function loadCatalog(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = [];
  const names = [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) =>
    cell.shards ?? (cell.shard ? [cell.shard] : []),
  ))];
  for (const name of names) {
    const payload = JSON.parse(await readFile(path.join(root, "shards", name), "utf8"));
    entries.push(...(payload.items ?? []));
  }
  return { manifest, manifestPath, entries };
}

export function completeEntry(entry) {
  return Boolean(entry?.id && entry.pack &&
    Array.isArray(entry.feature) && entry.feature.length === FEATURE_LENGTH &&
    entry.feature.every(Number.isFinite) && entry.shape && entry.mesh && entry.projection &&
    Array.isArray(entry.layout) && entry.layout.length === 4 &&
    Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.length));
}

export function cellFor(entry, manifest) {
  const step = Number(manifest.poseStep ?? 3);
  const bounds = manifest.bounds ?? { yawMin: -45, yawMax: 45, pitchMin: -36, pitchMax: 36 };
  const quantize = (value, min, max) => Math.max(Number(min), Math.min(
    Number(max), Math.round(Number(value) * 90 / step) * step,
  ));
  const yaw = quantize(entry.feature[0], bounds.yawMin, bounds.yawMax);
  const pitch = quantize(entry.feature[1], bounds.pitchMin, bounds.pitchMax);
  return { key: `${yaw}:${pitch}`, yaw, pitch };
}

export function poseToken(value) {
  return value >= 0
    ? `p${String(value).padStart(3, "0")}`
    : `n${String(Math.abs(value)).padStart(3, "0")}`;
}
