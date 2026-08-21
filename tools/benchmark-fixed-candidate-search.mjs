#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { FixedCandidateSearchIndex } from "../app/fixed-candidate-search.ts";
import { rankProjectionCandidateModes } from "../app/projection-matching.ts";
import {
  average,
  canonicalId,
  loadCandidates,
  loadFrames,
  p95,
  withinPose,
} from "./benchmark-fixed-search-data.mjs";

function args(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return {
    manifest: path.resolve(values.get("--manifest") ?? "public/seed-catalog/manifest.json"),
    analysis: path.resolve(values.get("--analysis") ?? "public/test-fixtures/reference-face-motion-analysis.json"),
    output: path.resolve(values.get("--output") ?? "data/benchmark-fixed-candidate-search.json"),
    stride: Math.max(1, Number(values.get("--frame-stride") ?? 15)),
    budget: Math.max(32, Number(values.get("--budget") ?? 512)),
    inspected: Math.max(64, Number(values.get("--max-inspected") ?? 2_048)),
    scales: String(values.get("--scales") ?? "1,3,6").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0),
  };
}

function posePool(frame, candidates) {
  let local = candidates.filter((candidate) => withinPose(frame, candidate, 12, 15));
  if (local.length < Math.min(384, candidates.length)) local = candidates.filter((candidate) => withinPose(frame, candidate));
  return local.length >= 4 ? local : candidates;
}

async function main() {
  const options = args(process.argv);
  if (!options.scales.length) throw new Error("at least one positive scale is required");
  const base = loadCandidates(options.manifest);
  const frames = loadFrames(options.analysis, options.stride);
  const expected = frames.map((frame, index) => {
    const strict = rankProjectionCandidateModes(frame, posePool(frame, base), 8).strict;
    if (index % 10 === 9 || index + 1 === frames.length) process.stderr.write(`\rbaseline ${index + 1}/${frames.length}`);
    return strict;
  });
  process.stderr.write("\n");

  const results = [];
  for (const scale of options.scales) {
    const candidates = Array.from({ length: scale }, (_, replica) => base.map((candidate) => replica === 0
      ? candidate
      : { ...candidate, id: `${candidate.id}\u0000replica-${replica}` },
    )).flat();
    const buildStart = performance.now();
    const index = new FixedCandidateSearchIndex(candidates);
    const buildMs = performance.now() - buildStart;
    const queryMs = [];
    const detailedMs = [];
    const inspected = [];
    const recalls = [];
    let top1 = 0;
    let previousIds = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const started = performance.now();
      const retrieval = index.query(frame, { budget: options.budget, maxInspected: options.inspected, previousIds });
      queryMs.push(performance.now() - started);
      inspected.push(retrieval.inspected);
      const detailedStart = performance.now();
      const strict = rankProjectionCandidateModes(frame, retrieval.candidates, 8).strict;
      detailedMs.push(performance.now() - detailedStart);
      previousIds = strict.slice(0, 4).map(({ candidate }) => candidate.id);
      const target = new Set(expected[frameIndex].map(({ candidate }) => canonicalId(candidate.id)));
      const actual = strict.map(({ candidate }) => canonicalId(candidate.id));
      recalls.push(actual.filter((id) => target.has(id)).length / Math.max(1, target.size));
      if (actual[0] === canonicalId(expected[frameIndex][0]?.candidate.id)) top1 += 1;
    }
    const totalMs = queryMs.map((value, index) => value + detailedMs[index]);
    results.push({
      scale,
      candidates: candidates.length,
      frames: frames.length,
      budget: options.budget,
      maxInspected: options.inspected,
      buildMs,
      queryAverageMs: average(queryMs),
      queryP95Ms: p95(queryMs),
      detailedAverageMs: average(detailedMs),
      detailedP95Ms: p95(detailedMs),
      totalAverageMs: average(totalMs),
      totalP95Ms: p95(totalMs),
      inspectedAverage: average(inspected),
      inspectedMaximum: Math.max(...inspected),
      strictTop8RecallPercent: average(recalls) * 100,
      strictTop1Percent: top1 / frames.length * 100,
      passes30FpsAverage: average(totalMs) <= 33.333,
      passes60FpsAverage: average(totalMs) <= 16.667,
      passesStrictRecall: average(recalls) >= 0.9,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), baseCandidates: base.length, frames: frames.length, results };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
