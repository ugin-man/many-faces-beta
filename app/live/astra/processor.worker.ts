/// <reference lib="webworker" />
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { faceFeatureFromScores } from "../../face-actions";
import { calibrateExpressionFeature, createExpressionTracker } from "../../expression-matching";
import { createLandmarkPitchTracker, landmarkPitchDegrees } from "../../landmark-pitch";
import { faceGeometryFromLandmarks } from "../../offline-matching";
import { buildLiveCandidateIndex, liveCandidateFromEntry, rankLiveCandidates, type LiveCandidate, type LiveCatalogEntry } from "../../live-matching";
import { medianDuration, preferCpu, shouldProbeCpu } from "./delegate-policy";
import type { FrameResult } from "./runtime";

type Manifest = { totalFaces: number; searchableFaces?: number; catalogId?: string; cells: Record<string, { shards?: string[]; shard?: string }>; stats?: { cleanCore?: { knownSyntheticFaces?: number } } };
type Input = { type: "init"; origin: string; mirror: boolean } | { type: "frame"; id: number; capturedAt: number; bitmap: ImageBitmap; currentId: string | null };
const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: FaceLandmarker | null = null;
let createEngine: ((delegate: "GPU" | "CPU") => Promise<FaceLandmarker>) | null = null;
let delegate = "GPU";
let cpuProbed = false;
let processing = false;
const inferenceSamples: number[] = [];
let manifest: Manifest | null = null;
let origin = "";
let mirror = false;
let canvas: OffscreenCanvas | null = null;
let index: ReturnType<typeof buildLiveCandidateIndex> | null = null;
let poolSize = 0;
let desired: string[] = [];
let draining = false;
let catalogError: string | null = null;
const shards = new Map<string, LiveCandidate[]>();
const retryAfter = new Map<string, number>();
const pending = new Set<string>();
const pitchTracker = createLandmarkPitchTracker();
const expressionTracker = createExpressionTracker();
let previousFeature: number[] | null = null;

async function readJson(path: string) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(15000), cache: "force-cache" });
  if (!response.ok) throw new Error(`CATALOG ${response.status}`);
  return response.json();
}

function rebuildIndex() {
  const files = [...new Set([...desired, ...[...shards.keys()].reverse()])].filter((file) => shards.has(file)).slice(0, 24);
  for (const file of shards.keys()) if (!files.includes(file)) shards.delete(file);
  const unique = [...new Map(files.flatMap((file) => shards.get(file) ?? []).map((candidate) => [candidate.id, candidate])).values()];
  const limited = unique.length <= 2400 ? unique : Array.from({ length: 2400 }, (_, i) => unique[Math.floor(i * unique.length / 2400)]);
  index = limited.length ? buildLiveCandidateIndex(limited) : null;
  poolSize = limited.length;
}

function focusNeighborhood(feature: number[]) {
  if (!manifest) return;
  const yaw = feature[0] * 90;
  const pitch = feature[1] * 90;
  const keys = Object.keys(manifest.cells).map((key) => {
    const [y, p] = key.split(":").map(Number);
    return { key, distance: (y - yaw) ** 2 + (p - pitch) ** 2 * 0.82 };
  }).filter((item) => Number.isFinite(item.distance)).sort((a, b) => a.distance - b.distance).slice(0, 9);
  const next = [...new Set(keys.flatMap(({ key }) => {
    const cell = manifest!.cells[key];
    return cell.shards ?? (cell.shard ? [cell.shard] : []);
  }))].slice(0, 18);
  if (next.join("|") !== desired.join("|")) {
    desired = next;
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
        try {
          const version = encodeURIComponent(manifest?.catalogId ?? "seed");
          const payload = await readJson(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${version}`) as { items?: LiveCatalogEntry[] };
          if (!Array.isArray(payload.items)) throw new Error("Invalid catalog shard");
          const candidates = payload.items.flatMap((entry) => {
            const candidate = liveCandidateFromEntry(entry, file);
            if (!candidate) return [];
            const url = new URL(candidate.url, origin);
            url.searchParams.set("source", "seed");
            candidate.url = url.toString();
            return [candidate];
          });
          shards.delete(file);
          shards.set(file, candidates);
          catalogError = null;
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
  const matrix = result.facialTransformationMatrixes[0]?.data;
  const pose = [0, 0, 0];
  if (matrix && matrix.length >= 11) {
    pose[0] = Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10])) / (Math.PI / 2);
    pose[1] = Math.atan2(matrix[9], matrix[10]) * 1.4 / (Math.PI / 2);
    pose[2] = Math.atan2(matrix[4], matrix[0]) / (Math.PI / 2);
  }
  const pitch = landmarkPitchDegrees(result.faceLandmarks[0], pitchTracker, 1);
  if (pitch !== null) pose[1] = pitch / 90;
  const scores = new Map((result.faceBlendshapes[0]?.categories ?? []).map((category) => [category.categoryName, category.score]));
  const raw = calibrateExpressionFeature(faceFeatureFromScores(pose, scores), expressionTracker);
  const smoothed = raw.map((value, i) => previousFeature ? previousFeature[i] * (i < 3 ? 0.35 : 0.18) + value * (i < 3 ? 0.65 : 0.82) : value);
  previousFeature = smoothed;
  return smoothed;
}

function announceReady() {
  scope.postMessage({ type: "ready", delegate, catalogTotal: manifest?.searchableFaces ?? manifest?.totalFaces ?? 0 });
}

async function initialize(message: Extract<Input, { type: "init" }>) {
  origin = message.origin;
  mirror = message.mirror;
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const [fileset, catalog] = await Promise.all([
    FilesetResolver.forVisionTasks(new URL("/api/mediapipe", origin).href),
    readJson("/api/catalog/manifest?source=seed"),
  ]);
  if (!catalog?.cells || !Number.isFinite(catalog.totalFaces) || catalog.totalFaces <= 0) throw new Error("Invalid catalog manifest");
  if (Number(catalog.stats?.cleanCore?.knownSyntheticFaces ?? 0) !== 0) throw new Error("Real-photo catalog policy violated");
  manifest = catalog;
  const options = {
    runningMode: "VIDEO" as const, numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.45, minTrackingConfidence: 0.45,
  };
  createEngine = (selectedDelegate) => FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: new URL("/api/mediapipe/face_landmarker.task", origin).href, delegate: selectedDelegate } });
  try { landmarker = await createEngine("GPU"); }
  catch { delegate = "CPU"; landmarker = await createEngine("CPU"); }
  announceReady();
}

async function probeCpuIfSlow(currentCanvas: OffscreenCanvas, timestamp: number, gpuResult: FaceLandmarkerResult) {
  if (!createEngine || !shouldProbeCpu(delegate, inferenceSamples, cpuProbed)) return;
  cpuProbed = true;
  let cpu: FaceLandmarker | null = null;
  try {
    cpu = await createEngine("CPU");
    const timings: number[] = [];
    let cpuResult: FaceLandmarkerResult | null = null;
    // First invocation warms the new engine; the two following invocations
    // measure the same real frame, not a blank canvas or synthetic landmarks.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      cpuResult = cpu.detectForVideo(currentCanvas, timestamp + attempt * 0.001);
      if (attempt > 0) timings.push(performance.now() - started);
    }
    if (preferCpu(medianDuration(inferenceSamples.slice(-4)), timings, Boolean(gpuResult.faceLandmarks[0]), Boolean(cpuResult?.faceLandmarks[0]))) {
      const previous = landmarker;
      landmarker = cpu;
      cpu = null;
      delegate = "CPU";
      previous?.close();
      inferenceSamples.length = 0;
      announceReady();
    }
  } catch (error) {
    // A failed optimization must not discard an otherwise functioning engine.
    console.warn("CPU delegate probe failed; retaining the current engine.", error);
  } finally { cpu?.close(); }
}

async function processFrame(message: Extract<Input, { type: "frame" }>) {
  const bitmap = message.bitmap;
  try {
    if (!landmarker) throw new Error("Tracking engine is not ready");
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("OffscreenCanvas is unavailable");
    context.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? width : 0, 0);
    context.drawImage(bitmap, 0, 0, width, height);
    context.resetTransform();
    const started = performance.now();
    const result = landmarker.detectForVideo(canvas, message.capturedAt);
    const inferenceMs = performance.now() - started;
    inferenceSamples.push(inferenceMs);
    if (inferenceSamples.length > 8) inferenceSamples.shift();
    await probeCpuIfSlow(canvas, message.capturedAt, result);
    const landmarks = result.faceLandmarks[0];
    const geometry = landmarks ? faceGeometryFromLandmarks(landmarks, width / height) : null;
    const feature = geometry && result.faceBlendshapes.length ? featureFromResult(result) : [];
    if (feature.length) focusNeighborhood(feature);
    const searchStarted = performance.now();
    const ranked = geometry && feature.length ? rankLiveCandidates(index, { feature, geometry }, { mode: "strict", budget: 128, detailedLimit: 48, currentId: message.currentId, diversityPenalty: 0, holdBias: 0.006 }) : null;
    const output: FrameResult = {
      type: "frame", id: message.id, capturedAt: message.capturedAt,
      face: feature.length > 0, feature,
      ranked: (ranked?.ranked ?? []).slice(0, 12).map(({ candidate, score }) => ({
        id: candidate.id, name: candidate.name, url: candidate.url, score,
        sourceName: candidate.sourceName, sourceUrl: candidate.sourceUrl, creator: candidate.creator,
      })),
      inferenceMs, searchMs: performance.now() - searchStarted,
      candidates: poolSize, shards: shards.size, pendingShards: pending.size, catalogError,
    };
    scope.postMessage(output);
  } finally { bitmap.close(); }
}

scope.onmessage = (event: MessageEvent<Input>) => {
  const failed = (error: unknown) => scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  if (event.data.type === "init") {
    void initialize(event.data).catch(failed);
  } else {
    if (processing) { event.data.bitmap.close(); failed(new Error("Concurrent frame contract violated")); return; }
    processing = true;
    void processFrame(event.data).catch(failed).finally(() => { processing = false; });
  }
};
