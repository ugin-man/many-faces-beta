#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  optimizeDistinctProjectionSequence,
  PROJECTION_RANK_MODES,
  rankProjectionCandidateModes,
} from "../app/projection-matching.ts";

const root = path.resolve(import.meta.dirname, "..");
const analysisPath = path.join(root, "public/test-fixtures/reference-face-motion-analysis.json");
const manifestPath = path.join(root, "public/seed-catalog/manifest.json");
const outputPath = path.join(root, "public/test-fixtures/reference-face-motion-rankings.json");

function decodeVector(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const values = new Float32Array(bytes.length / 2);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = bytes.readInt16LE(index * 2) / 4096;
  }
  return values;
}

function decodeGeometry(entry) {
  return {
    structure: decodeVector(entry.shape),
    surface: decodeVector(entry.mesh),
    projection: decodeVector(entry.projection),
    layout: entry.layout,
  };
}

function encodeIndexes(indexes) {
  const bytes = Buffer.allocUnsafe(indexes.length * 4);
  indexes.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes.toString("base64");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = [];
for (const file of manifest.indexFiles ?? [manifest.indexFile].filter(Boolean)) {
  const payload = JSON.parse(
    fs.readFileSync(path.join(path.dirname(manifestPath), file), "utf8"),
  );
  entries.push(...(payload.items ?? []));
}
const candidates = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
  .filter((entry) =>
    Array.isArray(entry.feature) && entry.feature.length >= 22 &&
    entry.shape && entry.mesh && entry.projection &&
    Array.isArray(entry.layout) && entry.layout.length === 4,
  )
  .map((entry) => ({
    id: entry.id,
    feature: entry.feature,
    geometry: decodeGeometry(entry),
  }));
const candidateIndexes = new Map(candidates.map((candidate, index) => [candidate.id, index]));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const frames = analysis.frames.map((frame) => ({
  time: frame.time,
  feature: frame.feature,
  geometry: decodeGeometry(frame),
}));
const beams = Object.fromEntries(PROJECTION_RANK_MODES.map((mode) => [mode, []]));
const strictBeams = [];
for (let index = 0; index < frames.length; index += 1) {
  const ranked = rankProjectionCandidateModes(frames[index], candidates, 64);
  strictBeams.push(ranked.strict);
  for (const mode of PROJECTION_RANK_MODES) {
    beams[mode].push(encodeIndexes(
      ranked[mode].map(({ candidate }) => candidateIndexes.get(candidate.id)),
    ));
  }
  if (index % 20 === 19 || index + 1 === frames.length) {
    console.log(`${index + 1}/${frames.length} frames`);
  }
}

const strictSequence = optimizeDistinctProjectionSequence(frames, strictBeams, {
  cooldown: 12,
  beamWidth: 24,
  qualityThreshold: 0.055,
  residualCoherence: 0.46,
  expressionMotionWeight: 6.2,
  motionWeights: { mouth: 0.34, eyes: 0.45, brows: 0.21 },
});

fs.writeFileSync(outputPath, JSON.stringify({
  schemaVersion: 2,
  indexBytes: 4,
  catalogId: manifest.catalogId,
  candidateCount: candidates.length,
  beamSize: 64,
  frameTimes: frames.map((frame) => frame.time),
  beams,
  sequences: {
    strict: encodeIndexes(
      strictSequence.map(({ candidate }) => candidateIndexes.get(candidate.id)),
    ),
  },
}));
console.log(`wrote ${fs.statSync(outputPath).size} bytes: ${outputPath}`);
