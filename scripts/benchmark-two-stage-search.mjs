#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PROJECTION_RANK_MODES,
  rankProjectionCandidateModes,
  rankProjectionCandidateModesTwoStage,
} from "../app/projection-matching.ts";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = process.argv[2] ?? path.join(root, "public/seed-catalog/manifest.json");
const analysisPath = process.argv[3] ?? path.join(root, "public/test-fixtures/reference-face-motion-analysis.json");
const frameStride = Math.max(1, Number(process.argv[4] ?? 1));
const detailedPoolLimit = Math.max(256, Number(process.argv[5] ?? 1_024));
const useRuntimePoseFilter = process.argv[6] === "pose";

function decodeVector(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const values = new Float32Array(bytes.length / 2);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = bytes.readInt16LE(index * 2) / 4096;
  }
  return values;
}

function geometry(item) {
  return {
    structure: decodeVector(item.shape),
    surface: decodeVector(item.mesh),
    projection: decodeVector(item.projection),
    layout: item.layout,
  };
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const catalogRoot = path.dirname(manifestPath);
const sourceFiles = manifest.indexFiles?.length
  ? manifest.indexFiles
  : [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) => cell.shards ?? []))]
      .map((file) => `shards/${file}`);
const entries = sourceFiles.flatMap((file) =>
  JSON.parse(fs.readFileSync(path.join(catalogRoot, file), "utf8")).items ?? [],
);
const candidates = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
  .filter((entry) => entry.shape && entry.mesh && entry.projection && entry.layout)
  .map((entry) => ({ id: entry.id, feature: entry.feature, geometry: geometry(entry) }));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const frames = analysis.frames.filter((_, index) => index % frameStride === 0).map((frame) => ({
  time: frame.time,
  feature: frame.feature,
  geometry: geometry(frame),
}));

const recalls = Object.fromEntries(PROJECTION_RANK_MODES.map((mode) => [mode, 0]));
let strictTop1 = 0;
let exhaustiveMs = 0;
let twoStageMs = 0;
let searchedCandidates = 0;
for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
  const frame = frames[frameIndex];
  const withinPose = (yawLimit, pitchLimit) => candidates.filter((candidate) =>
    Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90 <= yawLimit &&
    Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90 <= pitchLimit
  );
  let localCandidates = candidates;
  if (useRuntimePoseFilter) {
    localCandidates = withinPose(12, 15);
    if (localCandidates.length < Math.min(384, candidates.length)) localCandidates = withinPose(18, 21);
    if (localCandidates.length < 4) localCandidates = candidates;
  }
  searchedCandidates += localCandidates.length;
  const startExhaustive = performance.now();
  const exhaustive = rankProjectionCandidateModes(frame, localCandidates, 8);
  exhaustiveMs += performance.now() - startExhaustive;
  const startTwoStage = performance.now();
  const twoStage = rankProjectionCandidateModesTwoStage(
    frame, localCandidates, 8, detailedPoolLimit,
  );
  twoStageMs += performance.now() - startTwoStage;
  for (const mode of PROJECTION_RANK_MODES) {
    const expected = new Set(exhaustive[mode].map(({ candidate }) => candidate.id));
    if (twoStage[mode].some(({ candidate }) => expected.has(candidate.id))) recalls[mode] += 1;
  }
  if (twoStage.strict[0]?.candidate.id === exhaustive.strict[0]?.candidate.id) strictTop1 += 1;
  if (frameIndex % 50 === 49 || frameIndex + 1 === frames.length) {
    console.log(`benchmarked ${frameIndex + 1}/${frames.length} frames`);
  }
}

console.log(JSON.stringify({
  candidates: candidates.length,
  frames: frames.length,
  frameStride,
  detailedPoolLimit,
  useRuntimePoseFilter,
  averageSearchedCandidates: searchedCandidates / frames.length,
  exhaustiveAverageMs: exhaustiveMs / frames.length,
  twoStageAverageMs: twoStageMs / frames.length,
  speedup: exhaustiveMs / twoStageMs,
  strictTop1Percent: strictTop1 / frames.length * 100,
  top8RecallPercent: Object.fromEntries(
    PROJECTION_RANK_MODES.map((mode) => [mode, recalls[mode] / frames.length * 100]),
  ),
}, null, 2));
