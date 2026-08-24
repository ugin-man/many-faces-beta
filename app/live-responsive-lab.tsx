"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FaceLandmarker,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  calibrateExpressionFeature,
  createExpressionTracker,
  expressionLabel,
} from "./expression-matching";
import {
  FACE_ACTION_FEATURE_INDEX,
  faceFeatureFromScores,
} from "./face-actions";
import {
  createLandmarkPitchTracker,
  landmarkPitchDegrees,
} from "./landmark-pitch";
import {
  faceGeometryFromLandmarks,
  type FaceGeometry,
} from "./offline-matching";
import type { ProjectionRankMode } from "./projection-matching";
import {
  buildLiveCandidateIndex,
  liveCandidateFromEntry,
  rankLiveCandidates,
  type LiveCandidate,
  type LiveCatalogEntry,
} from "./live-matching";
import { LivePackedImageBuffer } from "./live-packed-image-buffer";
import {
  predictedPoseDegrees,
  ResponsiveSwitchController,
  selectReadyRankedCandidate,
} from "./live-responsive-runtime";
import styles from "./live-responsive-lab.module.css";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const DESKTOP_DETECTION_FPS = 28;
const MOBILE_DETECTION_FPS = 20;
const MAX_CACHED_SHARDS = 24;
const MAX_CURRENT_CELLS = 9;
const MAX_PREDICTED_CELLS = 6;
const MAX_CANDIDATE_POOL = 2_400;
const TELEMETRY_INTERVAL_MS = 250;
const RANK_BUDGET = 128;
const DETAILED_LIMIT = 48;

type CatalogManifest = {
  schemaVersion: 1 | 2 | 3;
  catalogId?: string;
  generatedAt?: string;
  totalFaces: number;
  poseStep: number;
  bounds: {
    yawMin: number;
    yawMax: number;
    pitchMin: number;
    pitchMax: number;
  };
  cells: Record<string, {
    count: number;
    shards?: string[];
    shard?: string;
  }>;
  stats?: {
    cleanCore?: {
      runtimeImagePolicy?: string;
      knownSyntheticFaces?: number;
    };
  };
};

type EngineState = "loading" | "ready" | "failed";
type CatalogState = "loading" | "ready" | "failed";
type InputKind = "camera" | "video" | null;

type DisplayFace = {
  candidate: LiveCandidate;
  url: string;
};

type LiveStats = {
  detectionFps: number;
  outputFps: number;
  targetOutputFps: number;
  searchMs: number;
  inspected: number;
  bucketHits: number;
  candidatePool: number;
  loadedShards: number;
  readyImages: number;
  loadedPacks: number;
  packMegabytes: number;
  movement: number;
};

type ScheduledFrame = {
  kind: "video" | "raf";
  id: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: unknown) => void,
  ) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

type WakeLockSentinel = {
  release(): Promise<void>;
};

const MIRRORED_ACTION_PAIRS = [
  ["eyeBlinkLeft", "eyeBlinkRight"],
  ["eyeSquintLeft", "eyeSquintRight"],
  ["eyeWideLeft", "eyeWideRight"],
  ["eyeLookDownLeft", "eyeLookDownRight"],
  ["eyeLookInLeft", "eyeLookInRight"],
  ["eyeLookOutLeft", "eyeLookOutRight"],
  ["eyeLookUpLeft", "eyeLookUpRight"],
  ["mouthSmileLeft", "mouthSmileRight"],
  ["mouthFrownLeft", "mouthFrownRight"],
  ["mouthStretchLeft", "mouthStretchRight"],
  ["browDownLeft", "browDownRight"],
  ["browOuterUpLeft", "browOuterUpRight"],
  ["cheekSquintLeft", "cheekSquintRight"],
  ["mouthDimpleLeft", "mouthDimpleRight"],
  ["mouthLowerDownLeft", "mouthLowerDownRight"],
  ["mouthPressLeft", "mouthPressRight"],
  ["mouthUpperUpLeft", "mouthUpperUpRight"],
  ["noseSneerLeft", "noseSneerRight"],
  ["jawLeft", "jawRight"],
  ["mouthLeft", "mouthRight"],
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isCatalogManifest(value: unknown): value is CatalogManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<CatalogManifest>;
  return (
    (manifest.schemaVersion === 1 || manifest.schemaVersion === 2 || manifest.schemaVersion === 3) &&
    Number.isFinite(manifest.totalFaces) &&
    Number(manifest.totalFaces) > 0 &&
    Number.isFinite(manifest.poseStep) &&
    Boolean(manifest.bounds) &&
    Boolean(manifest.cells) &&
    typeof manifest.cells === "object"
  );
}

function poseFromResult(result: FaceLandmarkerResult) {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  if (!matrix || matrix.length < 11) return [0, 0, 0];
  const pitch = Math.atan2(matrix[9], matrix[10]);
  const yaw = Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10]));
  const roll = Math.atan2(matrix[4], matrix[0]);
  return [
    clamp(yaw / (Math.PI / 2), -1, 1),
    clamp(pitch * 1.4 / (Math.PI / 2), -1, 1),
    clamp(roll / (Math.PI / 2), -1, 1),
  ];
}

function featureFromResult(
  result: FaceLandmarkerResult,
  landmarks: NormalizedLandmark[],
  pitchTracker: ReturnType<typeof createLandmarkPitchTracker>,
) {
  const scores = new Map(
    (result.faceBlendshapes[0]?.categories ?? []).map((category) => [
      category.categoryName,
      category.score,
    ]),
  );
  const pose = poseFromResult(result);
  const landmarkPitch = landmarkPitchDegrees(landmarks, pitchTracker, 1);
  if (landmarkPitch !== null) pose[1] = landmarkPitch / 90;
  return faceFeatureFromScores(pose, scores);
}

function copyVector(vector: ArrayLike<number>) {
  return Float32Array.from(vector, Number);
}

function mirrorFeature(feature: number[]) {
  const mirrored = [...feature];
  mirrored[0] *= -1;
  mirrored[2] *= -1;
  for (const [left, right] of MIRRORED_ACTION_PAIRS) {
    const leftIndex = FACE_ACTION_FEATURE_INDEX[left];
    const rightIndex = FACE_ACTION_FEATURE_INDEX[right];
    [mirrored[leftIndex], mirrored[rightIndex]] = [
      mirrored[rightIndex],
      mirrored[leftIndex],
    ];
  }
  return mirrored;
}

function mirrorGeometry(geometry: FaceGeometry): FaceGeometry {
  const structure = copyVector(geometry.structure);
  for (let index = 9; index < structure.length; index += 3) {
    structure[index] *= -1;
  }
  const surface = copyVector(geometry.surface);
  for (let index = 0; index < surface.length; index += 3) {
    surface[index] *= -1;
  }
  const projection = copyVector(geometry.projection);
  for (let index = 0; index < projection.length; index += 2) {
    projection[index] *= -1;
  }
  return {
    structure,
    surface,
    projection,
    layout: [
      1 - geometry.layout[0],
      geometry.layout[1],
      geometry.layout[2],
      geometry.layout[3],
    ],
  };
}

function smoothFeature(previous: number[] | null, next: number[]) {
  if (!previous || previous.length !== next.length) return [...next];
  return next.map((value, index) => {
    const previousWeight = index < 3 ? 0.43 : 0.22;
    return previous[index] * previousWeight + value * (1 - previousWeight);
  });
}

function smoothVector(
  previous: ArrayLike<number>,
  next: ArrayLike<number>,
  previousWeight: number,
) {
  if (previous.length !== next.length) return copyVector(next);
  return Float32Array.from(
    { length: next.length },
    (_, index) =>
      Number(previous[index]) * previousWeight +
      Number(next[index]) * (1 - previousWeight),
  );
}

function smoothGeometry(previous: FaceGeometry | null, next: FaceGeometry) {
  if (!previous) return next;
  return {
    structure: smoothVector(previous.structure, next.structure, 0.62),
    surface: next.surface,
    projection: smoothVector(previous.projection, next.projection, 0.18),
    layout: next.layout.map((value, index) =>
      previous.layout[index] * 0.3 + value * 0.7,
    ) as [number, number, number, number],
  };
}

function cellValue(value: number, min: number, max: number, step: number) {
  return clamp(Math.round(value / step) * step, min, max);
}

function nearbyCatalogCells(
  manifest: CatalogManifest,
  yaw: number,
  pitch: number,
  limit: number,
) {
  const centerYaw = cellValue(
    yaw,
    manifest.bounds.yawMin,
    manifest.bounds.yawMax,
    manifest.poseStep,
  );
  const centerPitch = cellValue(
    pitch,
    manifest.bounds.pitchMin,
    manifest.bounds.pitchMax,
    manifest.poseStep,
  );
  const cells: Array<{ key: string; distance: number }> = [];
  for (let yawOffset = -2; yawOffset <= 2; yawOffset += 1) {
    for (let pitchOffset = -3; pitchOffset <= 3; pitchOffset += 1) {
      const candidateYaw = centerYaw + yawOffset * manifest.poseStep;
      const candidatePitch = centerPitch + pitchOffset * manifest.poseStep;
      const key = `${candidateYaw}:${candidatePitch}`;
      if (!manifest.cells[key]) continue;
      cells.push({
        key,
        distance: yawOffset * yawOffset + pitchOffset * pitchOffset * 0.82,
      });
    }
  }
  return cells
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
    .map((item) => item.key);
}

function shardFilesForCells(manifest: CatalogManifest, cells: string[]) {
  return [...new Set(cells.flatMap((key) => {
    const cell = manifest.cells[key];
    return cell?.shards?.length
      ? cell.shards
      : cell?.shard
        ? [cell.shard]
        : [];
  }))];
}

function deterministicLimit<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  const output: T[] = [];
  const stride = items.length / limit;
  for (let index = 0; index < limit; index += 1) {
    output.push(items[Math.floor(index * stride)]);
  }
  return output;
}

function poseLabel(feature: number[] | null) {
  if (!feature) return "—";
  const [yaw, pitch, roll] = feature.slice(0, 3).map((value) => Math.round(value * 90));
  return `${yaw > 0 ? "+" : ""}${yaw} / ${pitch > 0 ? "+" : ""}${pitch} / ${roll > 0 ? "+" : ""}${roll}`;
}

function candidateSource(candidate: LiveCandidate | null) {
  if (!candidate) return "—";
  return candidate.sourceName || candidate.creator || "CATALOG";
}

export default function LiveResponsiveLab() {
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const trackingRef = useRef(false);
  const scheduledRef = useRef<ScheduledFrame | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);
  const lastDetectionAtRef = useRef(0);
  const lastFeatureAtRef = useRef(0);
  const detectionTimesRef = useRef<number[]>([]);
  const switchTimesRef = useRef<number[]>([]);
  const lastTelemetryAtRef = useRef(0);
  const targetDetectionFpsRef = useRef(DESKTOP_DETECTION_FPS);
  const maxOutputRateRef = useRef(20);

  const manifestRef = useRef<CatalogManifest | null>(null);
  const shardCacheRef = useRef(new Map<string, LiveCandidate[]>());
  const shardOrderRef = useRef<string[]>([]);
  const loadingShardsRef = useRef(new Set<string>());
  const neighborhoodTokenRef = useRef(0);
  const focusCellRef = useRef<string | null>(null);
  const candidateIndexRef = useRef<ReturnType<typeof buildLiveCandidateIndex> | null>(null);
  const candidatePoolRef = useRef<LiveCandidate[]>([]);

  const inputKindRef = useRef<InputKind>(null);
  const pitchTrackerRef = useRef(createLandmarkPitchTracker());
  const expressionTrackerRef = useRef(createExpressionTracker());
  const smoothedFeatureRef = useRef<number[] | null>(null);
  const smoothedGeometryRef = useRef<FaceGeometry | null>(null);
  const currentRef = useRef<LiveCandidate | null>(null);
  const currentDisplayRef = useRef<DisplayFace | null>(null);
  const recentIdsRef = useRef<string[]>([]);
  const imageBufferRef = useRef<LivePackedImageBuffer | null>(null);
  const switchControllerRef = useRef(new ResponsiveSwitchController());
  const previousClearTimerRef = useRef<number | null>(null);
  const modeRef = useRef<ProjectionRankMode>("strict");

  if (!imageBufferRef.current) {
    imageBufferRef.current = new LivePackedImageBuffer({
      maxImageUrls: 224,
      maxPackBytes: 40 * 1024 * 1024,
      preloadConcurrency: 4,
    });
  }

  const [engineState, setEngineState] = useState<EngineState>("loading");
  const [engineMessage, setEngineMessage] = useState("FACE LANDMARKERを準備中");
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [manifest, setManifest] = useState<CatalogManifest | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [inputKind, setInputKind] = useState<InputKind>(null);
  const [inputName, setInputName] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [liveFeature, setLiveFeature] = useState<number[] | null>(null);
  const [current, setCurrent] = useState<DisplayFace | null>(null);
  const [previous, setPrevious] = useState<DisplayFace | null>(null);
  const [mode, setMode] = useState<ProjectionRankMode>("strict");
  const [maxOutputRate, setMaxOutputRate] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<LiveStats>({
    detectionFps: 0,
    outputFps: 0,
    targetOutputFps: 0,
    searchMs: 0,
    inspected: 0,
    bucketHits: 0,
    candidatePool: 0,
    loadedShards: 0,
    readyImages: 0,
    loadedPacks: 0,
    packMegabytes: 0,
    movement: 0,
  });

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    maxOutputRateRef.current = maxOutputRate;
  }, [maxOutputRate]);

  useEffect(() => {
    targetDetectionFpsRef.current = window.matchMedia("(max-width: 760px), (pointer: coarse)").matches
      ? MOBILE_DETECTION_FPS
      : DESKTOP_DETECTION_FPS;
  }, []);

  const cancelScheduledFrame = useCallback(() => {
    const scheduled = scheduledRef.current;
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (!scheduled) return;
    if (scheduled.kind === "video" && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(scheduled.id);
    } else {
      cancelAnimationFrame(scheduled.id);
    }
    scheduledRef.current = null;
  }, []);

  const scheduleNextFrame = useCallback(() => {
    if (!trackingRef.current) return;
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (!video) return;
    if (video.requestVideoFrameCallback) {
      const id = video.requestVideoFrameCallback((now) => tickRef.current(now));
      scheduledRef.current = { kind: "video", id };
    } else {
      const id = requestAnimationFrame((now) => tickRef.current(now));
      scheduledRef.current = { kind: "raf", id };
    }
  }, []);

  const showReadyCandidate = useCallback((candidate: LiveCandidate, now: number) => {
    const buffer = imageBufferRef.current;
    const url = buffer?.urlFor(candidate);
    if (!url || candidate.id === currentRef.current?.id) return false;
    const oldDisplay = currentDisplayRef.current;
    currentRef.current = candidate;
    const nextDisplay = { candidate, url };
    currentDisplayRef.current = nextDisplay;
    setPrevious(oldDisplay);
    setCurrent(nextDisplay);
    recentIdsRef.current = [
      candidate.id,
      ...recentIdsRef.current.filter((id) => id !== candidate.id),
    ].slice(0, 12);
    switchTimesRef.current.push(now);
    while (switchTimesRef.current.length && switchTimesRef.current[0] < now - 1_000) {
      switchTimesRef.current.shift();
    }
    switchControllerRef.current.commitSwitch(now);
    if (previousClearTimerRef.current !== null) {
      window.clearTimeout(previousClearTimerRef.current);
    }
    previousClearTimerRef.current = window.setTimeout(() => {
      setPrevious(null);
      previousClearTimerRef.current = null;
    }, 90);
    return true;
  }, []);

  const rebuildCandidateIndex = useCallback((preferredShards: string[]) => {
    const ordered = [
      ...preferredShards,
      ...shardOrderRef.current.filter((file) => !preferredShards.includes(file)),
    ].filter((file, index, files) => files.indexOf(file) === index && shardCacheRef.current.has(file));
    const retained = ordered.slice(0, MAX_CACHED_SHARDS);
    for (const file of [...shardCacheRef.current.keys()]) {
      if (!retained.includes(file)) shardCacheRef.current.delete(file);
    }
    shardOrderRef.current = retained;
    const candidates = [...new Map(
      retained
        .flatMap((file) => shardCacheRef.current.get(file) ?? [])
        .map((candidate) => [candidate.id, candidate]),
    ).values()];
    const limited = deterministicLimit(candidates, MAX_CANDIDATE_POOL);
    candidatePoolRef.current = limited;
    candidateIndexRef.current = limited.length
      ? buildLiveCandidateIndex(limited)
      : null;
    setStats((value) => ({
      ...value,
      candidatePool: limited.length,
      loadedShards: retained.length,
    }));
  }, []);

  const loadCatalogNeighborhood = useCallback(async (
    yaw: number,
    pitch: number,
    predictedYaw: number,
    predictedPitch: number,
    force = false,
  ) => {
    const currentManifest = manifestRef.current;
    if (!currentManifest) return;
    const currentCells = nearbyCatalogCells(
      currentManifest,
      yaw,
      pitch,
      MAX_CURRENT_CELLS,
    );
    const predictedCells = nearbyCatalogCells(
      currentManifest,
      predictedYaw,
      predictedPitch,
      MAX_PREDICTED_CELLS,
    );
    const cells = [...new Set([...currentCells, ...predictedCells])];
    if (!cells.length) return;
    const focus = currentCells[0] ?? cells[0];
    const files = shardFilesForCells(currentManifest, cells);
    const complete = files.every((file) => shardCacheRef.current.has(file));
    if (!force && focusCellRef.current === focus && complete) return;
    focusCellRef.current = focus;
    const token = ++neighborhoodTokenRef.current;
    const missing = files.filter(
      (file) =>
        !shardCacheRef.current.has(file) &&
        !loadingShardsRef.current.has(file),
    );
    await Promise.allSettled(missing.map(async (file) => {
      loadingShardsRef.current.add(file);
      try {
        const version = currentManifest.catalogId || currentManifest.generatedAt || "current";
        const response = await fetch(
          `/api/catalog/shard?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(version)}`,
          { cache: "force-cache" },
        );
        if (!response.ok) throw new Error(`SHARD ${response.status}`);
        const payload = await response.json() as { items?: LiveCatalogEntry[] };
        const candidates = (payload.items ?? []).flatMap((entry) => {
          const candidate = liveCandidateFromEntry(entry, file);
          return candidate ? [candidate] : [];
        });
        shardCacheRef.current.set(file, candidates);
      } finally {
        loadingShardsRef.current.delete(file);
      }
    }));
    if (token !== neighborhoodTokenRef.current) return;
    rebuildCandidateIndex(files);
  }, [rebuildCandidateIndex]);

  const reloadCatalog = useCallback(async () => {
    setCatalogState("loading");
    try {
      const response = await fetch("/api/catalog/manifest", { cache: "no-store" });
      if (!response.ok) throw new Error(`CATALOG ${response.status}`);
      const payload: unknown = await response.json();
      if (!isCatalogManifest(payload)) throw new Error("INVALID CATALOG");
      manifestRef.current = payload;
      setManifest(payload);
      setCatalogState("ready");
      await loadCatalogNeighborhood(0, 0, 0, 0, true);
    } catch (caught) {
      console.error("Responsive catalog load failed.", caught);
      setCatalogState("failed");
      setError("顔カタログを読み込めませんでした。再読み込みしてください。");
    }
  }, [loadCatalogNeighborhood]);

  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);

  useEffect(() => {
    let disposed = false;
    async function prepareEngine() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const sharedOptions = {
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
            ...sharedOptions,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          });
          if (!disposed) setEngineMessage("GPU TRACKING READY");
        } catch (gpuError) {
          console.warn("GPU delegate unavailable; using CPU.", gpuError);
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...sharedOptions,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          });
          if (!disposed) setEngineMessage("CPU TRACKING READY");
        }
        if (disposed) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setEngineState("ready");
      } catch (caught) {
        console.error("Face Landmarker setup failed.", caught);
        if (!disposed) {
          setEngineState("failed");
          setEngineMessage("TRACKING ENGINE OFFLINE");
          setError("顔追跡エンジンを読み込めませんでした。");
        }
      }
    }
    void prepareEngine();
    return () => {
      disposed = true;
      trackingRef.current = false;
      cancelScheduledFrame();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      landmarkerRef.current?.close();
      imageBufferRef.current?.clear();
      void wakeLockRef.current?.release().catch(() => undefined);
      if (previousClearTimerRef.current !== null) {
        window.clearTimeout(previousClearTimerRef.current);
      }
    };
  }, [cancelScheduledFrame]);

  const resetTrackingState = useCallback(() => {
    pitchTrackerRef.current = createLandmarkPitchTracker();
    expressionTrackerRef.current = createExpressionTracker();
    smoothedFeatureRef.current = null;
    smoothedGeometryRef.current = null;
    detectionTimesRef.current = [];
    switchTimesRef.current = [];
    lastDetectionAtRef.current = 0;
    lastFeatureAtRef.current = 0;
    recentIdsRef.current = [];
    switchControllerRef.current.reset(performance.now());
    setLiveFeature(null);
    setCalibrating(true);
  }, []);

  const stop = useCallback(async () => {
    trackingRef.current = false;
    cancelScheduledFrame();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    if (landmarkerRef.current) {
      await landmarkerRef.current.setOptions({ runningMode: "IMAGE" });
    }
    await wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    inputKindRef.current = null;
    setInputKind(null);
    setInputName(null);
    setIsRunning(false);
    setCalibrating(false);
  }, [cancelScheduledFrame]);

  const updateTelemetry = useCallback((
    now: number,
    searchMs: number,
    inspected: number,
    bucketHits: number,
    targetOutputFps: number,
    movement: number,
  ) => {
    const detections = detectionTimesRef.current;
    detections.push(now);
    while (detections.length && detections[0] < now - 1_000) detections.shift();
    while (switchTimesRef.current.length && switchTimesRef.current[0] < now - 1_000) {
      switchTimesRef.current.shift();
    }
    if (now - lastTelemetryAtRef.current < TELEMETRY_INTERVAL_MS) return;
    lastTelemetryAtRef.current = now;
    const buffer = imageBufferRef.current?.stats();
    setStats({
      detectionFps: detections.length,
      outputFps: switchTimesRef.current.length,
      targetOutputFps,
      searchMs,
      inspected,
      bucketHits,
      candidatePool: candidatePoolRef.current.length,
      loadedShards: shardCacheRef.current.size,
      readyImages: buffer?.readyImages ?? 0,
      loadedPacks: buffer?.loadedPacks ?? 0,
      packMegabytes: (buffer?.packBytes ?? 0) / (1024 * 1024),
      movement,
    });
    setLiveFeature(smoothedFeatureRef.current ? [...smoothedFeatureRef.current] : null);
  }, []);

  const processFrame = useCallback((now: number) => {
    if (!trackingRef.current) return;
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    try {
      const interval = 1_000 / targetDetectionFpsRef.current;
      if (!video || !landmarker || now - lastDetectionAtRef.current < interval) return;
      lastDetectionAtRef.current = now;
      if (video.readyState < 2) return;
      const result = landmarker.detectForVideo(video, now);
      const landmarks = result.faceLandmarks[0];
      if (!landmarks || !result.faceBlendshapes.length) {
        updateTelemetry(now, 0, 0, 0, 0, 0);
        return;
      }
      const geometry = faceGeometryFromLandmarks(
        landmarks,
        video.videoWidth && video.videoHeight
          ? video.videoWidth / video.videoHeight
          : 1,
      );
      if (!geometry) return;
      let feature = featureFromResult(result, landmarks, pitchTrackerRef.current);
      feature = calibrateExpressionFeature(feature, expressionTrackerRef.current);
      let frameGeometry = geometry;
      if (inputKindRef.current === "camera") {
        feature = mirrorFeature(feature);
        frameGeometry = mirrorGeometry(frameGeometry);
      }

      const previousFeature = smoothedFeatureRef.current;
      const elapsedFeature = lastFeatureAtRef.current
        ? now - lastFeatureAtRef.current
        : 16;
      const smoothedFeature = smoothFeature(previousFeature, feature);
      const smoothedGeometry = smoothGeometry(smoothedGeometryRef.current, frameGeometry);
      const predicted = predictedPoseDegrees(
        previousFeature,
        smoothedFeature,
        elapsedFeature,
        120,
      );
      smoothedFeatureRef.current = smoothedFeature;
      smoothedGeometryRef.current = smoothedGeometry;
      lastFeatureAtRef.current = now;

      if (
        expressionTrackerRef.current.frames >= 12 &&
        pitchTrackerRef.current.calibrationFrames >= 12
      ) {
        setCalibrating(false);
      }

      void loadCatalogNeighborhood(
        smoothedFeature[0] * 90,
        smoothedFeature[1] * 90,
        predicted.yaw,
        predicted.pitch,
      );

      const searchStarted = performance.now();
      const ranked = rankLiveCandidates(
        candidateIndexRef.current,
        { feature: smoothedFeature, geometry: smoothedGeometry },
        {
          mode: modeRef.current,
          budget: RANK_BUDGET,
          detailedLimit: DETAILED_LIMIT,
          currentId: currentRef.current?.id,
          recentIds: recentIdsRef.current,
          holdBias: 0.001,
          diversityPenalty: 0.004,
          hysteresis: 0.001,
        },
      );
      const searchMs = performance.now() - searchStarted;
      const candidates = ranked.ranked.map((item) => item.candidate);
      const buffer = imageBufferRef.current;
      if (buffer && candidates.length) {
        void buffer.prime(candidates, {
          maxImages: 36,
          maxNewPacks: 2,
        });
      }

      const decision = switchControllerRef.current.observe(
        now,
        smoothedFeature,
        maxOutputRateRef.current,
      );
      const selected = buffer
        ? selectReadyRankedCandidate(
            ranked.ranked,
            (candidate) => buffer.isReady(candidate),
            currentRef.current?.id ?? null,
            recentIdsRef.current.slice(0, 4),
          )
        : null;

      if (!currentRef.current && ranked.ranked[0] && buffer) {
        const first = ranked.ranked[0].candidate;
        if (buffer.isReady(first)) {
          showReadyCandidate(first, now);
        } else {
          void buffer.ensure(first).then((url) => {
            if (url && trackingRef.current && !currentRef.current) {
              showReadyCandidate(first, performance.now());
            }
          });
        }
      } else if (
        decision.shouldSwitch &&
        selected &&
        selected.candidate.id !== currentRef.current?.id
      ) {
        showReadyCandidate(selected.candidate, now);
      }

      updateTelemetry(
        now,
        searchMs,
        ranked.inspected,
        ranked.bucketHits,
        decision.targetRate,
        decision.total,
      );
    } catch (caught) {
      console.error("Responsive live frame failed.", caught);
    } finally {
      scheduleNextFrame();
    }
  }, [loadCatalogNeighborhood, scheduleNextFrame, showReadyCandidate, updateTelemetry]);

  useEffect(() => {
    tickRef.current = processFrame;
  }, [processFrame]);

  const beginTracking = useCallback(async (kind: Exclude<InputKind, null>, name: string) => {
    const landmarker = landmarkerRef.current;
    const video = videoRef.current;
    if (!landmarker || !video || !candidateIndexRef.current?.size) {
      throw new Error("顔追跡またはカタログがまだ準備中です");
    }
    await landmarker.setOptions({ runningMode: "VIDEO" });
    inputKindRef.current = kind;
    setInputKind(kind);
    setInputName(name);
    currentRef.current = null;
    currentDisplayRef.current = null;
    setCurrent(null);
    setPrevious(null);
    resetTrackingState();
    setIsRunning(true);
    trackingRef.current = true;
    try {
      const wakeLock = (
        navigator as Navigator & {
          wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
        }
      ).wakeLock;
      wakeLockRef.current = await wakeLock?.request("screen") ?? null;
    } catch {
      wakeLockRef.current = null;
    }
    scheduleNextFrame();
  }, [resetTrackingState, scheduleNextFrame]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (isRunning) await stop();
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
      const video = videoRef.current;
      if (!video) throw new Error("カメラ表示を準備できませんでした");
      video.removeAttribute("src");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await beginTracking("camera", "FRONT CAMERA");
    } catch (caught) {
      console.error("Camera start failed.", caught);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError("カメラを開始できませんでした。ブラウザのカメラ許可を確認してください。");
    }
  }, [beginTracking, isRunning, stop]);

  const startVideo = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    if (isRunning) await stop();
    try {
      const video = videoRef.current;
      if (!video) throw new Error("動画表示を準備できませんでした");
      const url = URL.createObjectURL(file);
      videoUrlRef.current = url;
      video.srcObject = null;
      video.src = url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("VIDEO TIMEOUT")), 8_000);
        const ready = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        video.addEventListener("loadeddata", ready, { once: true });
        video.addEventListener("error", () => reject(new Error("VIDEO ERROR")), { once: true });
        video.load();
      });
      await video.play();
      await beginTracking("video", file.name);
    } catch (caught) {
      console.error("Video start failed.", caught);
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
      setError("この動画を再生できませんでした。MP4、MOV、WebMで試してください。");
    }
  }, [beginTracking, isRunning, stop]);

  const ready = engineState === "ready" && catalogState === "ready" && stats.candidatePool > 0;
  const cleanCore = manifest?.stats?.cleanCore;
  const status = useMemo(() => {
    if (engineState === "loading") return "ENGINE LOADING";
    if (engineState === "failed") return "ENGINE OFFLINE";
    if (catalogState === "loading") return "CATALOG LOADING";
    if (catalogState === "failed") return "CATALOG OFFLINE";
    if (isRunning) return "MOTION-DRIVEN LIVE";
    return "READY";
  }, [catalogState, engineState, isRunning]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p>MANY FACES / RESPONSIVE LIVE</p>
          <h1>止まれば固定。動けば、その軌道を別人が追う。</h1>
        </div>
        <div className={styles.headerActions}>
          <Link href="/">OFFLINE</Link>
          <Link href="/live/legacy">LEGACY LIVE</Link>
          <span className={styles.status}><i />{status}</span>
        </div>
      </header>

      <section className={styles.stageGrid}>
        <div className={styles.stage}>
          {previous && (
            <img
              className={`${styles.outputFace} ${styles.previousFace}`}
              src={previous.url}
              alt="直前の顔"
              draggable={false}
            />
          )}
          {current ? (
            <img
              key={current.candidate.id}
              className={`${styles.outputFace} ${styles.currentFace}`}
              src={current.url}
              alt="現在の動きに近い別人の顔"
              draggable={false}
            />
          ) : (
            <div className={styles.emptyStage}>
              <span />
              <strong>{ready ? "CAMERA OR VIDEO" : "PREPARING"}</strong>
              <small>{ready ? "入力を選ぶと動き量ベースで追従します" : `${engineMessage} / カタログ準備中`}</small>
            </div>
          )}
          <div className={styles.stageMeta}>
            <span>{current?.candidate.name ?? "NO FACE SELECTED"}</span>
            <b>{candidateSource(current?.candidate ?? null)}</b>
          </div>
          <div className={`${styles.inputMonitor} ${isRunning ? styles.inputMonitorActive : ""}`}>
            <span>INPUT / {inputName ?? "—"}</span>
            <video
              ref={videoRef}
              className={inputKind === "camera" ? styles.mirrored : ""}
              muted
              playsInline
              controls={inputKind === "video"}
            />
          </div>
          {isRunning && calibrating && (
            <div className={styles.calibration}>
              <strong>正面・無表情を約0.4秒</strong>
              <span>CALIBRATING</span>
            </div>
          )}
        </div>

        <aside className={styles.telemetry}>
          <div><span>POSE Y / P / R</span><strong>{poseLabel(liveFeature)}</strong></div>
          <div><span>EXPRESSION</span><strong>{expressionLabel(liveFeature)}</strong></div>
          <div><span>DETECTION</span><strong>{stats.detectionFps} FPS</strong></div>
          <div><span>OUTPUT</span><strong>{stats.outputFps} FPS</strong></div>
          <div><span>TARGET</span><strong>{stats.targetOutputFps.toFixed(1)} FPS</strong></div>
          <div><span>SEARCH</span><strong>{stats.searchMs.toFixed(1)} ms</strong></div>
          <div><span>MOTION</span><strong>{stats.movement.toFixed(2)}</strong></div>
          <div><span>READY IMAGES</span><strong>{stats.readyImages}</strong></div>
          <div><span>PACK BUFFER</span><strong>{stats.loadedPacks} / {stats.packMegabytes.toFixed(1)} MB</strong></div>
          <div><span>LOCAL POOL</span><strong>{stats.candidatePool}</strong></div>
          <div><span>SHARDS</span><strong>{stats.loadedShards}</strong></div>
          <div><span>CATALOG</span><strong>{manifest?.totalFaces.toLocaleString() ?? "—"}</strong></div>
        </aside>
      </section>

      <section className={styles.controls}>
        <div className={styles.primaryControls}>
          <button type="button" onClick={startCamera} disabled={!ready || isRunning}>
            カメラを開始
          </button>
          <label className={!ready || isRunning ? styles.disabled : ""}>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/*"
              onChange={startVideo}
              disabled={!ready || isRunning}
            />
            動画で試す
          </label>
          <button type="button" onClick={stop} disabled={!isRunning} className={styles.stopButton}>
            停止
          </button>
        </div>

        <div className={styles.settings}>
          <label>
            <span>一致方式</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as ProjectionRankMode)}>
              <option value="strict">全体の最悪値を抑える</option>
              <option value="mouth">口を優先</option>
              <option value="eyes">目・眉を優先</option>
              <option value="semantic">表情動作を優先</option>
              <option value="balanced">輪郭を優先</option>
            </select>
          </label>
          <label>
            <span>動作中の最大追従</span>
            <input
              type="range"
              min="12"
              max="20"
              step="1"
              value={maxOutputRate}
              onChange={(event) => setMaxOutputRate(Number(event.target.value))}
            />
            <b>{maxOutputRate} / 秒</b>
          </label>
          <button type="button" onClick={resetTrackingState} disabled={!isRunning}>
            正面・無表情を再設定
          </button>
        </div>

        <div className={styles.behaviorNote}>
          <strong>固定タイマーでは切り替えない</strong>
          <span>静止中は同じ顔を保持。動きが始まると、小さな変化を累積して10〜{maxOutputRate}fpsで追従します。</span>
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </section>

      <section className={styles.catalogPanel}>
        <div>
          <span>CATALOG</span>
          <strong>{manifest?.catalogId ?? "—"}</strong>
        </div>
        <div>
          <span>POSE GRID</span>
          <strong>{manifest ? `${Object.keys(manifest.cells).length} cells / ${manifest.poseStep}°` : "—"}</strong>
        </div>
        <div>
          <span>RUNTIME POLICY</span>
          <strong>{cleanCore?.runtimeImagePolicy ?? "real-photo-only-v1"}</strong>
        </div>
        <div>
          <span>KNOWN SYNTHETIC</span>
          <strong>{cleanCore?.knownSyntheticFaces ?? 0}</strong>
        </div>
      </section>
    </main>
  );
}
