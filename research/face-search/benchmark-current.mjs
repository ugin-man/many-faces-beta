#!/usr/bin/env node
/**
 * Warm-catalog, core-only baseline for the production video matcher.
 *
 * Imports the production pose-window, ranker and two-entry window cache. All
 * query work, including a cache lookup or missed-window assembly and result
 * assembly, is timed. Static candidate descriptor preparation is separately
 * reported. There is no query-result cache, frame skipping or future access.
 *
 * This deliberately excludes wink supplements, quality exclusions, I/O,
 * cooperative browser scheduling, sequence optimization and rendering. It is
 * not an end-to-end application benchmark or an exact strict-score oracle.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ReviewStrictRanker } from "../../app/live/review-strict-ranker.ts";
import {
  poseWindowCellKeys, shardFilesForCells, shouldExpandPoseWindow,
} from "../../app/live/review-local-catalog.ts";
import { ReviewWindowCache } from "../../app/live/review-work-cache.ts";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FEATURES = 55;
const PROJECTION = 936;
const LIMIT = 64;
const DETAILED_POOL = 1024;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "research/face-search/benchmark-current.mjs",
  "app/live/review-strict-ranker.ts", "app/live/review-local-catalog.ts",
  "app/live/review-work-cache.ts", "app/live/astra/top-k.ts",
  "app/projection-matching.ts", "app/face-actions.ts",
  "app/live/review-search.worker.ts",
];

function parseArgs(argv) {
  const options = {
    data: path.join(REPOSITORY, "work/face-search"), repetitions: 3,
    output: null, orderFile: null, manifest: null, smokeQueries: null,
    selfTest: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-test") { options.selfTest = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === "--data") options.data = path.resolve(value);
    else if (arg === "--output") options.output = path.resolve(value);
    else if (arg === "--order-file") options.orderFile = value === "-" ? "-" : path.resolve(value);
    else if (arg === "--manifest") options.manifest = path.resolve(value);
    else if (arg === "--repetitions" || arg === "--repeats") options.repetitions = Number(value);
    else if (arg === "--smoke-queries") options.smokeQueries = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) throw new Error("Invalid repetitions");
  if (options.smokeQueries !== null && (!Number.isSafeInteger(options.smokeQueries) || options.smokeQueries < 1)) {
    throw new Error("Invalid --smoke-queries");
  }
  options.output ??= path.join(options.data, "current-core-results.json");
  options.orderFile ??= path.join(options.data, "orders.json");
  options.manifest ??= path.join(options.data, "source-catalog-manifest.json");
  return options;
}

function readJson(file, provenance) {
  const bytes = fs.readFileSync(file);
  provenance[path.basename(file)] = { bytes: bytes.length, sha256: sha256(bytes) };
  return JSON.parse(bytes.toString("utf8"));
}

function readF64(file, rows, columns, provenance) {
  if (os.endianness() !== "LE") throw new Error("This loader requires a little-endian host");
  const bytes = fs.readFileSync(file);
  const expected = rows * columns * 8;
  if (bytes.length !== expected) throw new Error(`${file}: expected ${expected} bytes, found ${bytes.length}`);
  provenance[path.basename(file)] = { bytes: bytes.length, sha256: sha256(bytes), shape: [rows, columns], dtype: "<f8" };
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : Buffer.from(bytes);
  const values = new Float64Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 8);
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) throw new Error(`${file}: non-finite value at ${i}`);
  return values;
}

function geometry(projection) {
  // The ranker reads projection only. No surface, structure or layout score is
  // removed from its formula by these placeholders: those fields are unused.
  return { projection, structure: [], surface: [], layout: [0, 0, 0, 0] };
}

function readCandidates(directory, manifest, provenance) {
  const ids = readJson(path.join(directory, "candidate-ids.json"), provenance);
  const shardNames = readJson(path.join(directory, "candidate-shards.json"), provenance);
  if (!Array.isArray(ids) || !ids.length || !Array.isArray(shardNames) || shardNames.length !== ids.length) {
    throw new Error("Invalid candidate ID/shard arrays");
  }
  const declared = Number(manifest.searchableFaces ?? manifest.totalFaces);
  if (ids.length !== 70000 || ids.length !== declared) throw new Error(`Complete 70,000-record catalog required: ${ids.length}/${declared}`);
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== "string" || !ids[i] || (i && ids[i - 1] >= ids[i])) {
      throw new Error(`Candidate IDs must be unique and in canonical string order, at ${i}`);
    }
    if (typeof shardNames[i] !== "string" || !shardNames[i]) throw new Error(`Missing shard mapping at ${i}`);
  }
  const features = readF64(path.join(directory, "candidates.features.f64"), ids.length, FEATURES, provenance);
  const projections = readF64(path.join(directory, "candidates.projections.f64"), ids.length, PROJECTION, provenance);
  const candidates = [];
  const shards = new Map();
  for (let i = 0; i < ids.length; i++) {
    // Production catalog projections are Int16 / 4096 decoded into Float32.
    // Reject data that would silently change when restoring that representation.
    const projection = Float32Array.from(projections.subarray(i * PROJECTION, (i + 1) * PROJECTION));
    for (let j = 0; j < PROJECTION; j++) {
      if (projection[j] !== projections[i * PROJECTION + j]) throw new Error(`Lossy Float32 projection restoration: ${ids[i]}[${j}]`);
    }
    const candidate = {
      id: ids[i], catalogIndex: i,
      feature: Array.from(features.subarray(i * FEATURES, (i + 1) * FEATURES)),
      geometry: geometry(projection),
    };
    candidates.push(candidate);
    if (!shards.has(shardNames[i])) shards.set(shardNames[i], []);
    shards.get(shardNames[i]).push(candidate);
  }
  const referenced = new Set(shardFilesForCells(manifest, Object.keys(manifest.cells)));
  for (const file of shards.keys()) if (!referenced.has(file)) throw new Error(`Candidate shard is absent from manifest cells: ${file}`);
  for (const file of referenced) if (!shards.has(file)) shards.set(file, []);
  return { candidates, shards };
}

function readQueries(directory, provenance) {
  const metadata = readJson(path.join(directory, "queries.json"), provenance);
  if (!Array.isArray(metadata) || !metadata.length) throw new Error("queries.json must be a nonempty metadata array");
  const features = readF64(path.join(directory, "queries.features.f64"), metadata.length, FEATURES, provenance);
  const projections = readF64(path.join(directory, "queries.projections.f64"), metadata.length, PROJECTION, provenance);
  const ids = new Set();
  return metadata.map((entry, index) => {
    const id = String(entry.sourceFrameIndex ?? entry.id ?? index);
    if (ids.has(id)) throw new Error(`Duplicate query ID: ${id}`);
    ids.add(id);
    if (!Number.isFinite(entry.time) || typeof entry.compensateRoll !== "boolean") throw new Error(`Invalid query metadata: ${id}`);
    return {
      ...entry, id, queryIndex: index,
      feature: Array.from(features.subarray(index * FEATURES, (index + 1) * FEATURES)),
      geometry: geometry(Array.from(projections.subarray(index * PROJECTION, (index + 1) * PROJECTION))),
    };
  });
}

function readOrders(file, queryCount, provenance) {
  const bytes = fs.readFileSync(file === "-" ? 0 : file);
  provenance["orders.json"] = { bytes: bytes.length, sha256: sha256(bytes), input: file === "-" ? "stdin" : path.basename(file) };
  const value = JSON.parse(bytes.toString("utf8"));
  const supplied = value.orders ?? value;
  const entries = Array.isArray(supplied)
    ? supplied.map(item => [item.name, item.indices ?? item.queryIndices])
    : Object.entries(supplied).filter(([, order]) => Array.isArray(order));
  if (!entries.length) throw new Error("Order file has no named orders");
  const seenNames = new Set();
  for (const [name, order] of entries) {
    if (typeof name !== "string" || !name || seenNames.has(name)) throw new Error("Invalid or duplicate order name");
    seenNames.add(name);
    if (!Array.isArray(order) || order.length !== queryCount || new Set(order).size !== queryCount ||
        order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= queryCount)) {
      throw new Error(`Order ${name} is not a complete query permutation`);
    }
  }
  return { seed: value.seed ?? null, orders: entries.map(([name, indices]) => ({ name, indices })) };
}

function createCore(manifest, shards, ranker = new ReviewStrictRanker()) {
  const windows = new ReviewWindowCache(2, 40000);
  function loadCells(keys) {
    const files = shardFilesForCells(manifest, keys);
    const known = windows.get(files);
    if (known) return known;
    const candidates = [];
    // Same file and deduplication order as review-search.worker.ts. Input rows
    // within each shard are canonical-ID ordered, a disclosed fixture choice.
    for (const file of files) {
      const rows = shards.get(file);
      if (!rows) throw new Error(`Missing preloaded shard: ${file}`);
      for (const candidate of rows) candidates.push(candidate);
    }
    const unique = [...new Map(candidates.map(item => [item.id, item])).values()];
    windows.set(files, unique);
    return unique;
  }
  function query(frame) {
    const started = performance.now();
    let candidates = loadCells(poseWindowCellKeys(manifest, frame.feature, 12, 15));
    const expanded = shouldExpandPoseWindow(candidates.length, 384);
    if (expanded) candidates = loadCells(poseWindowCellKeys(manifest, frame.feature, 18, 21));
    const poolDone = performance.now();
    const ranked = ranker.rank(frame, candidates, LIMIT, Math.min(DETAILED_POOL, candidates.length));
    const rankDone = performance.now();
    const indices = ranked.map(item => item.candidate.catalogIndex);
    const strictScores = ranked.map(item => item.error.strictTotal);
    const finished = performance.now();
    return {
      indices, strictScores, returnedCount: indices.length, poseCandidateCount: candidates.length,
      expandedPoseWindow: expanded,
      elapsedMs: finished - started, poseWindowMs: poolDone - started,
      rankMs: rankDone - poolDone, resultAssemblyMs: finished - rankDone,
    };
  }
  return { query, ranker, windows };
}

function warmCandidateDescriptors(ranker, candidates) {
  const started = performance.now();
  const representative = candidates[0];
  const dummy = {
    time: 0, compensateRoll: true, feature: representative.feature.slice(),
    geometry: geometry(Array.from(representative.geometry.projection)),
  };
  // A DB-only dummy, never a test-video query. Small chunks bypass coarse
  // selection so every immutable candidate obtains its detailed descriptor.
  for (let offset = 0; offset < candidates.length; offset += DETAILED_POOL) {
    ranker.rank(dummy, candidates.slice(offset, offset + DETAILED_POOL), LIMIT, DETAILED_POOL);
  }
  // Populate all coarse mouth-shape descriptors through the unchanged API.
  ranker.rank(dummy, candidates, LIMIT, DETAILED_POOL);
  return { elapsedMs: performance.now() - started, querySource: "copy of first canonical catalog record; no test queries", counters: ranker.stats() };
}

function subtractNumbers(after, before) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key,
    typeof value === "number" ? value - (before[key] ?? 0) : subtractNumbers(value, before[key] ?? {}),
  ]));
}

function summarize(rows) {
  const values = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const quantile = p => {
    const at = (values.length - 1) * p;
    return values[Math.floor(at)] + (values[Math.ceil(at)] - values[Math.floor(at)]) * (at % 1);
  };
  const totalMs = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
  return {
    queries: rows.length, totalMs, meanMs: totalMs / rows.length,
    medianMs: quantile(0.5), p95Ms: quantile(0.95), maximumMs: values.at(-1),
    queriesPerSecond: rows.length * 1000 / totalMs,
    poseWindowMs: rows.reduce((sum, row) => sum + row.poseWindowMs, 0),
    rankMs: rows.reduce((sum, row) => sum + row.rankMs, 0),
    resultAssemblyMs: rows.reduce((sum, row) => sum + row.resultAssemblyMs, 0),
    emptyResults: rows.filter(row => !row.returnedCount).length,
    expandedWindows: rows.filter(row => row.expandedPoseWindow).length,
  };
}

function assertResult(result, candidateCount) {
  if (result.indices.length !== result.strictScores.length || new Set(result.indices).size !== result.indices.length) {
    throw new Error("Malformed ranker result");
  }
  if (result.returnedCount !== Math.min(LIMIT, result.poseCandidateCount)) throw new Error("Ranker returned an unexpected result count");
  result.indices.forEach(index => assert(Number.isSafeInteger(index) && index >= 0 && index < candidateCount));
  result.strictScores.forEach((score, index) => {
    assert(Number.isFinite(score));
    if (index) assert(score >= result.strictScores[index - 1]);
  });
}

function selfTest() {
  const candidates = Array.from({ length: 430 }, (_, index) => ({
    id: `fixture-${String(index).padStart(4, "0")}`, catalogIndex: index,
    feature: Array.from({ length: FEATURES }, (_, j) => j < 3 ? 0 : ((index + j * 7) % 97) / 100),
    geometry: geometry(Float32Array.from({ length: PROJECTION }, (_, j) =>
      (j % 2 ? Math.floor(j / 2) / 468 : Math.sin(j * 0.17)) * 0.8 + (index % 11) / 4096)),
  }));
  const manifest = { poseStep: 3, cells: { "0:0": { shards: ["a", "b"] } } };
  const shards = new Map([["a", candidates.slice(0, 200)], ["b", candidates.slice(200)]]);
  const core = createCore(manifest, shards);
  const frame = { time: 0, compensateRoll: true, feature: candidates[37].feature.slice(), geometry: geometry(Array.from(candidates[37].geometry.projection)) };
  const expected = new ReviewStrictRanker().rank(frame, candidates, LIMIT, Math.min(DETAILED_POOL, candidates.length));
  const cold = core.query(frame);
  const warm = core.query(frame);
  assertResult(cold, candidates.length); assertResult(warm, candidates.length);
  assert.deepEqual(cold.indices, expected.map(item => item.candidate.catalogIndex));
  assert.deepEqual(cold.strictScores, expected.map(item => item.error.strictTotal));
  assert.deepEqual(warm.indices, cold.indices);
  assert.deepEqual(warm.strictScores, cold.strictScores);
  assert.equal(core.windows.stats().hits, 1);
  core.windows.clear();
  assert.equal(core.windows.stats().references, 0);
  const warmed = warmCandidateDescriptors(core.ranker, candidates);
  assert(warmed.elapsedMs >= 0);
  assert.deepEqual(core.query(frame).indices, cold.indices);
  console.log(JSON.stringify({ event: "self-test", passed: true, fixtureCandidates: candidates.length, note: "synthetic correctness only; not performance evidence" }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node research/face-search/benchmark-current.mjs [--data DIR] [--order-file FILE|-] [--repetitions 3] [--output FILE] [--manifest FILE] [--smoke-queries N] [--self-test]\nOrder schema: {seed:20261111,orders:{original:[0,1,...],shuffled:[...]}}\nAll binary inputs are little-endian row-major float64. Full runs require all 70,000 candidates.");
    return;
  }
  if (options.selfTest) { selfTest(); return; }
  const startedAt = new Date().toISOString();
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(path.join(REPOSITORY, file)))]));
  const preparationStarted = performance.now();
  const inputFiles = {};
  const manifest = readJson(options.manifest, inputFiles);
  if (!manifest.cells || !Object.keys(manifest.cells).length) throw new Error("Catalog manifest lacks pose cells");
  const catalogProvenance = readJson(path.join(options.data, "catalog.manifest.json"), inputFiles);
  const { candidates, shards } = readCandidates(options.data, manifest, inputFiles);
  const queries = readQueries(options.data, inputFiles);
  const { seed, orders } = readOrders(options.orderFile, queries.length, inputFiles);
  const preparationMs = performance.now() - preparationStarted;
  const core = createCore(manifest, shards);
  const warmup = warmCandidateDescriptors(core.ranker, candidates);
  // Exercise the production-sized coarse loops and pose-window path as well
  // as descriptor construction. These fixed queries are exclusively DB-derived
  // and do not expose any measured video's current or future frame.
  const warmSourceIndices = [0, Math.floor(candidates.length / 2), candidates.length - 1];
  const coreWarmupStarted = performance.now();
  for (const index of warmSourceIndices) {
    const candidate = candidates[index];
    const frame = {
      time: 0, compensateRoll: true, feature: candidate.feature.slice(),
      geometry: geometry(Array.from(candidate.geometry.projection)),
    };
    assertResult(core.query(frame), candidates.length);
  }
  warmup.productionPath = {
    elapsedMs: performance.now() - coreWarmupStarted, sourceCatalogIndices: warmSourceIndices,
    querySource: "first, middle and last canonical DB records; no test queries",
    windowStatsBeforeClear: core.windows.stats(),
  };
  core.windows.clear();
  warmup.countersAfterProductionPath = core.ranker.stats();
  const expectedByQuery = new Map();
  const observations = [];
  const passes = [];
  console.log(JSON.stringify({ event: "prepared", candidates: candidates.length, queries: queries.length, preparationMs, descriptorWarmupMs: warmup.elapsedMs, smoke: options.smokeQueries !== null }));
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    // Alternate order-family scheduling across repetitions. The shared file
    // fixes the frame order inside each family; it is never generated here.
    const schedule = repetition % 2 ? [...orders].reverse() : orders;
    for (const order of schedule) {
      core.windows.clear();
      const windowBefore = core.windows.stats();
      const rankBefore = core.ranker.stats();
      const indices = options.smokeQueries === null ? order.indices : order.indices.slice(0, options.smokeQueries);
      const passRows = [];
      const passStarted = performance.now();
      for (let position = 0; position < indices.length; position++) {
        const queryIndex = indices[position];
        const frame = queries[queryIndex];
        const result = core.query(frame);
        assertResult(result, candidates.length);
        // Validation and result retention are outside query timing. Keep one
        // reference per query so order/cache effects cannot alter its answer.
        const signature = JSON.stringify([result.indices, result.strictScores]);
        if (expectedByQuery.has(queryIndex)) {
          assert.equal(signature, expectedByQuery.get(queryIndex), `Order or repetition changed query ${frame.id}`);
        } else expectedByQuery.set(queryIndex, signature);
        const row = { order: order.name, repetition, position, queryIndex, queryId: frame.id, sourceFrameIndex: frame.sourceFrameIndex ?? null, time: frame.time, ...result };
        observations.push(row); passRows.push(row);
      }
      const pass = {
        order: order.name, repetition, queryOrderSha256: sha256(JSON.stringify(indices)),
        wallMsIncludingUntimedValidation: performance.now() - passStarted,
        ...summarize(passRows), windowStats: subtractNumbers(core.windows.stats(), windowBefore),
        rankStats: subtractNumbers(core.ranker.stats(), rankBefore),
      };
      passes.push(pass);
      console.log(JSON.stringify({ event: "pass-complete", ...pass }));
    }
  }
  for (const [file, expectedHash] of Object.entries(sourceHashes)) {
    assert.equal(sha256(fs.readFileSync(path.join(REPOSITORY, file))), expectedHash, `Source changed during benchmark: ${file}`);
  }
  const result = {
    schemaVersion: 1, method: "production_video_core_pose_window_strict_ranker", startedAt, completedAt: new Date().toISOString(),
    scope: "warm in-memory 70k catalog; core-only video candidate search; no end-to-end or exact-neighbor claim",
    smoke: options.smokeQueries !== null,
    configuration: {
      topK: LIMIT, detailedPoolLimit: DETAILED_POOL, poseWindowDegrees: [12, 15],
      expandedPoseWindowDegrees: [18, 21], expandBelow: 384,
      windowCache: { maxWindows: 2, maxReferences: 40000, resetAtEveryPass: true },
      descriptorCache: "all immutable candidate descriptors prepared with a DB-only dummy; current query prepared afresh",
      resultCache: false, inputFrameSkipping: false, repetitions: options.repetitions, seed,
      queryOrders: orders.map(order => ({ name: order.name, indices: options.smokeQueries === null ? order.indices : order.indices.slice(0, options.smokeQueries) })),
      candidateOrder: "canonical ID within each shard; production cell/file and specialist-admission order retained",
      queryRepresentation: "Array of float64 Number values", candidateRepresentation: "feature Number[]; losslessly restored projection Float32Array",
      timed: ["pose window and file list", "window-cache lookup/miss construction", "production ranking", "returned index and strict-score assembly"],
      excluded: ["I/O and decode", "static descriptor preparation", "wink supplemental catalog", "quality overlay exclusions", "browser cooperative scheduling", "sequence optimization", "rendering", "untimed correctness checks/report writes"],
    },
    environment: {
      node: process.version, v8: process.versions.v8, platform: process.platform, architecture: process.arch,
      cpu: os.cpus()[0]?.model ?? null, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
      execArgv: process.execArgv, runtimeComparisonCaveat: "Node.js production core; native Python/Faiss/HNSW comparisons measure implemented systems, not algorithm alone",
    },
    provenance: { inputFiles, sourceHashes, catalog: catalogProvenance },
    preparation: { loadAndValidationMs: preparationMs, descriptorWarmup: warmup, candidateCount: candidates.length, queryCount: queries.length },
    validation: { answerInvariantAcrossOrdersAndRepetitions: true, distinctQueriesChecked: expectedByQuery.size, oracleComparison: "performed externally against exhaustive strictTotal top-64; this baseline has heuristic shortlist and shape-gate selection" },
    passes,
    summaries: orders.map(order => ({ order: order.name, ...summarize(observations.filter(row => row.order === order.name)) })),
    observations,
    memoryAtFinish: process.memoryUsage(),
    limitations: [
      "Candidate shard-internal canonical order can change tie order relative to a deployed raw shard; no claim of byte-identical whole-application output.",
      "The existing pose-window cache is maintained. It stores static candidate references, not past query answers.",
      "Three repetitions do not create three independent videos. Report descriptive timing, not population-level significance.",
      "Accuracy means agreement with a fixed score oracle; it is not human-perceived facial similarity or identity-recognition accuracy.",
      "Synthetic --self-test cases are correctness checks only and never performance evidence.",
    ],
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify({ event: "complete", output: options.output, observations: observations.length, passes: passes.length, answerInvariance: true }));
}

main();
