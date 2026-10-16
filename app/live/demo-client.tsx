"use client";
import { useLanguage } from "../language";
import RuntimeCheck from "../runtime-check";
import CallStage, { type StudioClientProps } from "../call-stage";
import { Icon } from "../studio-icons";
import { timeLabel } from "../studio-controls";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { catalogFeatureFromResult as featureFromResult } from "../catalog-feature";
import { faceGeometryFromLandmarks, type FaceGeometry, type SequenceFrame } from "../offline-matching";
import { drawFacePresentation } from "../face-presentation";
import { drawDemoFaceComposite, resetDemoFaceComposite } from "../demo-face-composite";
import type { ProjectionChoice, ProjectionError } from "../projection-matching";
import { searchReviewFrames } from "./review-search";
import { createStableLandmarker } from "./stable-landmarker";
import { runtimeIdentity } from "../runtime-identity";
import { type ReviewCatalogManifest } from "./review-local-catalog";
import { processingSecondsPerOutputSecond, quantizeReviewTime, reviewItemAtTime } from "./review-timeline";
import { evaluateVerificationGate } from "./verification-gate";
import { emptyReviewPhaseTimings, reviewSequenceFingerprint, roundedReviewPhaseTimings, type ReviewPhaseTimings } from "./review-sequence-metrics";
import { OPERATION_STALL_TIMEOUT_MS, operationIsStalled, preparationFailureReason, progressSignature } from "./runtime-liveness";
import { captureVideoFrameAt } from "./video-frame";
import { motionChoiceAtTime } from "./video-motion";
import { filterVideoProfileIslands, uncertainProfileAtTime, type UncertainProfileInterval } from "./video-pose-continuity";
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
  poseContinuity?: { rejectedFrames: number; intervals: UncertainProfileInterval[] };
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
    default: return "動画を選んで顔を合成";
  }
}

export default function DemoVideoClient({ onModeChange, onOpenSample }: StudioClientProps = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useLanguage();
  const [mirror, setMirror] = useState(false);
  const [engineRequested, setEngineRequested] = useState(false);
  const [faceTracking, setFaceTracking] = useState(true);
  const [faceOnly, setFaceOnly] = useState(false);
  const [demoComposite, setDemoComposite] = useState(true);
  const [recordingDemo, setRecordingDemo] = useState(false);
  const demoRecordingRef = useRef<{ stop: () => void } | null>(null);
  const [sourceAspectRatio, setSourceAspectRatio] = useState(1);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const manifestRef = useRef<CatalogManifest | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());
  const sequenceRef = useRef<ReviewTimelineItem[]>([]);
  const uncertainProfilesRef = useRef<Array<UncertainProfileInterval & { protectedFrame?: HTMLCanvasElement }>>([]);
  const processingTokenRef = useRef(0);
  const captureAbortRef = useRef<AbortController | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const replayFpsRef = useRef(30);
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
  const [analysisFps, setAnalysisFps] = useState(30);
  const [replayFps, setReplayFps] = useState(30);
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
    outputImagesRef.current.clear(); sequenceRef.current = []; uncertainProfilesRef.current = [];
    resetDemoFaceComposite(outputCanvasRef.current);
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
    void prepareManifest();
    return () => { disposed = true; preparationAbort.abort(); clearReview(); };
  }, [clearReview]);

  useEffect(() => {
    if (!engineRequested) return;
    let disposed = false;
    const preparationAbort = new AbortController();
    modelStateRef.current = "loading";
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
    void prepareModel();
    return () => { disposed = true; preparationAbort.abort(); landmarkerRef.current?.close(); landmarkerRef.current = null; };
  }, [engineRequested]);

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
    if (demoComposite) {
      const uncertain = uncertainProfileAtTime(uncertainProfilesRef.current, time);
      const motion = uncertain ? null : motionChoiceAtTime(sequenceRef.current, time, replayFpsRef.current);
      const image = motion ? outputImagesRef.current.get(motion.candidate.id) : undefined;
      drawDemoFaceComposite(canvas, playbackVideoRef.current, image, motion,
        { time, fps: replayFpsRef.current, sourceAspectRatio, mirror, protectedFrame: uncertain?.protectedFrame });
    } else if (item) {
      const image = outputImagesRef.current.get(item.choice.candidate.id);
      if (image) drawFacePresentation(canvas, image, item.choice, { sourceAspectRatio, trackFace: faceTracking, faceOnly, background: "#0a0c10" });
    }
    if (item && lastOutputIdRef.current !== item.choice.candidate.id) {
      lastOutputIdRef.current = item.choice.candidate.id; setCurrentOutputName(item.choice.candidate.name);
      setCurrentOutputSource(item.choice.candidate.sourceName || item.choice.candidate.creator || "—"); setCurrentError(item.choice.error);
    }
  }, [clipDuration, demoComposite, faceOnly, faceTracking, mirror, sourceAspectRatio]);
  const drawReviewAtRef = useRef(drawReviewAt);
  // Processing spans renders that commit video metadata and display controls.
  // Its completion must use the latest committed draw, even before a seek.
  useLayoutEffect(() => { drawReviewAtRef.current = drawReviewAt; }, [drawReviewAt]);
  useEffect(() => {
    if (phase === "review") drawReviewAt(playbackTime);
  }, [drawReviewAt, phase, playbackTime]);

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
    lastProgressAtRef.current = Date.now(); searchTrafficRef.current = { bytes: 0, files: 0, decoded: 0 };
    setError(null); setProgress(null); setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0);
    setProcessingMs(0); setOutputChanges(0); setUniqueFaces(0); setImageFailures(0);
    outputImagesRef.current.clear(); sequenceRef.current = []; uncertainProfilesRef.current = [];
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
      const detectedFrames: SequenceFrame[] = [];
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
          if (geometry) detectedFrames.push({ time, feature: featureFromResult(result), geometry, compensateRoll: true });
        }
        setProgress({ done: index + 1, total: frameCount, label: `Face Mesh ${index + 1} / ${frameCount}` }); await nextPaint();
      }
      const { frames, intervals } = filterVideoProfileIslands(detectedFrames, analysisFps);
      uncertainProfilesRef.current = intervals;
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
      // Build a complete protected neighbour for each uncertain interval. A seek
      // straight into the gap must show that neighbour, not whichever unrelated
      // frame happened to be displayed before the seek.
      const preparedIntervals: Array<UncertainProfileInterval & { protectedFrame?: HTMLCanvasElement }> = [];
      for (const interval of intervals) {
        const anchor = reviewItemAtTime(sequenceRef.current, interval.anchorTime);
        const image = anchor && outputImagesRef.current.get(anchor.choice.candidate.id);
        if (!anchor || !image) { preparedIntervals.push(interval); continue; }
        const captured = await captureVideoFrameAt(video, interval.anchorTime, { signal: cancellation.signal });
        captured.bitmap.close(); checkCurrent();
        const protectedFrame = document.createElement("canvas");
        protectedFrame.width = outputCanvasRef.current?.width ?? 768;
        protectedFrame.height = outputCanvasRef.current?.height ?? 768;
        const safe = drawDemoFaceComposite(protectedFrame, video, image, anchor.choice,
          { time: interval.anchorTime, fps: analysisFps, sourceAspectRatio: video.videoWidth / video.videoHeight });
        preparedIntervals.push({ ...interval, protectedFrame: safe ? protectedFrame : undefined });
      }
      uncertainProfilesRef.current = preparedIntervals;
      phaseTimings.imagePreload = performance.now() - phaseStarted; setImageFailures(failures);
      const sequenceIds = choices.map(choice => choice.candidate.id), sequenceFingerprint = reviewSequenceFingerprint(sequenceIds);
      const changes = choices.reduce((count, choice, index) => index > 0 && choices[index - 1].candidate.id !== choice.candidate.id ? count + 1 : count, 0);
      setOutputChanges(changes); setUniqueFaces(selected.length);
      const elapsed = performance.now() - started;
      setProcessingMs(elapsed); setProgress(null); setPlaybackTime(0); setPhase("review"); video.currentTime = 0;
      await nextPaint(); checkCurrent(); drawReviewAtRef.current(0); await nextPaint(); checkCurrent();
      const canvas = outputCanvasRef.current, canvasNonBlank = Boolean(canvas && canvasHasVisiblePixels(canvas));
      const gate = evaluateVerificationGate({ plannedFrames: frameCount, faceFrames: frames.length, sequenceFrames: choices.length, selectedImages: selected.length, imageFailures: failures, outputChanges: changes, canvasNonBlank });
      const nextReport: VerificationReport = {
        sourceName: inputName, plannedFrames: frameCount, faceFrames: frames.length,
        sequenceFrames: choices.length, selectedImages: selected.length, imageFailures: failures,
        outputChanges: changes, uniqueFaces: selected.length, processingMs: elapsed,
        phaseTimingsMs: roundedReviewPhaseTimings(phaseTimings), sequenceIds, sequenceFingerprint,
        canvasNonBlank, faceCoverage: gate.faceCoverage, passed: gate.passed, reasons: gate.reasons,
        frameEvidence, inputBuild: runtimeIdentity.version, build: runtimeIdentity.build, searchTraffic: { ...searchTrafficRef.current },
        poseContinuity: { rejectedFrames: detectedFrames.length - frames.length,
          intervals: intervals.map(({ start, end, anchorTime, rejectedTimes }) => ({ start, end, anchorTime, rejectedTimes })) },
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
  }, [analysisFps, waitUntilPrepared]);

  const verifyVideoFile = useCallback(async (file: File | null) => {
    if (!file || busy) return;
    if (file.size === 0) { setError("空の動画ファイルです。別の動画を選んでください。"); setPhase("error"); return; }
    setEngineRequested(true);
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
    demoRecordingRef.current?.stop();
    clearReview(); setPhase("idle"); setProgress(null); setError(null); setPlaybackTime(0);
    setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0); setProcessingMs(0); setOutputChanges(0);
    setUniqueFaces(0); setImageFailures(0); setCurrentOutputName("—"); setCurrentOutputSource("—");
    setCurrentError(null); setSourceName(""); setReport(null); searchTrafficRef.current = { bytes: 0, files: 0, decoded: 0 };
    setSourceAspectRatio(1);
  }, [clearReview]);
  const saveDemoImage = () => {
    if (phase !== "review" || !demoComposite) return;
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    drawReviewAt(playbackVideoRef.current?.currentTime ?? playbackTime);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "many-faces-composite.png"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const reportDemoPhoto = () => {
    if (phase !== "review") return;
    const time = playbackVideoRef.current?.currentTime ?? playbackTime;
    const item = reviewItemAtTime(sequenceRef.current, quantizeReviewTime(time, replayFpsRef.current, clipDuration));
    if (!item) return;
    const uncertain = uncertainProfileAtTime(uncertainProfilesRef.current, time);
    const payload = {
      schemaVersion: 1, kind: "many-faces-photo-quality-report",
      imageId: item.choice.candidate.id,
      imageName: item.choice.candidate.name,
      sourceName: item.choice.candidate.sourceName || item.choice.candidate.creator || "",
      storedYawDegrees: Number((item.choice.candidate.feature[0] * 90).toFixed(2)),
      frameYawDegrees: Number((item.choice.frame.feature[0] * 90).toFixed(2)),
      videoTimeSeconds: Number(time.toFixed(3)),
      displaySourceTimeSeconds: Number((uncertain?.anchorTime ?? item.choice.frame.time).toFixed(3)),
      protectedHold: Boolean(uncertain),
      reportReason: "wrong-facing-photo",
      // No raw video, source face pixels or personal data are included.
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = "many-faces-wrong-photo.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const recordDemoVideo = async () => {
    const canvas = outputCanvasRef.current;
    const video = playbackVideoRef.current;
    if (!demoComposite || phase !== "review" || !canvas || !video || recordingDemo) return;
    if (!canvas.captureStream || typeof MediaRecorder === "undefined") {
      setError("このブラウザでは動画書き出しに対応していません。画像保存をお試しください。"); return;
    }
    const mimeType = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { setError("このブラウザでは動画書き出し形式を利用できません。"); return; }
    stopPlayback();
    const oldLoop = video.loop;
    video.loop = false;
    setRecordingDemo(true);
    setError(null);
    let raf = 0;
    let recorder: MediaRecorder | null = null;
    let completed = false;
    let exportSucceeded = false;
    const stop = () => {
      if (completed) return;
      completed = true;
      cancelAnimationFrame(raf);
      video.pause();
      video.loop = oldLoop;
      if (recorder?.state === "recording") recorder.stop();
      setRecordingDemo(false);
      demoRecordingRef.current = null;
    };
    demoRecordingRef.current = { stop };
    try {
      video.currentTime = 0;
      if (video.seeking) await new Promise<void>(resolve => {
        video.addEventListener("seeked", () => resolve(), { once: true });
      });
      if (completed) return;
      drawReviewAtRef.current(0);
      const stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { setError("合成動画の保存に失敗しました。"); stop(); };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (!exportSucceeded || !chunks.length) return;
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = mimeType.startsWith("video/mp4") ? "many-faces-composite.mp4" : "many-faces-composite.webm";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      recorder.start(250);
      await video.play();
      const tick = () => {
        if (completed) return;
        const time = Math.min(video.currentTime, clipDuration);
        drawReviewAtRef.current(time);
        setPlaybackTime(time);
        if (video.ended || time >= clipDuration - 0.015) { exportSucceeded = true; stop(); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      setError("合成動画を保存できませんでした。");
      stop();
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
  const presentationClass = mirror && !demoComposite ? styles.mirror : "";
  return <CallStage mode="video" onModeChange={onModeChange} onBack={reset} onOpenSample={busy ? undefined : onOpenSample}
    active={busy || phase === "review"} hasOutput={phase === "review"} sourceVisible={Boolean(sourceName) && phase !== "waiting" && !demoComposite}
    status={busy ? progress?.label ?? phaseText(phase) : undefined}
    error={error || (modelState === "failed" || manifestState === "failed" ? t("準備に失敗しました。ページを再読み込みしてください。") : undefined)}
    progress={busy && progress ? progressRatio : undefined}
    empty={<><Icon name="video" /><span>{busy ? t("動画を処理しています") : t("動画を選んで顔を合成")}</span></>}
    preview={<video ref={playbackVideoRef} muted playsInline loop preload="auto" className={presentationClass} data-testid="input-video" onSeeked={() => { if (demoComposite && phase === "review") drawReviewAt(playbackVideoRef.current?.currentTime ?? 0); }} onEnded={() => { setPlaying(false); setPlaybackTime(clipDuration); }} />}
    timeline={phase === "review" ? <><time>{timeLabel(playbackTime)}</time><input type="range" min="0" max={clipDuration} step={1 / analysisFps} value={playbackTime} aria-label={t("再生位置")} data-testid="review-seek" disabled={recordingDemo} onChange={event => seekReview(Number(event.target.value))} /><time>{timeLabel(clipDuration)}</time></> : undefined}
    controls={<>
      <input ref={fileInputRef} type="file" accept="video/*" className={styles.hiddenInput} data-testid="video-input" onChange={event => { const file = event.target.files?.[0] ?? null; event.target.value = ""; void verifyVideoFile(file); }} />
      {busy ? <button className={`${styles.tool} ${styles.danger}`} onClick={reset} data-testid="cancel-analysis"><Icon name="stop" /><span>{t("中止")}</span></button>
        : phase === "review" ? <>
          {demoComposite && <button className={styles.tool} onClick={saveDemoImage} disabled={recordingDemo} data-testid="demo-save-image"><Icon name="sample" /><span>{t("画像保存")}</span></button>}
          {demoComposite && <button className={styles.tool} onClick={reportDemoPhoto} disabled={recordingDemo} data-testid="demo-report-photo"><Icon name="info" /><span>{t("誤画像を報告")}</span></button>}
          {demoComposite && <button className={styles.tool} onClick={() => void recordDemoVideo()} disabled={recordingDemo} data-testid="demo-export-video"><Icon name="video" /><span>{recordingDemo ? t("保存中") : t("合成動画保存")}</span></button>}
          <button className={styles.tool} onClick={() => seekReview(playbackTime - 1 / analysisFps)} disabled={recordingDemo} aria-label={t("1フレーム戻る")} data-testid="step-back"><Icon name="previous" /><span>{t("1コマ戻る")}</span></button>
          <button className={`${styles.tool} ${styles.primary}`} onClick={() => void togglePlayback().catch(() => setError("再生できませんでした。もう一度お試しください。"))} aria-label={playing ? t("一時停止") : t("再生")} data-testid="play-pause" disabled={recordingDemo}><Icon name={playing ? "pause" : "play"} /><span>{playing ? t("一時停止") : t("再生")}</span></button>
          <button className={styles.tool} onClick={() => seekReview(playbackTime + 1 / analysisFps)} aria-label={t("1フレーム進む")} data-testid="step-forward" disabled={recordingDemo}><Icon name="next" /><span>{t("1コマ進む")}</span></button>
          <button className={styles.tool} disabled={recordingDemo} onClick={() => fileInputRef.current?.click()}><Icon name="upload" /><span>{t("動画を変更")}</span></button>
        </> : <>
          <button className={`${styles.tool} ${styles.primary}`} onClick={() => fileInputRef.current?.click()}><Icon name="upload" /><span>{t("動画を選ぶ")}</span></button>
        </>}
    </>}
    settings={<>
      <label className={styles.settingRow}><span>{t("解析密度")}</span><select aria-label={t("解析密度")} data-testid="analysis-fps" value={analysisFps} disabled={busy} onChange={event => { const value = Number(event.target.value); setAnalysisFps(value); setReplayFps(value); }}><option value={12}>12 fps</option><option value={20}>20 fps</option><option value={30}>30 fps</option></select></label>
      <label className={styles.settingRow}><span>{t("鏡表示")}</span><input type="checkbox" checked={mirror} disabled={recordingDemo} data-testid="mirror-toggle" onChange={event => setMirror(event.target.checked)} /></label>
      <label className={styles.settingRow}><span>{t("顔位置追従")}</span><input type="checkbox" checked={faceTracking} data-testid="face-tracking-toggle" onChange={event => setFaceTracking(event.target.checked)} /></label>
      <label className={styles.settingRow}><span>{t("表示モード")}</span><select aria-label={t("表示モード")} data-testid="face-display-mode" value={demoComposite ? "demo" : faceOnly ? "face" : "normal"} onChange={event => { setDemoComposite(event.target.value === "demo"); setFaceOnly(event.target.value === "face"); }} disabled={recordingDemo}><option value="demo">{t("動画に顔を合成")}</option><option value="face">{t("顔写真のみ（切り抜き）")}</option><option value="normal">{t("顔写真のみ（全体）")}</option></select></label>
      {demoComposite && <p>{t("背景と身体を残し、顔をMany Facesの写真に差し替えます。保存する動画は音声なしです。")}</p>}
    </>}
    details={<>
      {demoComposite && <p>{t("短く動きが小さい検出抜けは補間します。長い検出抜けや画像の読み込み失敗では、直前の合成済み画面を保持します。最初の合成前は「顔を保護しています」と表示します。公開前に元の顔が映っていないか全編確認してください。")}</p>}
      <p>{currentOutputName}<br />{currentOutputSource}</p>
      <RuntimeCheck />
      <p>{sourceName || t("動画未選択")} ／ {clipDuration.toFixed(1)}{t(" 秒")}<br />{t(readinessLabel)}{t(" ／ カタログ ")}{catalogTotal.toLocaleString()}{t("枚")}</p>
      <p>{t("顔検出 ")}{faceFrames} / {plannedFrames}{t(" ／ 出力切替 ")}{outputChanges}{t(" ／ 採用 ")}{uniqueFaces}{t(" 枚")}<br />{t("画像失敗 ")}{imageFailures}{t(" ／ 読み込み ")}{loadedShards}{t(" ／ 最大候補 ")}{peakCandidates}</p>
      <p>{t("処理 ")}{(processingMs / 1000).toFixed(1)}{t(" 秒 ／ 出力1秒あたり ")}{perSecond.toFixed(1)}{t(" 秒")}<br />{t("最終進捗から ")}{secondsSinceProgress}{t(" 秒")}</p>
      {currentError && <p>{t("投影誤差 ")}{currentError.total.toFixed(4)}</p>}
      {report && <><p>{report.passed ? t("処理完了") : t(report.reasons.join("・"))}</p><button onClick={downloadDiagnostics}>{t("診断データを保存")}</button></>}
    </>}>
    <canvas ref={outputCanvasRef} width={768} height={768} className={presentationClass} data-testid="output-canvas" aria-label={t("Many Facesの出力")} />
  </CallStage>;
}
