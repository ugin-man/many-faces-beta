"use client";
import CallStage, { type StudioClientProps } from "../call-stage";
import { Icon } from "../studio-icons";
import { timeLabel } from "../studio-controls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { catalogFeatureFromResult as featureFromResult } from "../catalog-feature";
import { faceGeometryFromLandmarks, type FaceGeometry, type SequenceFrame } from "../offline-matching";
import { optimizeDistinctProjectionSequence, rankProjectionCandidateModesTwoStage, type ProjectionChoice, type ProjectionError } from "../projection-matching";
import { poseWindowCellKeys, shardFilesForCells, shouldExpandPoseWindow, type ReviewCatalogManifest } from "./review-local-catalog";
import { processingSecondsPerOutputSecond, quantizeReviewTime, reviewItemAtTime } from "./review-timeline";
import { evaluateVerificationGate } from "./verification-gate";
import { emptyReviewPhaseTimings, reviewSequenceFingerprint, roundedReviewPhaseTimings, type ReviewPhaseTimings } from "./review-sequence-metrics";
import { OPERATION_STALL_TIMEOUT_MS, operationIsStalled, preparationFailureReason, progressSignature } from "./runtime-liveness";
import { captureVideoFrameAt } from "./video-frame";
import styles from "../studio.module.css";

const WASM_URL = "/api/mediapipe";
const MODEL_URL = "/api/mediapipe/face_landmarker.task";
const CAPTURE_SECONDS = 5;
const INDEX_BEAM_PER_FRAME = 64;
const SHARD_CONCURRENCY = 4;
const STRICT_SEQUENCE_OPTIONS = {
  allowRepeats: true, cooldown: 12, beamWidth: 24, qualityThreshold: 0.055, residualCoherence: 0.46,
  expressionMotionWeight: 6.2, motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
} as const;

type CatalogEntry = {
  id: string; name?: string; image?: string; pack?: string; offset?: number; length?: number;
  feature: number[]; shape?: string; mesh?: string; projection?: string;
  layout?: [number, number, number, number]; sourceName?: string; creator?: string;
};
type CatalogManifest = ReviewCatalogManifest & {
  schemaVersion: 1 | 2 | 3; catalogId?: string; generatedAt?: string;
  totalFaces: number; searchableFaces?: number; poseStep: number;
  bounds: { yawMin: number; yawMax: number; pitchMin: number; pitchMax: number };
};
type Candidate = {
  id: string; name: string; url: string; feature: number[]; geometry: FaceGeometry;
  sourceName?: string; creator?: string;
};
type ReviewChoice = ProjectionChoice<Candidate>;
type ReviewTimelineItem = { time: number; choice: ReviewChoice };
type Phase = "idle" | "waiting" | "analyzing" | "searching" | "optimizing" | "preloading" | "review" | "error";
type Readiness = "loading" | "ready" | "failed";
type Progress = { done: number; total: number; label: string };
type VerificationReport = {
  sourceName: string; plannedFrames: number; faceFrames: number; sequenceFrames: number;
  selectedImages: number; imageFailures: number; outputChanges: number; uniqueFaces: number;
  processingMs: number; phaseTimingsMs: ReviewPhaseTimings; sequenceIds: string[];
  sequenceFingerprint: string; canvasNonBlank: boolean; faceCoverage: number;
  passed: boolean; reasons: string[];
  frameEvidence: { presentationCallbacks: number; decodedPausedReadbacks: number };
  inputBuild: string;
  matching: { meanYawErrorDegrees: number; meanPitchErrorDegrees: number; meanMouthError: number; meanEyeError: number; meanProjectionError: number };
};
declare global {
  interface Window {
    __MANY_FACES_VERIFY__?: VerificationReport;
    __MANY_FACES_RUNTIME__?: { phase: Phase; label: string; updatedAt: number; stalled: boolean };
  }
}
const cancelled = () => new DOMException("Cancelled", "AbortError");
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function decodeVector(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    if (!bytes.byteLength || bytes.byteLength % 2) return null;
    const values = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    return Float32Array.from(values, value => value / 4096);
  } catch { return null; }
}
function candidateUrl(entry: CatalogEntry) {
  if (entry.image) return `/api/catalog/image?source=seed&id=${encodeURIComponent(entry.image)}`;
  if (!entry.pack || entry.offset == null || entry.length == null) return null;
  return `/api/catalog/image?source=seed&pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
}
function candidateFromEntry(entry: CatalogEntry): Candidate | null {
  const structure = decodeVector(entry.shape), surface = decodeVector(entry.mesh), projection = decodeVector(entry.projection);
  const url = candidateUrl(entry);
  if (!entry.id || !Array.isArray(entry.feature) || entry.feature.length < 22 || !structure || structure.length < 13 || !surface || surface.length < 300 || !projection || projection.length < 936 || !entry.layout || entry.layout.length !== 4 || !url) return null;
  return { id: entry.id, name: entry.name || entry.id, url, feature: entry.feature,
    geometry: { structure, surface, projection, layout: entry.layout }, sourceName: entry.sourceName, creator: entry.creator };
}
function waitForVideoMetadata(video: HTMLVideoElement, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    if (video.readyState >= 1) { resolve(); return; }
    const cleanup = () => { clearTimeout(timer); video.removeEventListener("loadedmetadata", ready); video.removeEventListener("error", failed); signal?.removeEventListener("abort", abort); };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("録画映像を開けませんでした")); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(failed, 15000);
    video.addEventListener("loadedmetadata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function nextTask() { return new Promise<void>(resolve => window.setTimeout(resolve, 0)); }
function nextPaint() { return new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }); }
  finally { clearTimeout(timeout); }
}
function loadCandidateImage(candidate: Candidate) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.decoding = "async";
    let settled = false;
    const timeout = setTimeout(() => finish(false), 20000);
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); image.onload = null; image.onerror = null;
      if (success) resolve(image); else reject(new Error(`IMAGE ${candidate.id}`));
    };
    image.onload = () => finish(true); image.onerror = () => finish(false); image.src = candidate.url;
    void image.decode?.().then(() => finish(true)).catch(() => undefined);
  });
}
function drawContained(canvas: HTMLCanvasElement, image: CanvasImageSource & { width: number; height: number }) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  const width = Math.max(1, image.width), height = Math.max(1, image.height);
  const scale = Math.min(canvas.width / width, canvas.height / height);
  context.fillStyle = "#0a0c10"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2, width * scale, height * scale);
}
function canvasHasVisiblePixels(canvas: HTMLCanvasElement) {
  const scratch = document.createElement("canvas");
  scratch.width = Math.min(canvas.width, 96); scratch.height = Math.min(canvas.height, 64);
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
  const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
  let visible = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 45) visible++;
  return visible > scratch.width * scratch.height * 0.08;
}
function phaseText(phase: Phase) {
  switch (phase) {
    case "waiting": return "解析エンジンを待っています";
    case "analyzing": return "録画をFace Meshで解析中";
    case "searching": return "必要な角度の顔だけ読み込み・照合中";
    case "optimizing": return "再生する顔を選択中";
    case "preloading": return "採用画像を再生前に準備中";
    case "review": return "レビューできます";
    case "error": return "処理を完了できませんでした";
    default: return "動画を選んで検証";
  }
}

export default function VideoReviewClient({ onModeChange }: StudioClientProps = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mirror, setMirror] = useState(false);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const manifestRef = useRef<CatalogManifest | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const shardCacheRef = useRef(new Map<string, Promise<Candidate[]>>());
  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());
  const sequenceRef = useRef<ReviewTimelineItem[]>([]);
  const processingTokenRef = useRef(0);
  const captureAbortRef = useRef<AbortController | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const replayFpsRef = useRef(20);
  const lastOutputIdRef = useRef<string | null>(null);
  const modelStateRef = useRef<Readiness>("loading");
  const manifestStateRef = useRef<Readiness>("loading");
  const lastProgressSignatureRef = useRef("");
  const lastProgressAtRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("idle");
  const [modelState, setModelState] = useState<Readiness>("loading");
  const [manifestState, setManifestState] = useState<Readiness>("loading");
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [sourceName, setSourceName] = useState("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [analysisFps, setAnalysisFps] = useState(20);
  const [replayFps, setReplayFps] = useState(20);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [clipDuration, setClipDuration] = useState(CAPTURE_SECONDS);
  const [plannedFrames, setPlannedFrames] = useState(0);
  const [faceFrames, setFaceFrames] = useState(0);
  const [loadedShards, setLoadedShards] = useState(0);
  const [peakCandidates, setPeakCandidates] = useState(0);
  const [processingMs, setProcessingMs] = useState(0);
  const [outputChanges, setOutputChanges] = useState(0);
  const [uniqueFaces, setUniqueFaces] = useState(0);
  const [imageFailures, setImageFailures] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [currentOutputName, setCurrentOutputName] = useState("—");
  const [currentOutputSource, setCurrentOutputSource] = useState("—");
  const [currentError, setCurrentError] = useState<ProjectionError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsSinceProgress, setSecondsSinceProgress] = useState(0);

  useEffect(() => { replayFpsRef.current = replayFps; }, [replayFps]);
  useEffect(() => { window.__MANY_FACES_VERIFY__ = report ?? undefined; }, [report]);
  useEffect(() => {
    const signature = progressSignature(phase, progress);
    if (signature !== lastProgressSignatureRef.current) { lastProgressSignatureRef.current = signature; lastProgressAtRef.current = Date.now(); }
    window.__MANY_FACES_RUNTIME__ = { phase, label: progress?.label ?? phaseText(phase), updatedAt: lastProgressAtRef.current, stalled: false };
  }, [phase, progress]);
  const busy = !["idle", "review", "error"].includes(phase);
  const readinessLabel = useMemo(() => {
    if (modelState === "failed" || manifestState === "failed") return "準備エラー";
    if (modelState === "ready" && manifestState === "ready") return "解析準備OK";
    return "バックグラウンド準備中";
  }, [manifestState, modelState]);
  useEffect(() => {
    if (!busy) return;
    const tick = () => {
      const now = Date.now();
      setSecondsSinceProgress(Math.floor(Math.max(0, now - lastProgressAtRef.current) / 1000));
      if (!operationIsStalled(true, now, lastProgressAtRef.current)) return;
      processingTokenRef.current += 1;
      captureAbortRef.current?.abort();
      const message = `「${phaseText(phase)}」で${Math.ceil(OPERATION_STALL_TIMEOUT_MS / 1000)}秒以上進捗がありません。処理を停止しました。`;
      setError(message); setProgress(null); setPhase("error");
      window.__MANY_FACES_RUNTIME__ = { phase: "error", label: message, updatedAt: now, stalled: true };
    };
    const first = setTimeout(tick, 0), timer = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [busy, phase]);
  const stopPlayback = useCallback(() => {
    if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
    playbackRafRef.current = null; playbackVideoRef.current?.pause(); setPlaying(false);
  }, []);
  const clearReview = useCallback(() => {
    stopPlayback(); processingTokenRef.current += 1;
    captureAbortRef.current?.abort(); captureAbortRef.current = null;
    shardCacheRef.current.clear(); outputImagesRef.current.clear(); sequenceRef.current = [];
    lastOutputIdRef.current = null; setReport(null); window.__MANY_FACES_VERIFY__ = undefined;
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = null;
    const video = playbackVideoRef.current;
    if (video) { video.removeAttribute("src"); video.load(); }
  }, [stopPlayback]);

  useEffect(() => {
    let disposed = false;
    modelStateRef.current = "loading"; manifestStateRef.current = "loading";
    async function prepareManifest() {
      try {
        const response = await fetchWithTimeout("/api/catalog/manifest?source=seed", { cache: "no-store" }, 15000);
        if (!response.ok) throw new Error(`CATALOG ${response.status}`);
        const manifest = await response.json() as CatalogManifest;
        if (disposed) return;
        manifestRef.current = manifest; manifestStateRef.current = "ready";
        setCatalogTotal(Number(manifest.searchableFaces ?? manifest.totalFaces ?? 0)); setManifestState("ready");
      } catch (caught) { console.error("Review manifest setup failed.", caught); if (!disposed) { manifestStateRef.current = "failed"; setManifestState("failed"); } }
    }
    async function prepareModel() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const options = { runningMode: "IMAGE" as const, numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.45, minTrackingConfidence: 0.45 };
        let landmarker: FaceLandmarker;
        try { landmarker = await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" } }); }
        catch { landmarker = await FaceLandmarker.createFromOptions(fileset, { ...options, baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" } }); }
        if (disposed) { landmarker.close(); return; }
        landmarkerRef.current = landmarker; modelStateRef.current = "ready"; setModelState("ready");
      } catch (caught) { console.error("Review model setup failed.", caught); if (!disposed) { modelStateRef.current = "failed"; setModelState("failed"); } }
    }
    void prepareManifest(); void prepareModel();
    return () => { disposed = true; clearReview(); landmarkerRef.current?.close(); landmarkerRef.current = null; };
  }, [clearReview]);

  const waitUntilPrepared = useCallback(async (token: number) => {
    const startedAt = Date.now();
    while (processingTokenRef.current === token && (!manifestRef.current || !landmarkerRef.current)) {
      const reason = preparationFailureReason(modelStateRef.current, manifestStateRef.current, Date.now() - startedAt);
      if (reason) throw new Error(reason);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) throw cancelled();
  }, []);
  const loadShard = useCallback((file: string, token: number) => {
    const cached = shardCacheRef.current.get(file);
    if (cached) return cached;
    const promise = (async () => {
      const manifest = manifestRef.current;
      if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
      const catalog = manifest.catalogId || manifest.generatedAt || "current";
      const response = await fetchWithTimeout(`/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`, { cache: "force-cache", signal: captureAbortRef.current?.signal }, 20000);
      if (!response.ok) throw new Error(`SHARD ${response.status}`);
      const payload = await response.json() as { items?: CatalogEntry[] };
      if (processingTokenRef.current !== token) throw cancelled();
      const candidates: Candidate[] = [], items = payload.items ?? [];
      for (let index = 0; index < items.length; index++) {
        if (processingTokenRef.current !== token) throw cancelled();
        const candidate = candidateFromEntry(items[index]);
        if (candidate) candidates.push(candidate);
        if (index > 0 && index % 64 === 0) await nextTask();
      }
      return candidates;
    })();
    shardCacheRef.current.set(file, promise);
    return promise;
  }, []);
  const loadCells = useCallback(async (cellKeys: readonly string[], token: number) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    const files = shardFilesForCells(manifest, cellKeys), candidates: Candidate[] = [];
    for (let index = 0; index < files.length; index += SHARD_CONCURRENCY) {
      if (processingTokenRef.current !== token) throw cancelled();
      const payloads = await Promise.all(files.slice(index, index + SHARD_CONCURRENCY).map(file => loadShard(file, token)));
      payloads.forEach(items => candidates.push(...items));
      setLoadedShards(shardCacheRef.current.size); await nextTask();
    }
    return [...new Map(candidates.map(item => [item.id, item])).values()];
  }, [loadShard]);
  const loadFrameCandidates = useCallback(async (frame: SequenceFrame, token: number) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    let candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 12, 15), token);
    if (shouldExpandPoseWindow(candidates.length, 384)) candidates = await loadCells(poseWindowCellKeys(manifest, frame.feature, 18, 21), token);
    setPeakCandidates(current => Math.max(current, candidates.length));
    return candidates;
  }, [loadCells]);
  const drawReviewAt = useCallback((time: number) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const item = reviewItemAtTime(sequenceRef.current, quantizeReviewTime(time, replayFpsRef.current, clipDuration));
    if (!item) return;
    const image = outputImagesRef.current.get(item.choice.candidate.id);
    if (image) drawContained(canvas, image);
    if (lastOutputIdRef.current !== item.choice.candidate.id) {
      lastOutputIdRef.current = item.choice.candidate.id; setCurrentOutputName(item.choice.candidate.name);
      setCurrentOutputSource(item.choice.candidate.sourceName || item.choice.candidate.creator || "—"); setCurrentError(item.choice.error);
    }
  }, [clipDuration]);
  const startPlaybackLoop = useCallback(() => {
    if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
    const tick = () => {
      const video = playbackVideoRef.current;
      if (!video || video.paused || video.ended) { playbackRafRef.current = null; setPlaying(false); return; }
      if (video.currentTime >= clipDuration) { video.currentTime = 0; drawReviewAt(0); setPlaybackTime(0); }
      else { drawReviewAt(video.currentTime); setPlaybackTime(video.currentTime); }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [clipDuration, drawReviewAt]);

  const processRecording = useCallback(async (videoUrl: string, duration: number, inputName: string) => {
    const token = ++processingTokenRef.current;
    captureAbortRef.current?.abort();
    const cancellation = new AbortController(); captureAbortRef.current = cancellation;
    const checkCurrent = () => { if (processingTokenRef.current !== token || cancellation.signal.aborted) throw cancelled(); };
    const started = performance.now(), phaseTimings = emptyReviewPhaseTimings();
    const frameEvidence = { presentationCallbacks: 0, decodedPausedReadbacks: 0 };
    let phaseStarted = started;
    setError(null); setProgress(null); setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0);
    setProcessingMs(0); setOutputChanges(0); setUniqueFaces(0); setImageFailures(0);
    shardCacheRef.current.clear(); outputImagesRef.current.clear(); sequenceRef.current = [];
    lastOutputIdRef.current = null;
    try {
      setPhase("waiting"); await waitUntilPrepared(token);
      phaseTimings.preparation = performance.now() - phaseStarted;
      const video = playbackVideoRef.current, landmarker = landmarkerRef.current;
      if (!video || !landmarker) throw new Error("解析エンジンがありません");
      video.src = videoUrl; video.load();
      await waitForVideoMetadata(video, cancellation.signal); video.pause(); checkCurrent();
      const safeDuration = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(duration, video.duration) : duration;
      setClipDuration(safeDuration);
      const frameCount = Math.max(2, Math.floor(safeDuration * analysisFps));
      setPlannedFrames(frameCount);
      const frames: SequenceFrame[] = [];
      phaseStarted = performance.now(); setPhase("analyzing");
      for (let index = 0; index < frameCount; index++) {
        checkCurrent();
        const time = Math.min(safeDuration - 0.001, index / analysisFps);
        // Capture is atomic: arm before seek, then acquire an actual decoded
        // snapshot. A paused/current frame does not require a future rVFC.
        const captured = await captureVideoFrameAt(video, time, { signal: cancellation.signal });
        const canvas = analysisCanvasRef.current ?? document.createElement("canvas");
        analysisCanvasRef.current = canvas;
        const sourceWidth = captured.bitmap.width, sourceHeight = captured.bitmap.height;
        try {
          checkCurrent();
          if (canvas.width !== sourceWidth || canvas.height !== sourceHeight) { canvas.width = sourceWidth; canvas.height = sourceHeight; }
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("解析用キャンバスを準備できませんでした");
          context.drawImage(captured.bitmap, 0, 0, sourceWidth, sourceHeight);
        } finally { captured.bitmap.close(); }
        if (captured.evidence === "presentation-callback") frameEvidence.presentationCallbacks++;
        else frameEvidence.decodedPausedReadbacks++;
        const result = landmarker.detect(canvas);
        const landmarks = result.faceLandmarks[0];
        if (landmarks && result.faceBlendshapes.length) {
          const geometry = faceGeometryFromLandmarks(landmarks, sourceWidth / sourceHeight);
          if (geometry) frames.push({ time, feature: featureFromResult(result), geometry });
        }
        setProgress({ done: index + 1, total: frameCount, label: `Face Mesh ${index + 1} / ${frameCount}` }); await nextPaint();
      }
      phaseTimings.faceMesh = performance.now() - phaseStarted; setFaceFrames(frames.length);
      if (frames.length < 2) throw new Error("顔を十分に検出できませんでした。明るい場所で撮り直してください");
      phaseStarted = performance.now(); setPhase("searching");
      const beams: Array<Array<{ candidate: Candidate; error: ProjectionError }>> = [];
      for (let index = 0; index < frames.length; index++) {
        checkCurrent();
        const candidates = await loadFrameCandidates(frames[index], token);
        checkCurrent();
        const ranked = rankProjectionCandidateModesTwoStage(frames[index], candidates, INDEX_BEAM_PER_FRAME, Math.min(1024, candidates.length)).strict;
        if (!ranked.length) throw new Error("比較できる顔候補がありませんでした");
        beams.push(ranked);
        setProgress({ done: index + 1, total: frames.length, label: `3D照合 ${index + 1} / ${frames.length} · ${candidates.length.toLocaleString()}候補` }); await nextPaint();
      }
      phaseTimings.candidateSearch = performance.now() - phaseStarted;
      // Final beams retain required candidates; release the rest of the shards.
      shardCacheRef.current.clear();
      phaseStarted = performance.now(); setPhase("optimizing");
      setProgress({ done: 0, total: 1, label: "再生する顔を選択中" }); await nextPaint(); checkCurrent();
      const choices = optimizeDistinctProjectionSequence(frames, beams, STRICT_SEQUENCE_OPTIONS);
      if (!choices.length) throw new Error("連続経路を作れませんでした");
      phaseTimings.pathOptimization = performance.now() - phaseStarted;
      sequenceRef.current = choices.map(choice => ({ time: choice.frame.time, choice }));
      phaseStarted = performance.now(); setPhase("preloading");
      const selected = [...new Map(choices.map(choice => [choice.candidate.id, choice.candidate])).values()];
      let next = 0, completed = 0, failures = 0;
      const preloadWorker = async () => {
        while (processingTokenRef.current === token) {
          const index = next++;
          if (index >= selected.length) return;
          try {
            const image = await loadCandidateImage(selected[index]); checkCurrent();
            outputImagesRef.current.set(selected[index].id, image);
          } catch (caught) { checkCurrent(); void caught; failures++; }
          completed++; setProgress({ done: completed, total: selected.length, label: `採用画像を準備中 ${completed} / ${selected.length}` });
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, selected.length) }, () => preloadWorker())); checkCurrent();
      phaseTimings.imagePreload = performance.now() - phaseStarted; setImageFailures(failures);
      const sequenceIds = choices.map(choice => choice.candidate.id), sequenceFingerprint = reviewSequenceFingerprint(sequenceIds);
      const changes = choices.reduce((count, choice, index) => index > 0 && choices[index - 1].candidate.id !== choice.candidate.id ? count + 1 : count, 0);
      setOutputChanges(changes); setUniqueFaces(selected.length);
      const elapsed = performance.now() - started;
      setProcessingMs(elapsed); setProgress(null); setPlaybackTime(0); setPhase("review"); video.currentTime = 0;
      await nextPaint(); checkCurrent(); drawReviewAt(0); await nextPaint(); checkCurrent();
      const canvas = outputCanvasRef.current, canvasNonBlank = Boolean(canvas && canvasHasVisiblePixels(canvas));
      const gate = evaluateVerificationGate({ plannedFrames: frameCount, faceFrames: frames.length, sequenceFrames: choices.length, selectedImages: selected.length, imageFailures: failures, outputChanges: changes, canvasNonBlank });
      const nextReport: VerificationReport = {
        sourceName: inputName, plannedFrames: frameCount, faceFrames: frames.length,
        sequenceFrames: choices.length, selectedImages: selected.length, imageFailures: failures,
        outputChanges: changes, uniqueFaces: selected.length, processingMs: elapsed,
        phaseTimingsMs: roundedReviewPhaseTimings(phaseTimings), sequenceIds, sequenceFingerprint,
        canvasNonBlank, faceCoverage: gate.faceCoverage, passed: gate.passed, reasons: gate.reasons,
        frameEvidence, inputBuild: "fullscreen-v1",
        matching: {
          meanYawErrorDegrees: choices.reduce((sum, choice) => sum + Math.abs(choice.error.yawDegrees), 0) / choices.length,
          meanPitchErrorDegrees: choices.reduce((sum, choice) => sum + Math.abs(choice.error.pitchDegrees), 0) / choices.length,
          meanMouthError: choices.reduce((sum, choice) => sum + choice.error.mouth, 0) / choices.length,
          meanEyeError: choices.reduce((sum, choice) => sum + choice.error.eyes, 0) / choices.length,
          meanProjectionError: choices.reduce((sum, choice) => sum + choice.error.total, 0) / choices.length,
        },
      };
      setReport(nextReport); window.__MANY_FACES_VERIFY__ = nextReport;
    } catch (caught) {
      if (processingTokenRef.current !== token || (caught instanceof DOMException && caught.name === "AbortError")) return;
      console.error("Fixed-video review failed.", caught);
      setError(caught instanceof Error ? caught.message : "処理に失敗しました"); setPhase("error"); setProgress(null);
    } finally { if (captureAbortRef.current === cancellation) captureAbortRef.current = null; }
  }, [analysisFps, drawReviewAt, loadFrameCandidates, waitUntilPrepared]);

  const verifyVideoFile = useCallback(async (file: File | null) => {
    if (!file || busy) return;
    if (file.size === 0) { setError("空の動画ファイルです。別の動画を選んでください。"); setPhase("error"); return; }
    clearReview(); setError(null); setSourceName(file.name); setPhase("waiting");
    const token = processingTokenRef.current;
    const cancellation = new AbortController(); captureAbortRef.current = cancellation;
    try {
      const url = URL.createObjectURL(file); recordingUrlRef.current = url;
      const video = playbackVideoRef.current;
      if (!video) throw new Error("検証用動画を準備できませんでした");
      video.src = url; video.load(); await waitForVideoMetadata(video, cancellation.signal);
      if (processingTokenRef.current !== token) return;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : CAPTURE_SECONDS;
      setClipDuration(duration); void processRecording(url, duration, file.name);
    } catch (caught) {
      if (processingTokenRef.current !== token) return;
      console.error("Fixed video verification failed.", caught);
      setError(caught instanceof Error ? caught.message : "動画を開けませんでした"); setPhase("error"); setProgress(null);
    }
  }, [busy, clearReview, processRecording]);

  const togglePlayback = useCallback(async () => {
    const video = playbackVideoRef.current;
    if (!video || phase !== "review") return;
    if (video.paused || video.ended) { if (video.ended || video.currentTime >= clipDuration - 0.01) video.currentTime = 0; video.muted = true; await video.play(); setPlaying(true); startPlaybackLoop(); }
    else { stopPlayback(); drawReviewAt(video.currentTime); }
  }, [clipDuration, drawReviewAt, phase, startPlaybackLoop, stopPlayback]);
  const seekReview = useCallback((time: number) => {
    const video = playbackVideoRef.current;
    if (!video || phase !== "review") return;
    stopPlayback(); const target = clamp(time, 0, clipDuration); video.currentTime = target; setPlaybackTime(target); drawReviewAt(target);
  }, [clipDuration, drawReviewAt, phase, stopPlayback]);
  const reset = useCallback(() => {
    clearReview(); setPhase("idle"); setProgress(null); setError(null); setPlaybackTime(0);
    setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0); setProcessingMs(0); setOutputChanges(0);
    setUniqueFaces(0); setImageFailures(0); setCurrentOutputName("—"); setCurrentOutputSource("—");
    setCurrentError(null); setSourceName(""); setReport(null);
  }, [clearReview]);
  const verifySample = async () => {
    if (busy) return;
    clearReview(); setError(null); setPhase("waiting");
    setProgress({ done: 0, total: 1, label: "固定動画を読み込み中" });
    const token = processingTokenRef.current;
    const cancellation = new AbortController(); captureAbortRef.current = cancellation;
    try {
      const response = await fetchWithTimeout("/test-fixtures/reference-face-motion.mp4", { signal: cancellation.signal }, 45000);
      if (!response.ok) throw new Error(`固定動画を読み込めませんでした (${response.status})`);
      const blob = await response.blob();
      if (processingTokenRef.current !== token || cancellation.signal.aborted) return;
      await verifyVideoFile(new File([blob], "reference-face-motion.mp4", { type: "video/mp4" }));
    } catch (caught) {
      if (processingTokenRef.current !== token || cancellation.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "固定動画を開けませんでした"); setPhase("error"); setProgress(null);
    }
  };
  const progressRatio = progress?.total ? clamp(progress.done / progress.total, 0, 1) : 0;
  const perSecond = processingSecondsPerOutputSecond(processingMs, clipDuration);
  const downloadDiagnostics = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "many-faces-video-diagnostics.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const presentationClass = mirror ? styles.mirror : "";
  return <CallStage mode="video" onModeChange={onModeChange} onBack={reset}
    active={busy || phase === "review"} hasOutput={phase === "review"} sourceVisible={Boolean(sourceName) && phase !== "waiting"}
    status={busy ? `${phase === "waiting" ? "準備中" : phase === "analyzing" ? "動画を解析中" : phase === "searching" ? "顔を照合中" : "再生を準備中"}${progress ? ` ${progress.done} / ${progress.total}` : "…"}` : undefined}
    error={error || (modelState === "failed" || manifestState === "failed" ? "準備に失敗しました。ページを再読み込みしてください。" : undefined)}
    progress={busy && progress ? progressRatio : undefined}
    empty={<><Icon name="video" /><span>{busy ? "動画を処理しています" : "動画を選んで検証"}</span></>}
    preview={<video ref={playbackVideoRef} muted playsInline loop preload="auto" className={presentationClass} data-testid="input-video" onEnded={() => { setPlaying(false); setPlaybackTime(clipDuration); }} />}
    timeline={phase === "review" ? <><time>{timeLabel(playbackTime)}</time><input type="range" min="0" max={clipDuration} step={1 / analysisFps} value={playbackTime} aria-label="再生位置" data-testid="review-seek" onChange={event => seekReview(Number(event.target.value))} /><time>{timeLabel(clipDuration)}</time></> : undefined}
    controls={<>
      <input ref={fileInputRef} type="file" accept="video/*" className={styles.hiddenInput} data-testid="video-input" onChange={event => { const file = event.target.files?.[0] ?? null; event.target.value = ""; void verifyVideoFile(file); }} />
      {busy ? <button className={`${styles.tool} ${styles.danger}`} onClick={reset} data-testid="cancel-analysis"><Icon name="stop" /><span>中止</span></button>
        : phase === "review" ? <>
          <button className={styles.tool} onClick={() => seekReview(playbackTime - 1 / analysisFps)} aria-label="1フレーム戻る" data-testid="step-back"><Icon name="previous" /><span>1コマ戻る</span></button>
          <button className={`${styles.tool} ${styles.primary}`} onClick={() => void togglePlayback().catch(() => setError("再生できませんでした。もう一度お試しください。"))} aria-label={playing ? "一時停止" : "再生"} data-testid="play-pause"><Icon name={playing ? "pause" : "play"} /><span>{playing ? "一時停止" : "再生"}</span></button>
          <button className={styles.tool} onClick={() => seekReview(playbackTime + 1 / analysisFps)} aria-label="1フレーム進む" data-testid="step-forward"><Icon name="next" /><span>1コマ進む</span></button>
          <button className={styles.tool} onClick={() => fileInputRef.current?.click()}><Icon name="upload" /><span>動画を変更</span></button>
        </> : <>
          <button className={`${styles.tool} ${styles.primary}`} onClick={() => fileInputRef.current?.click()}><Icon name="upload" /><span>動画を選ぶ</span></button>
          <button className={styles.tool} onClick={() => void verifySample()} data-testid="sample-video"><Icon name="sample" /><span>固定動画</span></button>
        </>}
    </>}
    settings={<>
      <label className={styles.settingRow}><span>解析密度</span><select aria-label="解析密度" data-testid="analysis-fps" value={analysisFps} disabled={busy} onChange={event => { const value = Number(event.target.value); setAnalysisFps(value); setReplayFps(value); }}><option value={12}>12 fps</option><option value={20}>20 fps</option><option value={30}>30 fps</option></select></label>
      <label className={styles.settingRow}><span>鏡表示</span><input type="checkbox" checked={mirror} data-testid="mirror-toggle" onChange={event => setMirror(event.target.checked)} /></label>
    </>}
    details={<>
      <p>{currentOutputName}<br />{currentOutputSource}</p>
      <p>{sourceName || "動画未選択"} ／ {clipDuration.toFixed(1)} 秒<br />{readinessLabel} ／ カタログ {catalogTotal.toLocaleString()}枚</p>
      <p>顔検出 {faceFrames} / {plannedFrames} ／ 出力切替 {outputChanges} ／ 採用 {uniqueFaces} 枚<br />画像失敗 {imageFailures} ／ 読み込み {loadedShards} ／ 最大候補 {peakCandidates}</p>
      <p>処理 {(processingMs / 1000).toFixed(1)} 秒 ／ 出力1秒あたり {perSecond.toFixed(1)} 秒<br />最終進捗から {secondsSinceProgress} 秒</p>
      {currentError && <p>投影誤差 {currentError.total.toFixed(4)}</p>}
      {report && <><p>{report.passed ? "処理完了" : report.reasons.join("・")}</p><button onClick={downloadDiagnostics}>診断データを保存</button></>}
    </>}>
    <canvas ref={outputCanvasRef} width={768} height={768} className={presentationClass} data-testid="output-canvas" aria-label="Many Facesの出力" />
  </CallStage>;
}
