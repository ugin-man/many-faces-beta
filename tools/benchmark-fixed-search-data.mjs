import fs from "node:fs";
import path from "node:path";

function decode(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const values = new Float32Array(bytes.length / 2);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readInt16LE(index * 2) / 4096;
  return values;
}

export function geometry(item) {
  return {
    structure: decode(item.shape),
    surface: decode(item.mesh),
    projection: decode(item.projection),
    layout: item.layout,
  };
}

export function loadCandidates(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const root = path.dirname(manifestPath);
  const files = manifest.indexFiles?.length
    ? manifest.indexFiles
    : [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) => cell.shards ?? []))]
      .map((file) => `shards/${file}`);
  const entries = files.flatMap((file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).items ?? []);
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .filter((entry) => entry.shape && entry.mesh && entry.projection && entry.layout)
    .map((entry) => ({ id: entry.id, feature: entry.feature, geometry: geometry(entry) }));
}

export function loadFrames(filename, stride) {
  const analysis = JSON.parse(fs.readFileSync(filename, "utf8"));
  return analysis.frames
    .filter((_, index) => index % stride === 0)
    .map((frame) => ({ time: frame.time, feature: frame.feature, geometry: geometry(frame) }));
}

export function canonicalId(id) {
  return String(id).replace(/\u0000replica-[0-9]+$/, "");
}

export function withinPose(frame, candidate, yaw = 18, pitch = 21) {
  return Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90 <= yaw &&
    Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90 <= pitch;
}

export function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * 0.95)];
}
