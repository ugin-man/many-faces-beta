"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { faceFeatureFromScores } from "../face-actions";
import {
  faceGeometryFromLandmarks,
  type FaceGeometry,
  type SequenceFrame,
} from "../offline-matching";
import {
  optimizeDistinctProjectionSequence,
  rankProjectionCandidateModesTwoStage,
  type ProjectionChoice,
  type ProjectionError,
} from "../projection-matching";
import {
  poseWindowCellKeys,
  shardFilesForCells,
  shouldExpandPoseWindow,
  type ReviewCatalogManifest,
} from "./review-local-catalog";
import {
  processingSecondsPerOutputSecond,
  quantizeReviewTime,
  reviewItemAtTime,
} from "./review-timeline";
import { evaluateVerificationGate } from "./verification-gate";
import styles from "./review-client-lite.module.css";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const CAPTURE_SECONDS = 5;
const INDEX_BEAM_PER_FRAME = 64;
const SHARD_CONCURRENCY = 4;
const STRICT_SEQUENCE_OPTIONS = {
  cooldown: 12,
  beamWidth: 24,
  qualityThreshold: 0.055,
  residualCoherence: 0.46,
  expressionMotionWeight: 6.2,
  motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
} as const;

type CatalogEntry = {
  id: string;
  name?: string;
  image?: string;
  pack?: string;
  offset?: number;
  length?: number;
  feature: number[];
  shape?: string;
  mesh?: string;
  projection?: string;
  layout?: [number, number, number, number];
  sourceName?: string;
  creator?: string;
};

type CatalogManifest = ReviewCatalogManifest & {
  schemaVersion: 1 | 2 | 3;
  catalogId?: string;
  generatedAt?: string;
  totalFaces: number;
  searchableFaces?: number;
  poseStep: number;
  bounds: {
    yawMin: number;
    yawMax: number;
    pitchMin: number;
    pitchMax: number;
  };
};

type Candidate = {
  id: string;
  name: string;
  url: string;
  feature: number[];
  geometry: FaceGeometry;
  sourceName?: string;
  creator?: string;
};

type ReviewChoice = ProjectionChoice<Candidate>;

type ReviewTimelineItem = {
  time: number;
  choice: ReviewChoice;
};

type Phase =
  | "idle"
  | "recording"
  | "waiting"
  | "analyzing"
  | "searching"
  | "optimizing"
  | "preloading"
  | "review"
  | "error";

type Readiness = "loading" | "ready" | "failed";

type Progress = {
  done: number;
  total: number;
  label: string;
};

type VerificationReport = {
  sourceName: string;
  plannedFrames: number;
  faceFrames: number;
  sequenceFrames: number;
  selectedImages: number;
  imageFailures: number;
  outputChanges: number;
  uniqueFaces: number;
  processingMs: number;
  canvasNonBlank: boolean;
  faceCoverage: number;
  passed: boolean;
  reasons: string[];
};

declare global {
  interface Window {
    __MANY_FACES_VERIFY__?: VerificationReport;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function quantizePose(value: number) {
  const degrees = clamp(value * 90, -45, 45);
  return Math.round(degrees / 3) * 3 / 90;
}

function featureFromResult(result: FaceLandmarkerResult) {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  const scores = new Map(
    (result.faceBlendshapes[0]?.categories ?? []).map((category) => [
      category.categoryName,
      category.score,
    ]),
  );
  let pose = [0, 0, 0];
  if (matrix && matrix.length >= 11) {
    const pitch = Math.atan2(matrix[9], matrix[10]);
    const yaw = Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10]));
    const roll = Math.atan2(matrix[4], matrix[0]);
    pose = [
      yaw / (Math.PI / 2),
      pitch * 1.4 / (Math.PI / 2),
      roll / (Math.PI / 2),
    ].map(quantizePose);
  }
  return faceFeatureFromScores(pose, scores);
}

function decodeVector(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
    if (!bytes.byteLength || bytes.byteLength % 2) return null;
    const values = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );
    return Float32Array.from(values, (value) => value / 4096);
  } catch {
    return null;
  }
}

function candidateUrl(entry: CatalogEntry) {
  if (entry.image) {
    return `/api/catalog/image?source=seed&id=${encodeURIComponent(entry.image)}`;
  }
  if (!entry.pack || entry.offset == null || entry.length == null) return null;
  return `/api/catalog/image?source=seed&pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
}

function candidateFromEntry(entry: CatalogEntry): Candidate | null {
  const structure = decodeVector(entry.shape);
  const surface = decodeVector(entry.mesh);
  const projection = decodeVector(entry.projection);
  const url = candidateUrl(entry);
  if (
    !entry.id ||
    !Array.isArray(entry.feature) ||
    entry.feature.length < 22 ||
    !structure ||
    structure.length < 13 ||
    !surface ||
    surface.length < 300 ||
    !projection ||
    projection.length < 936 ||
    !entry.layout ||
    entry.layout.length !== 4 ||
    !url
  ) {
    return null;
  }
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url,
    feature: entry.feature,
    geometry: { structure, surface, projection, layout: entry.layout },
    sourceName: entry.sourceName,
    creator: entry.creator,
  };
}

function chooseRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("録画映像を開けませんでした"));
    }, 15_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("error", failed);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("録画映像を開けませんでした"));
    };
    video.addEventListener("loadedmetadata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const duration = Number.isFinite(video.duration) ? video.duration : CAPTURE_SECONDS;
    const target = clamp(time, 0, Math.max(0, duration - 0.001));
    if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) {
      requestAnimationFrame(() => resolve());
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("録画フレームの読み込みが止まりました"));
    }, 8_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", finished);
      video.removeEventListener("error", failed);
    };
    const finished = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("録画フレームを読み込めませんでした"));
    };
    video.addEventListener("seeked", finished, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.currentTime = target;
  });
}

function nextTask() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function loadCandidateImage(candidate: Candidate) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    let settled = false;
    const timeout = window.setTimeout(() => finish(false), 20_000);
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (success) resolve(image);
      else reject(new Error(`IMAGE ${candidate.id}`));
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = candidate.url;
    void image.decode?.().then(() => finish(true)).catch(() => undefined);
  });
}

function drawContained(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource & { width: number; height: number },
) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  context.fillStyle = "#0a0c10";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    (canvas.width - drawWidth) / 2,
    (canvas.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function canvasHasVisiblePixels(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  const width = Math.min(canvas.width, 96);
  const height = Math.min(canvas.height, 64);
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const target = scratch.getContext("2d", { willReadFrequently: true });
  if (!target) return false;
  target.drawImage(canvas, 0, 0, width, height);
  const pixels = target.getImageData(0, 0, width, height).data;
  let visible = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 45) {
      visible += 1;
    }
  }
  return visible > width * height * 0.08;
}

function phaseText(phase: Phase) {
  switch (phase) {
    case "recording": return "5秒間を録画中";
    case "waiting": return "解析エンジンを待っています";
    case "analyzing": return "録画をFace Meshで解析中";
    case "searching": return "必要な角度の顔だけ読み込み・照合中";
    case "optimizing": return "5秒全体の経路を確定中";
    case "preloading": return "採用画像を再生前に準備中";
    case "review": return "レビューできます";
    case "error": return "処理を完了できませんでした";
    default: return "5秒撮って、あとから連続再生";
  }
}

export default function LightweightReviewClient() {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingUrlRef = useRef<string | null>(null);
  const manifestRef = useRef<CatalogManifest | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const shardCacheRef = useRef(new Map<string, Promise<Candidate[]>>());
  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());
  const sequenceRef = useRef<ReviewTimelineItem[]>([]);
  const processingTokenRef = useRef(0);
  const playbackRafRef = useRef<number | null>(null);
  const replayFpsRef = useRef(12);
  const lastOutputIdRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [modelState, setModelState] = useState<Readiness>("loading");
  const [manifestState, setManifestState] = useState<Readiness>("loading");
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [sourceName, setSourceName] = useState("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [analysisFps, setAnalysisFps] = useState(12);
  const [replayFps, setReplayFps] = useState(12);
  const [recordingRemaining, setRecordingRemaining] = useState(CAPTURE_SECONDS);
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

  useEffect(() => {
    replayFpsRef.current = replayFps;
  }, [replayFps]);

  useEffect(() => {
    window.__MANY_FACES_VERIFY__ = report ?? undefined;
  }, [report]);

  const busy = !["idle", "review", "error"].includes(phase);
  const readinessLabel = useMemo(() => {
    if (modelState === "failed" || manifestState === "failed") return "準備エラー";
    if (modelState === "ready" && manifestState === "ready") return "解析準備OK";
    return "バックグラウンド準備中";
  }, [manifestState, modelState]);

  const stopPlayback = useCallback(() => {
    if (playbackRafRef.current !== null) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
    }
    playbackVideoRef.current?.pause();
    setPlaying(false);
  }, []);

  const cleanupRecording = useCallback(() => {
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }, []);

  const clearReview = useCallback(() => {
    stopPlayback();
    processingTokenRef.current += 1;
    shardCacheRef.current.clear();
    outputImagesRef.current.clear();
    sequenceRef.current = [];
    lastOutputIdRef.current = null;
    setReport(null);
    window.__MANY_FACES_VERIFY__ = undefined;
    if (recordingUrlRef.current) {
      URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = null;
    }
    const video = playbackVideoRef.current;
    if (video) {
      video.removeAttribute("src");
      video.load();
    }
  }, [stopPlayback]);

  useEffect(() => {
    let disposed = false;

    async function prepareManifest() {
      try {
        const response = await fetch("/api/catalog/manifest?source=seed", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`CATALOG ${response.status}`);
        const manifest = await response.json() as CatalogManifest;
        if (disposed) return;
        manifestRef.current = manifest;
        setCatalogTotal(
          Number(manifest.searchableFaces ?? manifest.totalFaces ?? 0),
        );
        setManifestState("ready");
      } catch (caught) {
        console.error("Review manifest setup failed.", caught);
        if (!disposed) setManifestState("failed");
      }
    }

    async function prepareModel() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const options = {
          runningMode: "IMAGE" as const,
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.45,
          minFacePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        };
        let landmarker: FaceLandmarker;
        try {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          });
        } catch {
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...options,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          });
        }
        if (disposed) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setModelState("ready");
      } catch (caught) {
        console.error("Review model setup failed.", caught);
        if (!disposed) setModelState("failed");
      }
    }

    void prepareManifest();
    void prepareModel();

    return () => {
      disposed = true;
      cleanupRecording();
      clearReview();
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [cleanupRecording, clearReview]);

  const waitUntilPrepared = useCallback(async (token: number) => {
    while (
      processingTokenRef.current === token &&
      (!manifestRef.current || !landmarkerRef.current)
    ) {
      if (modelState === "failed" || manifestState === "failed") {
        throw new Error("解析の準備に失敗しました。ページを再読み込みしてください");
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) {
      throw new DOMException("Cancelled", "AbortError");
    }
  }, [manifestState, modelState]);

  const loadShard = useCallback((file: string, token: number) => {
    const cached = shardCacheRef.current.get(file);
    if (cached) return cached;
    const promise = (async () => {
      const manifest = manifestRef.current;
      if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
      const catalog = manifest.catalogId || manifest.generatedAt || "current";
      const response = await fetch(
        `/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`,
        { cache: "force-cache" },
      );
      if (!response.ok) throw new Error(`SHARD ${response.status}`);
      const payload = await response.json() as { items?: CatalogEntry[] };
      if (processingTokenRef.current !== token) {
        throw new DOMException("Cancelled", "AbortError");
      }
      const candidates: Candidate[] = [];
      const items = payload.items ?? [];
      for (let index = 0; index < items.length; index += 1) {
        const candidate = candidateFromEntry(items[index]);
        if (candidate) candidates.push(candidate);
        if (index > 0 && index % 64 === 0) await nextTask();
      }
      return candidates;
    })();
    shardCacheRef.current.set(file, promise);
    return promise;
  }, []);

  const loadCells = useCallback(async (
    cellKeys: readonly string[],
    token: number,
  ) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    const files = shardFilesForCells(manifest, cellKeys);
    const candidates: Candidate[] = [];
    for (let index = 0; index < files.length; index += SHARD_CONCURRENCY) {
      const batch = files.slice(index, index + SHARD_CONCURRENCY);
      const payloads = await Promise.all(
        batch.map((file) => loadShard(file, token)),
      );
      payloads.forEach((items) => candidates.push(...items));
      setLoadedShards(shardCacheRef.current.size);
      await nextTask();
    }
    return [...new Map(candidates.map((item) => [item.id, item])).values()];
  }, [loadShard]);

  const loadFrameCandidates = useCallback(async (
    frame: SequenceFrame,
    token: number,
  ) => {
    const manifest = manifestRef.current;
    if (!manifest) throw new Error("CATALOG MANIFEST MISSING");
    const innerKeys = poseWindowCellKeys(manifest, frame.feature, 12, 15);
    let candidates = await loadCells(innerKeys, token);
    if (shouldExpandPoseWindow(candidates.length, 384)) {
      const outerKeys = poseWindowCellKeys(manifest, frame.feature, 18, 21);
      candidates = await loadCells(outerKeys, token);
    }
    setPeakCandidates((current) => Math.max(current, candidates.length));
    return candidates;
  }, [loadCells]);

  const drawReviewAt = useCallback((time: number) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const quantized = quantizeReviewTime(
      time,
      replayFpsRef.current,
      clipDuration,
    );
    const item = reviewItemAtTime(sequenceRef.current, quantized);
    if (!item) return;
    const image = outputImagesRef.current.get(item.choice.candidate.id);
    if (image) drawContained(canvas, image);
    if (lastOutputIdRef.current !== item.choice.candidate.id) {
      lastOutputIdRef.current = item.choice.candidate.id;
      setCurrentOutputName(item.choice.candidate.name);
      setCurrentOutputSource(
        item.choice.candidate.sourceName || item.choice.candidate.creator || "—",
      );
      setCurrentError(item.choice.error);
    }
  }, [clipDuration]);

  const startPlaybackLoop = useCallback(() => {
    if (playbackRafRef.current !== null) {
      cancelAnimationFrame(playbackRafRef.current);
    }
    const tick = () => {
      const video = playbackVideoRef.current;
      if (!video || video.paused || video.ended) {
        playbackRafRef.current = null;
        setPlaying(false);
        return;
      }
      drawReviewAt(video.currentTime);
      setPlaybackTime(video.currentTime);
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [drawReviewAt]);

  const processRecording = useCallback(async (
    videoUrl: string,
    duration: number,
  ) => {
    const token = processingTokenRef.current + 1;
    processingTokenRef.current = token;
    const started = performance.now();
    setError(null);
    setProgress(null);
    setFaceFrames(0);
    setLoadedShards(0);
    setPeakCandidates(0);
    setProcessingMs(0);
    setOutputChanges(0);
    setUniqueFaces(0);
    setImageFailures(0);
    shardCacheRef.current.clear();
    outputImagesRef.current.clear();
    sequenceRef.current = [];

    try {
      setPhase("waiting");
      await waitUntilPrepared(token);
      const video = playbackVideoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker) throw new Error("解析エンジンがありません");
      video.src = videoUrl;
      video.load();
      await waitForVideoMetadata(video);
      video.pause();
      const safeDuration = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(duration, video.duration)
        : duration;
      setClipDuration(safeDuration);
      const frameCount = Math.max(2, Math.floor(safeDuration * analysisFps));
      setPlannedFrames(frameCount);
      const frames: SequenceFrame[] = [];

      setPhase("analyzing");
      for (let index = 0; index < frameCount; index += 1) {
        if (processingTokenRef.current !== token) {
          throw new DOMException("Cancelled", "AbortError");
        }
        const time = Math.min(
          safeDuration - 0.001,
          index / analysisFps,
        );
        await seekVideo(video, time);
        const result = landmarker.detect(video);
        const landmarks = result.faceLandmarks[0];
        if (landmarks && result.faceBlendshapes.length) {
          const geometry = faceGeometryFromLandmarks(
            landmarks,
            video.videoWidth > 0 && video.videoHeight > 0
              ? video.videoWidth / video.videoHeight
              : 1,
          );
          if (geometry) {
            frames.push({
              time,
              feature: featureFromResult(result),
              geometry,
            });
          }
        }
        setProgress({
          done: index + 1,
          total: frameCount,
          label: `Face Mesh ${index + 1} / ${frameCount}`,
        });
        await nextPaint();
      }
      setFaceFrames(frames.length);
      if (frames.length < 2) {
        throw new Error("顔を十分に検出できませんでした。明るい場所で撮り直してください");
      }

      setPhase("searching");
      const beams: Array<Array<{ candidate: Candidate; error: ProjectionError }>> = [];
      for (let index = 0; index < frames.length; index += 1) {
        if (processingTokenRef.current !== token) {
          throw new DOMException("Cancelled", "AbortError");
        }
        const candidates = await loadFrameCandidates(frames[index], token);
        const ranked = rankProjectionCandidateModesTwoStage(
          frames[index],
          candidates,
          INDEX_BEAM_PER_FRAME,
          Math.min(1_024, candidates.length),
        ).strict;
        if (!ranked.length) throw new Error("比較できる顔候補がありませんでした");
        beams.push(ranked);
        setProgress({
          done: index + 1,
          total: frames.length,
          label: `3D照合 ${index + 1} / ${frames.length} · ${candidates.length.toLocaleString()}候補`,
        });
        await nextPaint();
      }

      // The beams retain every candidate needed by the final path. Clearing the
      // shard cache here lets all non-final local candidates be garbage-collected.
      shardCacheRef.current.clear();

      setPhase("optimizing");
      setProgress({ done: 0, total: 1, label: "5秒全体のstrict経路を計算中" });
      await nextPaint();
      const choices = optimizeDistinctProjectionSequence(
        frames,
        beams,
        STRICT_SEQUENCE_OPTIONS,
      );
      if (!choices.length) throw new Error("連続経路を作れませんでした");
      const timeline = choices.map((choice) => ({
        time: choice.frame.time,
        choice,
      }));
      sequenceRef.current = timeline;

      setPhase("preloading");
      const selected = [...new Map(
        choices.map((choice) => [choice.candidate.id, choice.candidate]),
      ).values()];
      let next = 0;
      let completed = 0;
      let failures = 0;
      const preloadWorker = async () => {
        while (processingTokenRef.current === token) {
          const index = next;
          next += 1;
          if (index >= selected.length) return;
          const candidate = selected[index];
          try {
            const image = await loadCandidateImage(candidate);
            if (processingTokenRef.current !== token) return;
            outputImagesRef.current.set(candidate.id, image);
          } catch {
            failures += 1;
          }
          completed += 1;
          setProgress({
            done: completed,
            total: selected.length,
            label: `採用画像を準備中 ${completed} / ${selected.length}`,
          });
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(6, selected.length) },
          () => preloadWorker(),
        ),
      );
      setImageFailures(failures);
      const changes = choices.reduce((count, choice, index) =>
        index > 0 && choices[index - 1].candidate.id !== choice.candidate.id
          ? count + 1
          : count,
      0);
      setOutputChanges(changes);
      setUniqueFaces(selected.length);
      const elapsed = performance.now() - started;
      setProcessingMs(elapsed);
      setProgress(null);
      setPlaybackTime(0);
      setPhase("review");
      video.currentTime = 0;
      drawReviewAt(0);
      await nextPaint();
      const canvas = outputCanvasRef.current;
      const canvasNonBlank = Boolean(
        canvas && canvasHasVisiblePixels(canvas),
      );
      const gate = evaluateVerificationGate({
        plannedFrames: frameCount,
        faceFrames: frames.length,
        sequenceFrames: choices.length,
        selectedImages: selected.length,
        imageFailures: failures,
        outputChanges: changes,
        canvasNonBlank,
      });
      const nextReport: VerificationReport = {
        sourceName: sourceName || "camera-five-seconds.webm",
        plannedFrames: frameCount,
        faceFrames: frames.length,
        sequenceFrames: choices.length,
        selectedImages: selected.length,
        imageFailures: failures,
        outputChanges: changes,
        uniqueFaces: selected.length,
        processingMs: elapsed,
        canvasNonBlank,
        faceCoverage: gate.faceCoverage,
        passed: gate.passed,
        reasons: gate.reasons,
      };
      setReport(nextReport);
      window.__MANY_FACES_VERIFY__ = nextReport;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      console.error("Lightweight review failed.", caught);
      setError(caught instanceof Error ? caught.message : "処理に失敗しました");
      setPhase("error");
      setProgress(null);
    }
  }, [
    analysisFps,
    drawReviewAt,
    loadFrameCandidates,
    sourceName,
    waitUntilPrepared,
  ]);

  const verifyVideoFile = useCallback(async (file: File | null) => {
    if (!file || busy) return;
    clearReview();
    cleanupRecording();
    setError(null);
    setSourceName(file.name);
    try {
      const url = URL.createObjectURL(file);
      recordingUrlRef.current = url;
      const video = playbackVideoRef.current;
      if (!video) throw new Error("検証用動画を準備できませんでした");
      video.src = url;
      video.load();
      await waitForVideoMetadata(video);
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(CAPTURE_SECONDS, video.duration)
        : CAPTURE_SECONDS;
      setClipDuration(duration);
      void processRecording(url, duration);
    } catch (caught) {
      console.error("Fixed video verification failed.", caught);
      setError(caught instanceof Error ? caught.message : "動画を開けませんでした");
      setPhase("error");
      setProgress(null);
    }
  }, [busy, cleanupRecording, clearReview, processRecording]);

  const recordFiveSeconds = useCallback(async () => {
    if (busy) return;
    clearReview();
    cleanupRecording();
    setError(null);
      setSourceName("camera-five-seconds.webm");
      setRecordingRemaining(CAPTURE_SECONDS);
      setPhase("recording");
    setProgress({ done: 0, total: CAPTURE_SECONDS * 10, label: "5秒間を録画中" });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const preview = previewVideoRef.current;
      if (!preview) throw new Error("カメラ表示を準備できませんでした");
      preview.srcObject = stream;
      preview.muted = true;
      preview.playsInline = true;
      await preview.play();

      const mimeType = chooseRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      recorder.start(250);
      const started = performance.now();
      const timer = window.setInterval(() => {
        const elapsed = (performance.now() - started) / 1_000;
        const remaining = Math.max(0, CAPTURE_SECONDS - elapsed);
        setRecordingRemaining(remaining);
        setProgress({
          done: Math.min(CAPTURE_SECONDS * 10, Math.round(elapsed * 10)),
          total: CAPTURE_SECONDS * 10,
          label: `${remaining.toFixed(1)}秒` ,
        });
      }, 100);
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, CAPTURE_SECONDS * 1_000),
      );
      window.clearInterval(timer);
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      cleanupRecording();

      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "video/webm",
      });
      if (!blob.size) throw new Error("録画データを作れませんでした");
      const url = URL.createObjectURL(blob);
      recordingUrlRef.current = url;
      const video = playbackVideoRef.current;
      if (!video) throw new Error("レビュー映像を準備できませんでした");
      video.src = url;
      video.load();
      await waitForVideoMetadata(video);
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(CAPTURE_SECONDS, video.duration)
        : CAPTURE_SECONDS;
      setClipDuration(duration);
      setRecordingRemaining(0);
      void processRecording(url, duration);
    } catch (caught) {
      cleanupRecording();
      console.error("Five-second recording failed.", caught);
      setError(caught instanceof Error ? caught.message : "カメラ録画に失敗しました");
      setPhase("error");
      setProgress(null);
    }
  }, [busy, cleanupRecording, clearReview, processRecording]);

  const togglePlayback = useCallback(async () => {
    const video = playbackVideoRef.current;
    if (!video || phase !== "review") return;
    if (video.paused || video.ended) {
      if (video.ended) video.currentTime = 0;
      video.muted = true;
      await video.play();
      setPlaying(true);
      startPlaybackLoop();
    } else {
      stopPlayback();
      drawReviewAt(video.currentTime);
    }
  }, [drawReviewAt, phase, startPlaybackLoop, stopPlayback]);

  const seekReview = useCallback((time: number) => {
    const video = playbackVideoRef.current;
    if (!video || phase !== "review") return;
    stopPlayback();
    const target = clamp(time, 0, clipDuration);
    video.currentTime = target;
    setPlaybackTime(target);
    drawReviewAt(target);
  }, [clipDuration, drawReviewAt, phase, stopPlayback]);

  const reset = useCallback(() => {
    cleanupRecording();
    clearReview();
    setPhase("idle");
    setProgress(null);
    setError(null);
    setPlaybackTime(0);
    setFaceFrames(0);
    setLoadedShards(0);
    setPeakCandidates(0);
    setProcessingMs(0);
    setOutputChanges(0);
    setUniqueFaces(0);
    setImageFailures(0);
    setCurrentOutputName("—");
    setCurrentOutputSource("—");
    setCurrentError(null);
    setSourceName("");
    setReport(null);
  }, [cleanupRecording, clearReview]);

  const progressRatio = progress?.total
    ? clamp(progress.done / progress.total, 0, 1)
    : 0;
  const perSecond = processingSecondsPerOutputSecond(
    processingMs,
    clipDuration,
  );

  return (
    <main
      className={styles.shell}
      data-testid="verification-root"
      data-state={phase}
      data-verdict={report ? (report.passed ? "passed" : "failed") : "pending"}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>MANY FACES / DETERMINISTIC VIDEO CHECK</p>
          <h1>カメラの前に、同じ動画で壊れ方を潰す。</h1>
          <p className={styles.lead}>
            固定動画なら、毎回同じ入力でFace Mesh、角度shard、3D照合、strict経路、画像表示まで確認できます。カメラは比較用の実験扱いです。
          </p>
        </div>
        <nav className={styles.nav}>
          <Link href="/">VIDEO</Link>
          <Link href="/live/fifo">FIFO</Link>
          <Link href="/live/fast">FAST</Link>
        </nav>
      </header>

      <section className={styles.statusStrip} aria-live="polite">
        <div className={styles.steps}>
          <span className={phase === "recording" ? styles.activeStep : ""}>1 撮影</span>
          <span className={[
            "waiting", "analyzing", "searching", "optimizing", "preloading",
          ].includes(phase) ? styles.activeStep : ""}>2 処理</span>
          <span className={phase === "review" ? styles.activeStep : ""}>3 確認</span>
        </div>
        <strong>{phaseText(phase)}</strong>
        <div className={styles.readiness}>
          <span data-state={modelState}>MODEL</span>
          <span data-state={manifestState}>CATALOG</span>
          <b>{readinessLabel}</b>
        </div>
      </section>

      <section className={phase === "review" ? styles.reviewGrid : styles.captureGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
          <span>{phase === "review" ? "SOURCE VIDEO" : "INPUT"}</span>
          <b>{phase === "recording" ? `${recordingRemaining.toFixed(1)}s` : sourceName || "NO VIDEO"}</b>
          </div>
          <div className={styles.viewport}>
            <video
              ref={previewVideoRef}
              className={`${styles.media} ${phase === "recording" ? "" : styles.hiddenMedia}`}
              muted
              playsInline
            />
            <video
              ref={playbackVideoRef}
              className={`${styles.media} ${phase === "review" ? "" : styles.hiddenMedia}`}
              muted
              playsInline
              onEnded={() => {
                setPlaying(false);
                setPlaybackTime(clipDuration);
                drawReviewAt(clipDuration);
              }}
            />
            {phase !== "recording" && phase !== "review" && (
              <div className={styles.placeholder}>
                <strong>{busy ? phaseText(phase) : "5秒レビュー"}</strong>
                <span>
                  {busy
                    ? "ページを閉じずに待ってください。進捗は下に出ます。"
                    : "まず固定動画を選んでください。同じ入力でこちら側も自動検証できます。"}
                </span>
              </div>
            )}
            {phase === "recording" && <span className={styles.recordBadge}>REC</span>}
          </div>
        </article>

        {phase === "review" && (
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <span>MANY FACES</span>
              <b>{replayFps} FPS</b>
            </div>
            <div className={styles.viewport}>
              <canvas
                ref={outputCanvasRef}
                className={styles.canvas}
                width={768}
                height={512}
              />
            </div>
            <div className={styles.outputMeta}>
              <span>{currentOutputName}</span>
              <b>{currentOutputSource}</b>
            </div>
          </article>
        )}
      </section>

      <section className={styles.commandBar}>
        <div className={styles.primaryRow}>
          <label className={styles.filePicker}>
            <span>固定動画で検証</span>
            <input
              type="file"
              accept="video/*"
              data-testid="verification-file-input"
              onChange={(event) => {
                void verifyVideoFile(event.target.files?.[0] ?? null);
              }}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            className={styles.cameraButton}
            onClick={recordFiveSeconds}
            disabled={busy}
          >
            {phase === "recording" ? "録画中" : "カメラで5秒（実験）"}
          </button>
          <button type="button" onClick={reset} disabled={phase === "recording"}>
            リセット
          </button>
          <label>
            解析密度
            <select
              value={analysisFps}
              onChange={(event) => setAnalysisFps(Number(event.target.value))}
              disabled={busy}
            >
              <option value="12">12fps 軽量</option>
              <option value="20">20fps 中間</option>
              <option value="30">30fps 動画版基準</option>
            </select>
          </label>
          {phase === "review" && (
            <>
              <button type="button" onClick={togglePlayback}>
                {playing ? "一時停止" : "再生"}
              </button>
              <button
                type="button"
                onClick={() => seekReview(playbackTime - 1 / replayFps)}
              >
                −1 frame
              </button>
              <button
                type="button"
                onClick={() => seekReview(playbackTime + 1 / replayFps)}
              >
                +1 frame
              </button>
              <label>
                再生
                <select
                  value={replayFps}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setReplayFps(next);
                    replayFpsRef.current = next;
                    drawReviewAt(playbackTime);
                  }}
                >
                  <option value="12">12fps</option>
                  <option value="20">20fps</option>
                  <option value="30">30fps</option>
                </select>
              </label>
            </>
          )}
        </div>

        {progress && (
          <div className={styles.progressBox}>
            <div>
              <strong>{progress.label}</strong>
              <span>{Math.round(progressRatio * 100)}%</span>
            </div>
            <i style={{ width: `${progressRatio * 100}%` }} />
          </div>
        )}

        {phase === "review" && (
          <input
            className={styles.scrubber}
            type="range"
            min="0"
            max={clipDuration}
            step={1 / Math.max(1, replayFps)}
            value={playbackTime}
            onChange={(event) => seekReview(Number(event.target.value))}
          />
        )}

        {report && (
          <div className={report.passed ? styles.passBox : styles.failBox}>
            <strong>{report.passed ? "自動検証 PASS" : "自動検証で問題を検出"}</strong>
            <span>
              顔検出 {(report.faceCoverage * 100).toFixed(1)}% · {report.sequenceFrames} frames · {report.uniqueFaces} faces · {(report.processingMs / 1_000).toFixed(1)}秒
            </span>
            {!report.passed && report.reasons.map((reason) => (
              <small key={reason}>{reason}</small>
            ))}
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}
      </section>

      <details className={styles.diagnostics}>
        <summary>処理の詳細</summary>
        <div className={styles.metrics}>
          <div><span>CATALOG</span><strong>{catalogTotal.toLocaleString()}</strong></div>
          <div><span>ANALYSIS</span><strong>{analysisFps} fps / {plannedFrames}</strong></div>
          <div><span>FACE FRAMES</span><strong>{faceFrames}</strong></div>
          <div><span>LOADED SHARDS</span><strong>{loadedShards}</strong></div>
          <div><span>PEAK LOCAL FACES</span><strong>{peakCandidates.toLocaleString()}</strong></div>
          <div><span>PROCESSING</span><strong>{(processingMs / 1_000).toFixed(1)} s</strong></div>
          <div><span>PER OUTPUT SEC</span><strong>{perSecond.toFixed(1)} s</strong></div>
          <div><span>CHANGES</span><strong>{outputChanges}</strong></div>
          <div><span>UNIQUE FACES</span><strong>{uniqueFaces}</strong></div>
          <div><span>IMAGE FAILURES</span><strong>{imageFailures}</strong></div>
          <div><span>STRICT ERROR</span><strong>{currentError?.strictTotal.toFixed(4) ?? "—"}</strong></div>
        </div>
      </details>
      <output hidden data-testid="verification-report">
        {report ? JSON.stringify(report) : ""}
      </output>
    </main>
  );
}
