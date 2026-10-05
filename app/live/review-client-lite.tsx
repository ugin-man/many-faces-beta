"use client";
import RuntimeCheck from "../runtime-check";
import CallStage, { type StudioClientProps } from "../call-stage";
import { Icon } from "../studio-icons";
import { timeLabel } from "../studio-controls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { catalogFeatureFromResult as featureFromResult } from "../catalog-feature";
import { faceGeometryFromLandmarks, type FaceGeometry, type SequenceFrame } from "../offline-matching";
import { drawFacePresentation } from "../face-presentation";
import type { ProjectionChoice, ProjectionError } from "../projection-matching";
import { searchReviewFrames } from "./review-search";
import { createStableLandmarker } from "./stable-landmarker";
import { runtimeIdentity } from "../runtime-identity";
import { readAssetBytes } from "./asset-reader";
import { type ReviewCatalogManifest } from "./review-local-catalog";
import { processingSecondsPerOutputSecond, quantizeReviewTime, reviewItemAtTime } from "./review-timeline";
import { evaluateVerificationGate } from "./verification-gate";
import { emptyReviewPhaseTimings, reviewSequenceFingerprint, roundedReviewPhaseTimings, type ReviewPhaseTimings } from "./review-sequence-metrics";
import { OPERATION_STALL_TIMEOUT_MS, operationIsStalled, preparationFailureReason, progressSignature } from "./runtime-liveness";
import { captureVideoFrameAt } from "./video-frame";
import styles from "../studio.module.css";

const CAPTURE_SECONDS = 5;

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
  build: string;
  searchTraffic: { bytes: number; files: number; decoded: number };
  matching: { meanYawErrorDegrees: number; meanPitchErrorDegrees: number; meanMouthError: number; meanEyeError: number; meanProjectionError: number };
};
declare global {
  interface Window {
    __MANY_FACES_VERIFY__?: VerificationReport;
    __MANY_FACES_RUNTIME__?: { phase: Phase; label: string; updatedAt: number; stalled: boolean; version?: string; build?: string; revision?: string; receivedBytes?: number; loadedFiles?: number; decodedCandidates?: number; completedFrames?: number };
  }
}
const cancelled = () => new DOMException("Cancelled", "AbortError");
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
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
  const [faceTracking, setFaceTracking] = useState(true);
  const [faceOnly, setFaceOnly] = useState(false);
  const [sourceAspectRatio, setSourceAspectRatio] = useState(1);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const manifestRef = useRef<CatalogManifest | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
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
  const searchTrafficRef = useRef({ bytes: 0, files: 0, decoded: 0 });
  const modelProgressAtRef = useRef(0);

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
    window.__MANY_FACES_RUNTIME__ = { ...window.__MANY_FACES_RUNTIME__, ...runtimeIdentity, phase, label: progress?.label ?? phaseText(phase), updatedAt: lastProgressAtRef.current, stalled: false };
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
    outputImagesRef.current.clear(); sequenceRef.current = [];
    lastOutputIdRef.current = null; setReport(null); window.__MANY_FACES_VERIFY__ = undefined;
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = null;
    const video = playbackVideoRef.current;
    if (video) { video.removeAttribute("src"); video.load(); }
  }, [stopPlayback]);

  useEffect(() => {
    let disposed = false;
    const preparationAbort = new AbortController();
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
        const landmarker = await createStableLandmarker("IMAGE", event => {
          if (disposed) return;
          modelProgressAtRef.current = Date.now();
          lastProgressAtRef.current = Date.now();
          const stage = event.stage.includes("download") ? "解析エンジンを受信中" : "解析エンジンを準備中";
          if (window.__MANY_FACES_RUNTIME__?.phase === "waiting") setProgress({ done: 0, total: 0, label: `${stage} ${(event.bytes / 1048576).toFixed(1)} MB` });
        }, preparationAbort.signal);
        if (disposed) { landmarker.close(); return; }
        landmarkerRef.current = landmarker; modelStateRef.current = "ready"; setModelState("ready");
      } catch (caught) { console.error("Review model setup failed.", caught); if (!disposed) { modelStateRef.current = "failed"; setModelState("failed"); } }
    }
    void prepareManifest(); void prepareModel();
    return () => { disposed = true; preparationAbort.abort(); clearReview(); landmarkerRef.current?.close(); landmarkerRef.current = null; };
  }, [clearReview]);

  const waitUntilPrepared = useCallback(async (token: number) => {
    const startedAt = Date.now();
    while (processingTokenRef.current === token && (!manifestRef.current || !landmarkerRef.current)) {
      const reason = preparationFailureReason(modelStateRef.current, manifestStateRef.current, Date.now() - Math.max(startedAt, modelProgressAtRef.current));
      if (reason) throw new Error(reason);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) throw cancelled();
  }, []);
  const drawReviewAt = useCallback((time: number) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const item = reviewItemAtTime(sequenceRef.current, quantizeReviewTime(time, replayFpsRef.current, clipDuration));
    if (!item) return;
    const image = outputImagesRef.current.get(item.choice.candidate.id);
    if (image) drawFacePresentation(canvas, image, item.choice, { sourceAspectRatio, trackFace: faceTracking, faceOnly, background: "#0a0c10" });
    if (lastOutputIdRef.current !== item.choice.candidate.id) {
      lastOutputIdRef.current = item.choice.candidate.id; setCurrentOutputName(item.choice.candidate.name);
      setCurrentOutputSource(item.choice.candidate.sourceName || item.choice.candidate.creator || "—"); setCurrentError(item.choice.error);
    }
  }, [clipDuration, faceOnly, faceTracking, sourceAspectRatio]);
  useEffect(() => {\n    if (phase === "review") drawReviewAt(playbackTime);\n  }, [drawReviewAt, phase, playbackTime]);\n\n  const startPlaybackLoop = useCallback(() => {
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
    lastProgressAtRef.current = Date.now(); searchTrafficRef.current = { bytes: 0, files: 0, decoded: 0 };
    setError(null); setProgress(null); setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0);
    setProcessingMs(0); setOutputChanges(0); setUniqueFaces(0); setImageFailures(0);
    outputImagesRef.current.clear(); sequenceRef.current = [];
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
      setSourceAspectRatio(video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 1);
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
      setPhase("searching");
      const searched = await searchReviewFrames(frames, cancellation.signal, event => {
        if (processingTokenRef.current !== token || cancellation.signal.aborted) return;
        // This is actual received bytes / decoded entries / completed frames,
        // not a timer heartbeat or a changing spinner label.
        lastProgressAtRef.current = Date.now();
        searchTrafficRef.current = { bytes: event.bytes, files: event.files, decoded: event.decoded };
        setPhase(event.phase); setLoadedShards(event.files); setPeakCandidates(event.peakCandidates);
        setProgress({ done: event.completed, total: event.total,
          label: `${event.label} · ${event.files}ファイル / ${(event.bytes / 1048576).toFixed(1)} MB · ${event.completed}/${event.total}コマ` });
        window.__MANY_FACES_RUNTIME__ = { phase: event.phase, label: event.label, updatedAt: lastProgressAtRef.current, stalled: false,
          ...runtimeIdentity, receivedBytes: event.bytes, loadedFiles: event.files, decodedCandidates: event.decoded, completedFrames: event.completed };
      });
      checkCurrent();
      const choices = searched.choices;
      phaseTimings.candidateSearch = searched.candidateSearchMs;
      phaseTimings.pathOptimization = searched.pathOptimizationMs;
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
        frameEvidence, inputBuild: runtimeIdentity.version, build: runtimeIdentity.build, searchTraffic: { ...searchTrafficRef.current },
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
  }, [analysisFps, drawReviewAt, waitUntilPrepared]);

  const verifyVideoFile = useCallback(async (file: File | null) => {
    if (!file || busy) return;
    if (file.size === 0) { setError("空の動画ファイルです。別の動画を選んでください。"); setPhase("error"); return; }
    clearReview(); setError(null); setSourceName(file.name); setPhase("waiting"); lastProgressAtRef.current = Date.now();
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
    setCurrentError(null); setSourceName(""); setReport(null); searchTrafficRef.current = { bytes: 0, files: 0, decoded: 0 };
    setSourceAspectRatio(1);
  }, [clearReview]);
  const verifySample = async () => {
    if (busy) return;
    clearReview(); setError(null); setPhase("waiting");
    setProgress({ done: 0, total: 1, label: "固定動画を読み込み中" });
    const token = processingTokenRef.current;
    const cancellation = new AbortController(); captureAbortRef.current = cancellation;
    try {
      const bytes = await readAssetBytes("/test-fixtures/reference-face-motion.mp4", { signal: cancellation.signal, maxBytes: 256 * 1024 * 1024, onBytes: received => {
        if (processingTokenRef.current !== token) return;
        lastProgressAtRef.current = Date.now();
        setProgress({ done: 0, total: 0, label: `固定動画を受信中 ${(received / 1048576).toFixed(1)} MB` });
      } });
      const blob = new Blob([bytes], { type: "video/mp4" });
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
    status={busy ? progress?.label ?? phaseText(phase) : undefined}
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
      <label className={styles.settingRow}><span>顔位置追従</span><input type="checkbox" checked={faceTracking} data-testid="face-tracking-toggle" onChange={event => setFaceTracking(event.target.checked)} /></label>
      <label className={styles.settingRow}><span>表示モード</span><select aria-label="表示モード" data-testid="face-display-mode" value={faceOnly ? "face" : "normal"} onChange={event => setFaceOnly(event.target.value === "face")}><option value="normal">通常</option><option value="face">顔だけ</option></select></label>
    </>}
    details={<>
      <p>{currentOutputName}<br />{currentOutputSource}</p>
      <RuntimeCheck />
      <p>{sourceName || "動画未選択"} ／ {clipDuration.toFixed(1)} 秒<br />{readinessLabel} ／ カタログ {catalogTotal.toLocaleString()}枚</p>
      <p>顔検出 {faceFrames} / {plannedFrames} ／ 出力切替 {outputChanges} ／ 採用 {uniqueFaces} 枚<br />画像失敗 {imageFailures} ／ 読み込み {loadedShards} ／ 最大候補 {peakCandidates}</p>
      <p>処理 {(processingMs / 1000).toFixed(1)} 秒 ／ 出力1秒あたり {perSecond.toFixed(1)} 秒<br />最終進捗から {secondsSinceProgress} 秒</p>
      {currentError && <p>投影誤差 {currentError.total.toFixed(4)}</p>}
      {report && <><p>{report.passed ? "処理完了" : report.reasons.join("・")}</p><button onClick={downloadDiagnostics}>診断データを保存</button></>}
    </>}>
    <canvas ref={outputCanvasRef} width={768} height={768} className={presentationClass} data-testid="output-canvas" aria-label="Many Facesの出力" />
  </CallStage>;
}
