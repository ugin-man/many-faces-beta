/// <reference lib="webworker" />
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { catalogFeatureFromResult } from "../../catalog-feature";
import { faceGeometryFromLandmarks } from "../../offline-matching";
import { liveCandidateFromEntry, rankLiveCandidates, type LiveCandidate, type LiveCatalogEntry } from "../../live-matching";
import { compilePoseCells, ParsedShardCache, PoseNeighborhood } from "./catalog-neighborhood";
import { ReusableLiveSearchIndex } from "./live-search-index";
import { createStableLandmarker } from "../stable-landmarker";
import { readAssetJson } from "../asset-reader";
import { runtimeIdentity } from "../../runtime-identity";
import type { FrameResult } from "./runtime";

type Manifest = { totalFaces: number; searchableFaces?: number; catalogId?: string; poseStep?: number; cells: Record<string, { shards?: string[]; shard?: string }>; stats?: { cleanCore?: { knownSyntheticFaces?: number } } };
type Input = { type: "init"; origin: string; mirror?: boolean; warmup: ImageBitmap; build: string } | { type: "frame"; id: number; capturedAt: number; bitmap: ImageBitmap; currentId: string | null };
const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: FaceLandmarker | null = null;
let processing = false;
let progressSequence = 0;
let lastCatalogReport = -Infinity;
let catalogBytes = 0;
function catalogProgress(delta: number, force = false) {
  catalogBytes += delta;
  if (force || performance.now() - lastCatalogReport > 100) {
    lastCatalogReport = performance.now();
    scope.postMessage({ type: "progress", sequence: ++progressSequence, stage: "catalog", bytes: catalogBytes, files: shards.size, build: runtimeIdentity.build });
  }
}
let manifest: Manifest | null = null;
let neighborhood: PoseNeighborhood | null = null;
let origin = "";
let canvas: OffscreenCanvas | null = null;
let index: ReusableLiveSearchIndex<LiveCandidate> | null = null;
let indexSignature = "";
let poolSize = 0;
let desired: string[] = [];
let draining = false;
let catalogError: string | null = null;
const shards = new ParsedShardCache<LiveCandidate[]>(48);
const retryAfter = new Map<string, number>();
const pending = new Set<string>();
let previousFeature: number[] | null = null;
const counters = { shardRequests: 0, shardParseMs: 0, candidateDecodeMs: 0, decodedCandidates: 0, indexBuilds: 0, indexBuildMs: 0 };

async function readJson<T>(path: string): Promise<T> {
  const started = performance.now();
  const result = await readAssetJson<T>(new URL(path, origin).href, { onBytes: (_received, delta) => catalogProgress(delta) });
  counters.shardParseMs += performance.now() - started;
  return result;
}

function rebuildIndex() {
  const files = [...new Set([...desired, ...shards.keysNewestFirst()])].filter((file) => shards.has(file)).slice(0, 24);
  // File membership, not the order of equal-distance neighbors, controls the
  // index. peek must not turn this read into an LRU recency mutation.
  const signature = files.slice().sort().join("|");
  if (signature === indexSignature) return;
  indexSignature = signature;
  const started = performance.now();
  const unique = [...new Map(files.flatMap((file) => shards.peek(file) ?? []).map((candidate) => [candidate.id, candidate])).values()];
  index = unique.length ? new ReusableLiveSearchIndex(unique) : null;
  poolSize = unique.length;
  counters.indexBuilds += 1;
  counters.indexBuildMs += performance.now() - started;
}

function focusNeighborhood(feature: number[]) {
  if (!manifest || !neighborhood) return;
  const update = neighborhood.update(feature[0] * 90, feature[1] * 90);
  if (update.changed) {
    desired = [...update.files];
    for (const file of desired) shards.touch(file);
    rebuildIndex();
  }
  if (!draining) void drainShards();
}

async function drainShards() {
  draining = true;
  try {
    for (;;) {
      const batch = desired.filter((file) => !shards.has(file) && !pending.has(file) && (retryAfter.get(file) ?? 0) <= performance.now()).slice(0, 2);
      if (!batch.length) break;
      await Promise.all(batch.map(async (file) => {
        pending.add(file);
        counters.shardRequests += 1;
        try {
          const version = encodeURIComponent(manifest?.catalogId ?? "seed");
          const payload = await readJson(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${version}`) as { items?: LiveCatalogEntry[] };
          if (!Array.isArray(payload.items)) throw new Error("Invalid catalog shard");
          const started = performance.now();
          const candidates: LiveCandidate[] = [];
          for (let offset = 0; offset < payload.items.length; offset += 32) {
            for (const entry of payload.items.slice(offset, offset + 32)) {
              const candidate = liveCandidateFromEntry(entry, file);
              if (!candidate) continue;
              const url = new URL(candidate.url, origin);
              url.searchParams.set("source", "seed"); url.searchParams.set("catalog", manifest?.catalogId ?? "seed");
              candidate.url = url.toString(); candidates.push(candidate);
            }
            // Yield between decoding batches so camera frames and stop/error
            // messages do not queue behind an entire detailed catalog shard.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
          counters.candidateDecodeMs += performance.now() - started;
          counters.decodedCandidates += candidates.length;
          shards.set(file, candidates, new Set(desired));
          // A reloaded file may have the same name but new object identities.
          indexSignature = "";
          catalogError = null; catalogProgress(0, true);
        } catch (error) {
          catalogError = error instanceof Error ? error.message : String(error);
          retryAfter.set(file, performance.now() + 5000);
          while (retryAfter.size > 64) retryAfter.delete(retryAfter.keys().next().value!);
        } finally { pending.delete(file); }
      }));
      rebuildIndex();
    }
  } finally { draining = false; }
}

function featureFromResult(result: FaceLandmarkerResult) {
  const raw = catalogFeatureFromResult(result);
  const smoothed = raw.map((value, i) => previousFeature ? previousFeature[i] * (i < 3 ? 0.35 : 0.18) + value * (i < 3 ? 0.65 : 0.82) : value);
  previousFeature = smoothed;
  return smoothed;
}

async function initialize(message: Extract<Input, { type: "init" }>) {
  origin = message.origin;
  const bitmap = message.warmup;
  try {
    if (message.build !== runtimeIdentity.build) throw new Error("BUILD_MISMATCH: 解析処理が古い版です。再読み込みしてください。");
    manifest = await readJson<Manifest>("/api/catalog/manifest?source=seed");
    if (!manifest.cells || (manifest.searchableFaces ?? manifest.totalFaces) !== 70000 || Number(manifest.stats?.cleanCore?.knownSyntheticFaces ?? 0) !== 0) throw new Error("CATALOG_INVALID: 7万枚のカタログを確認できません。");
    neighborhood = new PoseNeighborhood(compilePoseCells(manifest.cells), Number(manifest.poseStep) || 3);
    landmarker = await createStableLandmarker("VIDEO", event => scope.postMessage({ type: "progress", sequence: ++progressSequence, ...event, build: runtimeIdentity.build }));
    scope.postMessage({ type: "progress", sequence: ++progressSequence, stage: "engine-warmup", bytes: 0, build: runtimeIdentity.build });
    if (!bitmap?.width || !bitmap.height) throw new Error("WARMUP_FRAME_MISSING: 入力映像がありません。");
    const warmCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = warmCanvas.getContext("2d");
    if (!context) throw new Error("WARMUP_CANVAS_FAILED");
    context.drawImage(bitmap, 0, 0);
    // Startup includes the first actual inference. The 8-second live-frame
    // watchdog must never include network/model compilation or CPU probing.
    landmarker.detectForVideo(warmCanvas, 0);
    scope.postMessage({ type: "ready", delegate: "CPU", catalogTotal: manifest.searchableFaces ?? manifest.totalFaces, build: runtimeIdentity.build });
  } finally { bitmap?.close(); }
}

async function processFrame(message: Extract<Input, { type: "frame" }>) {
  const bitmap = message.bitmap;
  const processStarted = performance.now();
  try {
    if (!landmarker) throw new Error("Tracking engine is not ready");
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("OffscreenCanvas is unavailable");
    // The camera/video input and catalog all use original pixel coordinates.
    // Mirroring is a paired display operation in the client only.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(bitmap, 0, 0, width, height);
    const started = performance.now();
    const result = landmarker.detectForVideo(canvas, message.capturedAt);
    const inferenceMs = performance.now() - started;
    const landmarks = result.faceLandmarks[0];
    const geometry = landmarks ? faceGeometryFromLandmarks(landmarks, width / height) : null;
    const feature = geometry && result.faceBlendshapes.length ? featureFromResult(result) : [];
    if (feature.length) focusNeighborhood(feature);
    const searchStarted = performance.now();
    const ranked = geometry && feature.length ? rankLiveCandidates(index, { feature, geometry }, { mode: "strict", budget: 128, detailedLimit: 48, currentId: message.currentId, diversityPenalty: 0, holdBias: 0.006 }) : null;
    const output: FrameResult = {
      type: "frame", id: message.id, capturedAt: message.capturedAt,
      face: feature.length > 0, feature,
      ranked: (ranked?.ranked ?? []).slice(0, 12).map(({ candidate, score }) => ({ id: candidate.id, name: candidate.name, url: candidate.url, score, sourceName: candidate.sourceName, sourceUrl: candidate.sourceUrl, creator: candidate.creator })),
      inferenceMs, searchMs: performance.now() - searchStarted,
      candidates: poolSize, shards: shards.size, pendingShards: pending.size, catalogError,
      diagnostics: { ...counters, activeCandidates: poolSize, coarseInspected: ranked?.inspected ?? 0, workerProcessMs: performance.now() - processStarted },
    };
    scope.postMessage(output);
  } finally { bitmap.close(); }
}

scope.onmessage = (event: MessageEvent<Input>) => {
  const failed = (error: unknown) => scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  if (event.data.type === "init") void initialize(event.data).catch(failed);
  else {
    if (processing) { event.data.bitmap.close(); failed(new Error("Concurrent frame contract violated")); return; }
    processing = true;
    void processFrame(event.data).catch(failed).finally(() => { processing = false; });
  }
};
