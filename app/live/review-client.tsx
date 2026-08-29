"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
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
  processingSecondsPerOutputSecond,
  quantizeReviewTime,
  reviewItemAtTime,
  sourceGapEstimate,
} from "./review-timeline";
import styles from "./review-client.module.css";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const CAPTURE_SECONDS = 5;
const CAPTURE_FPS = 30;
const CAPTURE_SIZE = 512;
const INDEX_BEAM_PER_FRAME = 64;
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

type CatalogManifest = {
  schemaVersion: 1 | 2 | 3;
  catalogId?: string;
  generatedAt?: string;
  totalFaces: number;
  indexFile?: string;
  indexFiles?: string[];
  cells: Record<string, { shards?: string[]; shard?: string }>;
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

type CapturedFrame = {
  blob: Blob;
  time: number;
};

type ReviewChoice = ProjectionChoice<Candidate>;

type ReviewTimelineItem = {
  time: number;
  choice: ReviewChoice;
};

type Phase =
  | "preparing"
  | "ready"
  | "recording"
  | "waiting"
  | "analyzing"
  | "optimizing"
  | "preloading"
  | "review"
  | "error";

type Progress = {
  done: number;
  total: number;
  label: string;
};

type VideoFrameMetadata = {
  mediaTime?: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

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
    return `/api/catalog/image?id=${encodeURIComponent(entry.image)}`;
  }
  if (!entry.pack || entry.offset == null || entry.length == null) return null;
  return `/api/catalog/image?pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
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

function localCandidates(frame: SequenceFrame, candidates: Candidate[]) {
  const within = (yawLimit: number, pitchLimit: number) =>
    candidates.filter(
      (candidate) =>
        Math.abs(
          Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0),
        ) * 90 <= yawLimit &&
        Math.abs(
          Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0),
        ) * 90 <= pitchLimit,
    );
  let local = within(12, 15);
  if (local.length < Math.min(384, candidates.length)) {
    local = within(18, 21);
  }
  return local.length >= 4 ? local : candidates;
}

function chooseRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const options = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("FRAME ENCODE FAILED"))),
      "image/webp",
      0.94,
    );
  });
}

function nextTask() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
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
  const x = (canvas.width - drawWidth) / 2;
  const y = (canvas.height - drawHeight) / 2;
  context.fillStyle = "#0c0e13";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, x, y, drawWidth, drawHeight);
}

export default function LiveReviewClient() {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureFrameCallbackRef = useRef<number | null>(null);
  const captureChainRef = useRef<Promise<void>>(Promise.resolve());
  const captureActiveRef = useRef(false);
  const captureStartedAtRef = useRef(0);
  const firstMediaTimeRef = useRef<number | null>(null);
  const previousMediaTimeRef = useRef<number | null>(null);
  const sourceGapRef = useRef(0);
  const capturedFramesRef = useRef<CapturedFrame[]>([]);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recordingUrlRef = useRef<string | null>(null);

  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const candidatesRef = useRef<Candidate[]>([]);
  const preparationErrorRef = useRef<Error | null>(null);
  const preparationTokenRef = useRef(0);
  const processingTokenRef = useRef(0);

  const sequenceRef = useRef<ReviewTimelineItem[]>([]);
  const outputImagesRef = useRef(new Map<string, HTMLImageElement>());
  const replayFpsRef = useRef(12);
  const playbackRafRef = useRef<number | null>(null);
  const lastPlaybackTelemetryRef = useRef(0);
  const lastOutputIdRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("preparing");
  const [engineReady, setEngineReady] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogCount, setCatalogCount] = useState(0);
  const [catalogFiles, setCatalogFiles] = useState(0);
  const [catalogLoaded, setCatalogLoaded] = useState(0);
  const [candidateCount, setCandidateCount] = useState(0);
  const [recordingRemaining, setRecordingRemaining] = useState(CAPTURE_SECONDS);
  const [capturedFrames, setCapturedFrames] = useState(0);
  const [capturedGaps, setCapturedGaps] = useState(0);
  const [clipDuration, setClipDuration] = useState(CAPTURE_SECONDS);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [processingMs, setProcessingMs] = useState(0);
  const [faceFrames, setFaceFrames] = useState(0);
  const [outputChanges, setOutputChanges] = useState(0);
  const [uniqueFaces, setUniqueFaces] = useState(0);
  const [imageFailures, setImageFailures] = useState(0);
  const [replayFps, setReplayFps] = useState(12);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [currentOutputName, setCurrentOutputName] = useState("—");
  const [currentOutputSource, setCurrentOutputSource] = useState("—");
  const [currentError, setCurrentError] = useState<ProjectionError | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    replayFpsRef.current = replayFps;
  }, [replayFps]);

  const stopPlaybackLoop = useCallback(() => {
    if (playbackRafRef.current !== null) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
    }
  }, []);

  const drawReviewAt = useCallback((time: number) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const quantized = quantizeReviewTime(
      time,
      replayFpsRef.current,
      clipDuration,
    );
    const timelineItem = reviewItemAtTime(sequenceRef.current, quantized);
    if (!timelineItem) return;
    const image = outputImagesRef.current.get(timelineItem.choice.candidate.id);
    if (image) drawContained(canvas, image);
    if (lastOutputIdRef.current !== timelineItem.choice.candidate.id) {
      lastOutputIdRef.current = timelineItem.choice.candidate.id;
      setCurrentOutputName(timelineItem.choice.candidate.name);
      setCurrentOutputSource(
        timelineItem.choice.candidate.sourceName ||
          timelineItem.choice.candidate.creator ||
          "—",
      );
      setCurrentError(timelineItem.choice.error);
    }
  }, [clipDuration]);

  const startPlaybackLoop = useCallback(() => {
    stopPlaybackLoop();
    const tick = (now: number) => {
      const video = playbackVideoRef.current;
      if (!video || video.paused || video.ended) {
        playbackRafRef.current = null;
        return;
      }
      drawReviewAt(video.currentTime);
      if (now - lastPlaybackTelemetryRef.current >= 80) {
        lastPlaybackTelemetryRef.current = now;
        setPlaybackTime(video.currentTime);
      }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [drawReviewAt, stopPlaybackLoop]);

  const cleanupRecording = useCallback(() => {
    captureActiveRef.current = false;
    const preview = previewVideoRef.current as VideoWithFrameCallback | null;
    if (
      captureFrameCallbackRef.current !== null &&
      preview?.cancelVideoFrameCallback
    ) {
      preview.cancelVideoFrameCallback(captureFrameCallbackRef.current);
    } else if (captureFrameCallbackRef.current !== null) {
      cancelAnimationFrame(captureFrameCallbackRef.current);
    }
    captureFrameCallbackRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }, []);

  const cleanupReview = useCallback(() => {
    stopPlaybackLoop();
    const video = playbackVideoRef.current;
    video?.pause();
    if (recordingUrlRef.current) {
      URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = null;
    }
    outputImagesRef.current.clear();
    sequenceRef.current = [];
    lastOutputIdRef.current = null;
  }, [stopPlaybackLoop]);

  useEffect(() => {
    const token = preparationTokenRef.current + 1;
    preparationTokenRef.current = token;
    let disposed = false;

    async function prepareCatalog() {
      try {
        const manifestResponse = await fetch(
          "/api/catalog/manifest",
          { cache: "no-store" },
        );
        if (!manifestResponse.ok) {
          throw new Error(`CATALOG ${manifestResponse.status}`);
        }
        const manifest = await manifestResponse.json() as CatalogManifest;
        if (disposed || preparationTokenRef.current !== token) return;
        setCatalogCount(manifest.totalFaces);
        const indexFiles = manifest.indexFiles?.length
          ? manifest.indexFiles
          : manifest.indexFile
            ? [manifest.indexFile]
            : [...new Set(
                Object.values(manifest.cells).flatMap((cell) =>
                  cell.shards?.length
                    ? cell.shards
                    : cell.shard
                      ? [cell.shard]
                      : [],
                ),
              )];
        setCatalogFiles(indexFiles.length);
        const entries: CatalogEntry[] = [];
        for (let index = 0; index < indexFiles.length; index += 2) {
          const batch = indexFiles.slice(index, index + 2);
          const payloads = await Promise.all(
            batch.map(async (file) => {
              const catalog =
                manifest.catalogId || manifest.generatedAt || "current";
              const endpoint = manifest.indexFiles?.length || manifest.indexFile
                ? `/api/catalog/index?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`
                : `/api/catalog/shard?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`;
              const response = await fetch(endpoint, { cache: "force-cache" });
              if (!response.ok) throw new Error(`INDEX ${response.status}`);
              return response.json() as Promise<{ items?: CatalogEntry[] }>;
            }),
          );
          payloads.forEach((payload) => entries.push(...(payload.items ?? [])));
          if (!disposed && preparationTokenRef.current === token) {
            setCatalogLoaded(Math.min(index + batch.length, indexFiles.length));
          }
          await nextTask();
        }
        const candidates = [
          ...new Map(entries.map((entry) => [entry.id, entry])).values(),
        ].flatMap((entry) => {
          const candidate = candidateFromEntry(entry);
          return candidate ? [candidate] : [];
        });
        if (candidates.length < 4) {
          throw new Error("骨格比較できる顔素材がありません");
        }
        if (disposed || preparationTokenRef.current !== token) return;
        candidatesRef.current = candidates;
        setCandidateCount(candidates.length);
        setCatalogReady(true);
      } catch (caught) {
        const failure = caught instanceof Error
          ? caught
          : new Error("顔カタログの準備に失敗しました");
        preparationErrorRef.current = failure;
        if (!disposed) {
          setError(failure.message);
          setPhase("error");
        }
      }
    }

    async function prepareEngine() {
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
        if (disposed || preparationTokenRef.current !== token) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setEngineReady(true);
      } catch (caught) {
        const failure = caught instanceof Error
          ? caught
          : new Error("顔追跡エンジンの準備に失敗しました");
        preparationErrorRef.current = failure;
        if (!disposed) {
          setError(failure.message);
          setPhase("error");
        }
      }
    }

    void prepareCatalog();
    void prepareEngine();

    return () => {
      disposed = true;
      preparationTokenRef.current += 1;
      processingTokenRef.current += 1;
      cleanupRecording();
      cleanupReview();
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [cleanupRecording, cleanupReview]);

  useEffect(() => {
    if (
      phase === "preparing" &&
      engineReady &&
      catalogReady
    ) {
      setPhase("ready");
    }
  }, [catalogReady, engineReady, phase]);

  const waitUntilPrepared = useCallback(async (token: number) => {
    while (
      processingTokenRef.current === token &&
      (!landmarkerRef.current || candidatesRef.current.length < 4)
    ) {
      if (preparationErrorRef.current) throw preparationErrorRef.current;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) {
      throw new DOMException("Cancelled", "AbortError");
    }
  }, []);

  const preloadReviewImages = useCallback(async (
    choices: ReviewChoice[],
    token: number,
  ) => {
    const unique = [...new Map(
      choices.map((choice) => [choice.candidate.id, choice.candidate]),
    ).values()];
    outputImagesRef.current.clear();
    let next = 0;
    let completed = 0;
    let failures = 0;
    const worker = async () => {
      while (processingTokenRef.current === token) {
        const index = next;
        next += 1;
        if (index >= unique.length) return;
        const candidate = unique[index];
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
          total: unique.length,
          label: "選択済みの顔を再生前にデコード中",
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(8, unique.length) }, () => worker()),
    );
    setImageFailures(failures);
  }, []);

  const processCapturedClip = useCallback(async (
    frames: CapturedFrame[],
    token: number,
  ) => {
    setPhase("waiting");
    setProgress({
      done: 0,
      total: 1,
      label: "動画版と同じ解析エンジンと全カタログを待機中",
    });
    await waitUntilPrepared(token);
    const landmarker = landmarkerRef.current;
    const candidates = candidatesRef.current;
    if (!landmarker || candidates.length < 4) {
      throw new Error("解析エンジンまたは顔カタログがありません");
    }

    setPhase("analyzing");
    const started = performance.now();
    const sequenceFrames: SequenceFrame[] = [];
    const rankedBeams: Array<Array<{
      candidate: Candidate;
      error: ProjectionError;
    }>> = [];
    let comparisons = 0;

    for (let index = 0; index < frames.length; index += 1) {
      if (processingTokenRef.current !== token) {
        throw new DOMException("Cancelled", "AbortError");
      }
      const captured = frames[index];
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(captured.blob);
        const result = landmarker.detect(bitmap);
        const landmarks = result.faceLandmarks[0];
        if (landmarks && result.faceBlendshapes.length) {
          const geometry = faceGeometryFromLandmarks(
            landmarks,
            bitmap.width && bitmap.height ? bitmap.width / bitmap.height : 1,
          );
          if (geometry) {
            const frame: SequenceFrame = {
              time: captured.time,
              feature: featureFromResult(result),
              geometry,
            };
            const local = localCandidates(frame, candidates);
            const ranked = rankProjectionCandidateModesTwoStage(
              frame,
              local,
              INDEX_BEAM_PER_FRAME,
              Math.min(1_024, local.length),
            ).strict;
            if (ranked.length) {
              sequenceFrames.push(frame);
              rankedBeams.push(ranked);
              comparisons += local.length;
            }
          }
        }
      } finally {
        bitmap?.close();
      }
      setProgress({
        done: index + 1,
        total: frames.length,
        label: `5秒クリップを動画版strictで照合中 · ${comparisons.toLocaleString()} comparisons`,
      });
      await nextTask();
    }

    if (sequenceFrames.length < 2 || rankedBeams.length !== sequenceFrames.length) {
      throw new Error("5秒クリップから比較可能な顔フレームを作れませんでした");
    }
    setFaceFrames(sequenceFrames.length);
    setPhase("optimizing");
    setProgress({
      done: 0,
      total: sequenceFrames.length,
      label: "5秒全体を見て動画版と同じstrict経路を最適化中",
    });
    await nextTask();
    const choices = optimizeDistinctProjectionSequence(
      sequenceFrames,
      rankedBeams,
      STRICT_SEQUENCE_OPTIONS,
    );
    if (choices.length !== sequenceFrames.length) {
      throw new Error("動画版strict経路を確定できませんでした");
    }
    const timeline = choices.map((choice) => ({
      time: choice.frame.time,
      choice,
    }));
    sequenceRef.current = timeline;
    const changes = choices.reduce(
      (count, choice, index) =>
        count + (index > 0 && choices[index - 1]?.candidate.id !== choice.candidate.id ? 1 : 0),
      0,
    );
    setOutputChanges(changes);
    setUniqueFaces(new Set(choices.map((choice) => choice.candidate.id)).size);

    setPhase("preloading");
    setProgress({
      done: 0,
      total: new Set(choices.map((choice) => choice.candidate.id)).size,
      label: "選択済みの顔を再生前にデコード中",
    });
    await preloadReviewImages(choices, token);
    if (processingTokenRef.current !== token) {
      throw new DOMException("Cancelled", "AbortError");
    }
    const elapsed = performance.now() - started;
    setProcessingMs(elapsed);
    setProgress(null);
    setPhase("review");
    setPlaybackTime(0);
    const video = playbackVideoRef.current;
    if (video) {
      video.currentTime = 0;
      drawReviewAt(0);
      try {
        await video.play();
      } catch {
        // User can press play if the browser blocks delayed autoplay.
      }
    }
  }, [drawReviewAt, preloadReviewImages, waitUntilPrepared]);

  const recordAndReview = useCallback(async () => {
    if (
      phase === "recording" ||
      phase === "waiting" ||
      phase === "analyzing" ||
      phase === "optimizing" ||
      phase === "preloading"
    ) {
      return;
    }
    cleanupRecording();
    cleanupReview();
    const token = processingTokenRef.current + 1;
    processingTokenRef.current = token;
    setError(null);
    setProgress(null);
    setProcessingMs(0);
    setFaceFrames(0);
    setOutputChanges(0);
    setUniqueFaces(0);
    setImageFailures(0);
    setPlaybackTime(0);
    setCurrentOutputName("—");
    setCurrentOutputSource("—");
    setCurrentError(null);
    setCapturedFrames(0);
    setCapturedGaps(0);
    setRecordingRemaining(CAPTURE_SECONDS);
    capturedFramesRef.current = [];
    recorderChunksRef.current = [];
    firstMediaTimeRef.current = null;
    previousMediaTimeRef.current = null;
    sourceGapRef.current = 0;

    try {
      if (typeof MediaRecorder === "undefined") {
        throw new Error("このブラウザは5秒レビュー録画に対応していません");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: CAPTURE_FPS, max: CAPTURE_FPS },
        },
        audio: false,
      });
      streamRef.current = stream;
      const preview = previewVideoRef.current as VideoWithFrameCallback | null;
      if (!preview) throw new Error("CAMERA PREVIEW MISSING");
      preview.srcObject = stream;
      preview.muted = true;
      preview.playsInline = true;
      await preview.play();

      const mimeType = chooseRecorderMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined,
      );
      const recorderStopped = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) recorderChunksRef.current.push(event.data);
        };
        recorder.onerror = () => reject(new Error("カメラ映像の録画に失敗しました"));
        recorder.onstop = () => {
          const blob = new Blob(
            recorderChunksRef.current,
            { type: recorder.mimeType || "video/webm" },
          );
          if (!blob.size) reject(new Error("録画映像が空でした"));
          else resolve(blob);
        };
      });

      if (!captureCanvasRef.current) {
        captureCanvasRef.current = document.createElement("canvas");
      }
      captureChainRef.current = Promise.resolve();
      captureActiveRef.current = true;
      captureStartedAtRef.current = performance.now();
      setPhase("recording");
      recorder.start(250);

      const captureFrame = (now: number, metadata: VideoFrameMetadata) => {
        if (!captureActiveRef.current) return;
        const mediaTime = Number.isFinite(metadata.mediaTime)
          ? Number(metadata.mediaTime)
          : (now - captureStartedAtRef.current) / 1_000;
        if (firstMediaTimeRef.current === null) {
          firstMediaTimeRef.current = mediaTime;
        }
        const relativeTime = Math.max(
          0,
          mediaTime - Number(firstMediaTimeRef.current ?? mediaTime),
        );
        sourceGapRef.current += sourceGapEstimate(
          previousMediaTimeRef.current,
          mediaTime,
          CAPTURE_FPS,
        );
        previousMediaTimeRef.current = mediaTime;
        const bitmapPromise = createImageBitmap(preview);
        captureChainRef.current = captureChainRef.current.then(async () => {
          const bitmap = await bitmapPromise;
          try {
            const scale = Math.min(
              1,
              CAPTURE_SIZE / Math.max(bitmap.width, bitmap.height),
            );
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = captureCanvasRef.current as HTMLCanvasElement;
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("CAPTURE CANVAS UNAVAILABLE");
            context.drawImage(
              bitmap,
              0,
              0,
              bitmap.width,
              bitmap.height,
              0,
              0,
              width,
              height,
            );
            const blob = await canvasToBlob(canvas);
            capturedFramesRef.current.push({ blob, time: relativeTime });
            setCapturedFrames(capturedFramesRef.current.length);
            setCapturedGaps(sourceGapRef.current);
          } finally {
            bitmap.close();
          }
        });
        const elapsed = (now - captureStartedAtRef.current) / 1_000;
        setRecordingRemaining(Math.max(0, CAPTURE_SECONDS - elapsed));
        if (preview.requestVideoFrameCallback) {
          captureFrameCallbackRef.current = preview.requestVideoFrameCallback(captureFrame);
        } else {
          captureFrameCallbackRef.current = requestAnimationFrame((nextNow) =>
            captureFrame(nextNow, {
              mediaTime: (nextNow - captureStartedAtRef.current) / 1_000,
            })
          );
        }
      };
      if (preview.requestVideoFrameCallback) {
        captureFrameCallbackRef.current = preview.requestVideoFrameCallback(captureFrame);
      } else {
        captureFrameCallbackRef.current = requestAnimationFrame((now) =>
          captureFrame(now, { mediaTime: 0 })
        );
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, CAPTURE_SECONDS * 1_000);
      });
      captureActiveRef.current = false;
      if (
        captureFrameCallbackRef.current !== null &&
        preview.cancelVideoFrameCallback
      ) {
        preview.cancelVideoFrameCallback(captureFrameCallbackRef.current);
      } else if (captureFrameCallbackRef.current !== null) {
        cancelAnimationFrame(captureFrameCallbackRef.current);
      }
      captureFrameCallbackRef.current = null;
      recorder.stop();
      const [recordingBlob] = await Promise.all([
        recorderStopped,
        captureChainRef.current,
      ]);
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      preview.srcObject = null;

      if (capturedFramesRef.current.length < 2) {
        throw new Error("5秒レビュー用のフレームを取得できませんでした");
      }
      const lastFrame = capturedFramesRef.current.at(-1);
      const duration = Math.max(
        0.1,
        Number(lastFrame?.time ?? CAPTURE_SECONDS),
      );
      setClipDuration(duration);
      const playback = playbackVideoRef.current;
      if (!playback) throw new Error("REVIEW VIDEO MISSING");
      recordingUrlRef.current = URL.createObjectURL(recordingBlob);
      playback.src = recordingUrlRef.current;
      playback.muted = true;
      playback.playsInline = true;
      playback.load();
      await waitForVideoMetadata(playback);
      await processCapturedClip(
        [...capturedFramesRef.current],
        token,
      );
    } catch (caught) {
      cleanupRecording();
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      console.error("Five-second faithful review failed.", caught);
      const message = caught instanceof Error
        ? caught.message
        : "5秒レビューを作れませんでした";
      setError(message);
      setProgress(null);
      setPhase("error");
    }
  }, [
    cleanupRecording,
    cleanupReview,
    phase,
    processCapturedClip,
  ]);

  const togglePlayback = useCallback(async () => {
    const video = playbackVideoRef.current;
    if (!video || phase !== "review") return;
    if (video.paused) {
      if (video.ended || video.currentTime >= clipDuration - 0.01) {
        video.currentTime = 0;
        drawReviewAt(0);
      }
      try {
        await video.play();
      } catch {
        // The button itself is the user gesture; failures are still harmless.
      }
    } else {
      video.pause();
    }
  }, [clipDuration, drawReviewAt, phase]);

  const seekReview = useCallback((time: number) => {
    const video = playbackVideoRef.current;
    if (!video) return;
    const next = clamp(time, 0, clipDuration);
    video.currentTime = next;
    setPlaybackTime(next);
    drawReviewAt(next);
  }, [clipDuration, drawReviewAt]);

  const busy = [
    "recording",
    "waiting",
    "analyzing",
    "optimizing",
    "preloading",
  ].includes(phase);
  const readiness = engineReady && catalogReady;
  const ratio = processingSecondsPerOutputSecond(processingMs, clipDuration);
  const progressPercent = progress?.total
    ? Math.round(progress.done / progress.total * 100)
    : 0;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p>MANY FACES / FIVE-SECOND REVIEW</p>
          <h1>処理時間と再生時間を分離する。</h1>
        </div>
        <nav className={styles.nav}>
          <Link href="/">VIDEO LAB</Link>
          <Link href="/live/fifo">FIFO LIVE</Link>
          <Link href="/live/fast">FAST LIVE</Link>
          <Link href="/live/legacy">LEGACY</Link>
          <span>{phase.toUpperCase()}</span>
        </nav>
      </header>

      <section className={styles.reviewGrid}>
        <article className={styles.pane}>
          <div className={styles.paneHeader}>
            <span>SOURCE / RECORDED CAMERA</span>
            <b>{playbackTime.toFixed(2)} / {clipDuration.toFixed(2)} s</b>
          </div>
          <div className={styles.viewport}>
            {phase === "recording" ? (
              <video
                ref={previewVideoRef}
                className={styles.media}
                muted
                playsInline
              />
            ) : (
              <video
                ref={playbackVideoRef}
                className={styles.media}
                muted
                playsInline
                onPlay={() => {
                  setPlaying(true);
                  startPlaybackLoop();
                }}
                onPause={() => {
                  setPlaying(false);
                  stopPlaybackLoop();
                  const video = playbackVideoRef.current;
                  if (video) {
                    setPlaybackTime(video.currentTime);
                    drawReviewAt(video.currentTime);
                  }
                }}
                onEnded={() => {
                  setPlaying(false);
                  stopPlaybackLoop();
                  setPlaybackTime(clipDuration);
                  drawReviewAt(clipDuration);
                }}
                onSeeked={() => {
                  const video = playbackVideoRef.current;
                  if (video) drawReviewAt(video.currentTime);
                }}
              />
            )}
            {phase === "recording" && (
              <div className={styles.recordingBadge}>
                REC {recordingRemaining.toFixed(1)}s
              </div>
            )}
          </div>
        </article>

        <article className={styles.pane}>
          <div className={styles.paneHeader}>
            <span>OFFLINE-STRICT RESULT</span>
            <b>{replayFps} fps playback</b>
          </div>
          <div className={styles.viewport}>
            <canvas
              ref={outputCanvasRef}
              className={styles.canvas}
              width={768}
              height={512}
            />
            {phase !== "review" && (
              <div className={styles.overlayMessage}>
                <strong>{phase.toUpperCase()}</strong>
                <span>
                  {phase === "recording"
                    ? "5秒を記録中"
                    : progress?.label || "5秒ぶんを処理すると、ここで実時間再生します"}
                </span>
              </div>
            )}
          </div>
          <div className={styles.outputMeta}>
            <span>{currentOutputName}</span>
            <b>{currentOutputSource}</b>
          </div>
        </article>
      </section>

      <section className={styles.controls}>
        <div className={styles.primaryControls}>
          <button type="button" onClick={recordAndReview} disabled={busy}>
            {phase === "review" || phase === "error"
              ? "5秒を録り直す"
              : "5秒を録画して動画版処理"}
          </button>
          <button type="button" onClick={togglePlayback} disabled={phase !== "review"}>
            {playing ? "一時停止" : "再生"}
          </button>
          <button
            type="button"
            onClick={() => seekReview(playbackTime - 1 / replayFps)}
            disabled={phase !== "review"}
          >
            1フレーム戻る
          </button>
          <button
            type="button"
            onClick={() => seekReview(playbackTime + 1 / replayFps)}
            disabled={phase !== "review"}
          >
            1フレーム進む
          </button>
          <label>
            出力再生
            <select
              value={replayFps}
              onChange={(event) => {
                const next = Number(event.target.value);
                setReplayFps(next);
                replayFpsRef.current = next;
                drawReviewAt(playbackVideoRef.current?.currentTime ?? 0);
              }}
              disabled={phase !== "review"}
            >
              <option value="12">12 fps</option>
              <option value="20">20 fps</option>
              <option value="30">30 fps</option>
            </select>
          </label>
        </div>

        <input
          className={styles.scrubber}
          type="range"
          min="0"
          max={Math.max(0.1, clipDuration)}
          step="0.001"
          value={Math.min(playbackTime, clipDuration)}
          onChange={(event) => seekReview(Number(event.target.value))}
          disabled={phase !== "review"}
          aria-label="レビュー再生位置"
        />

        {progress && (
          <div className={styles.progress}>
            <div>
              <span>{progress.label}</span>
              <b>{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</b>
            </div>
            <i style={{ width: `${progressPercent}%` }} />
          </div>
        )}

        {!readiness && !error && (
          <p className={styles.preparing}>
            カメラは先に録れます。解析は ENGINE {engineReady ? "READY" : "LOADING"} / CATALOG {catalogLoaded.toLocaleString()} / {catalogFiles.toLocaleString()} FILES の準備後に自動開始します。
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </section>

      <section className={styles.telemetry}>
        <div><span>CAPTURED</span><strong>{capturedFrames}</strong></div>
        <div><span>SOURCE GAPS</span><strong>{capturedGaps}</strong></div>
        <div><span>FACE FRAMES</span><strong>{faceFrames}</strong></div>
        <div><span>OUTPUT CHANGES</span><strong>{outputChanges}</strong></div>
        <div><span>UNIQUE FACES</span><strong>{uniqueFaces}</strong></div>
        <div><span>PROCESSING</span><strong>{(processingMs / 1_000).toFixed(1)} s</strong></div>
        <div><span>SECONDS / OUTPUT SECOND</span><strong>{ratio.toFixed(1)}×</strong></div>
        <div><span>IMAGE FAILURES</span><strong>{imageFailures}</strong></div>
        <div><span>STRICT ERROR</span><strong>{currentError?.strictTotal.toFixed(4) ?? "—"}</strong></div>
        <div><span>CATALOG</span><strong>{candidateCount.toLocaleString()} / {catalogCount.toLocaleString()}</strong></div>
      </section>

      <p className={styles.note}>
        この画面は5秒を全部取り終えてから、動画版と同じ3度量子化、同じ角度候補、同じ二段階3D投影比較、strict 64候補、別人制約、12フレームcooldown、5秒全体の経路最適化を実行します。処理に何分かかっても、結果は元の5秒へ圧縮して12・20・30fpsで再生するため、顔の流れを人間の目で確認できます。
      </p>
    </main>
  );
}
