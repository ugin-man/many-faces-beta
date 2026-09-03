import { performance } from "node:perf_hooks";
import {
  buildLiveCandidateIndex,
  rankLiveCandidates,
} from "../app/live-matching.ts";
import { FACE_ACTION_FEATURE_INDEX } from "../app/face-actions.ts";

const CANDIDATE_COUNT = Number(process.env.LIVE_BENCH_CANDIDATES ?? 2_400);
const FRAME_COUNT = Number(process.env.LIVE_BENCH_FRAMES ?? 240);
const SEARCH_AVERAGE_LIMIT_MS = Number(process.env.LIVE_BENCH_AVG_LIMIT_MS ?? 16);
const SEARCH_P95_LIMIT_MS = Number(process.env.LIVE_BENCH_P95_LIMIT_MS ?? 28);
const INDEX_LIMIT_MS = Number(process.env.LIVE_BENCH_INDEX_LIMIT_MS ?? 1_500);

function pseudo(index, salt = 0) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function feature(index, yaw, pitch) {
  const output = Array(55).fill(0);
  output[0] = yaw / 90;
  output[1] = pitch / 90;
  output[2] = (pseudo(index, 2) * 12 - 6) / 90;
  const actions = [
    "jawOpen",
    "mouthPucker",
    "mouthFunnel",
    "mouthSmileLeft",
    "mouthSmileRight",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "browInnerUp",
    "browDownLeft",
    "browDownRight",
  ];
  actions.forEach((name, actionIndex) => {
    output[FACE_ACTION_FEATURE_INDEX[name]] = pseudo(index, actionIndex + 10) * 0.85;
  });
  return output;
}

function vector(length, seed, scale) {
  return Float32Array.from(
    { length },
    (_, index) => (pseudo(seed * 7 + index, seed % 13) - 0.5) * scale,
  );
}

function geometry(seed) {
  return {
    structure: vector(180, seed, 0.16),
    surface: vector(600, seed + 31, 0.18),
    projection: vector(936, seed + 79, 0.22),
    layout: [
      0.5 + (pseudo(seed, 1) - 0.5) * 0.05,
      0.5 + (pseudo(seed, 2) - 0.5) * 0.05,
      0.72 + pseudo(seed, 3) * 0.12,
      0.78 + pseudo(seed, 4) * 0.12,
    ],
  };
}

function candidate(index) {
  const yaw = -45 + (index % 31) * 3;
  const pitch = -36 + (Math.floor(index / 31) % 25) * 3;
  return {
    id: `bench-${String(index).padStart(5, "0")}`,
    name: `BENCH ${index}`,
    url: `/api/catalog/image?id=bench-${index}.webp`,
    feature: feature(index, yaw, pitch),
    geometry: geometry(index),
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, index) => candidate(index));
const indexStarted = performance.now();
const index = buildLiveCandidateIndex(candidates);
const indexMs = performance.now() - indexStarted;

const searchTimes = [];
let currentId = null;
const recentIds = [];
for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
  const phase = frameIndex / Math.max(1, FRAME_COUNT - 1);
  const yaw = Math.sin(phase * Math.PI * 4) * 33;
  const pitch = Math.sin(phase * Math.PI * 2.5 + 0.8) * 20;
  const frame = {
    feature: feature(50_000 + frameIndex, yaw, pitch),
    geometry: geometry(50_000 + frameIndex),
  };
  const started = performance.now();
  const result = rankLiveCandidates(index, frame, {
    mode: "strict",
    budget: 128,
    detailedLimit: 48,
    currentId,
    recentIds,
    holdBias: 0.002,
    hysteresis: 0.002,
    continuityWeight: 0.028,
  });
  searchTimes.push(performance.now() - started);
  if (result.winner) {
    currentId = result.winner.candidate.id;
    recentIds.unshift(currentId);
    if (recentIds.length > 12) recentIds.length = 12;
  }
}

const averageMs = searchTimes.reduce((sum, value) => sum + value, 0) / searchTimes.length;
const report = {
  schemaVersion: 1,
  candidateCount: CANDIDATE_COUNT,
  frameCount: FRAME_COUNT,
  indexMs: Number(indexMs.toFixed(3)),
  searchAverageMs: Number(averageMs.toFixed(3)),
  searchP50Ms: Number(percentile(searchTimes, 0.5).toFixed(3)),
  searchP95Ms: Number(percentile(searchTimes, 0.95).toFixed(3)),
  searchMaxMs: Number(Math.max(...searchTimes).toFixed(3)),
  limits: {
    indexMs: INDEX_LIMIT_MS,
    searchAverageMs: SEARCH_AVERAGE_LIMIT_MS,
    searchP95Ms: SEARCH_P95_LIMIT_MS,
  },
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (indexMs > INDEX_LIMIT_MS) failures.push(`index ${indexMs.toFixed(2)}ms > ${INDEX_LIMIT_MS}ms`);
if (averageMs > SEARCH_AVERAGE_LIMIT_MS) {
  failures.push(`average ${averageMs.toFixed(2)}ms > ${SEARCH_AVERAGE_LIMIT_MS}ms`);
}
const p95 = percentile(searchTimes, 0.95);
if (p95 > SEARCH_P95_LIMIT_MS) failures.push(`p95 ${p95.toFixed(2)}ms > ${SEARCH_P95_LIMIT_MS}ms`);
if (failures.length) {
  console.error(`Realtime benchmark failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
}
