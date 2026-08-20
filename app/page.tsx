"use client";
/* eslint-disable @next/next/no-img-element */

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FaceLandmarker,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  buildFfhqCatalog,
  type BulkCatalogProgress,
} from "./catalog-builder";
import {
  createLandmarkPitchTracker,
  landmarkPitchDegrees,
  type LandmarkPitchTracker,
} from "./landmark-pitch";
import {
  calibrateExpressionFeature,
  createExpressionTracker,
  expressionDistance,
  expressionLabel,
} from "./expression-matching";
import { faceFeatureFromScores } from "./face-actions";
import OfflineVideoLab from "./offline-video-lab";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const OUTPUT_SIZE = 384;
const MAX_FILES = 500;
const POSE_BIN_DEGREES = 3;
const LIVE_POSE_STEP_DEGREES = 1.5;
const MOBILE_DETECTION_FPS = 20;
const DESKTOP_DETECTION_FPS = 28;
const PUBLIC_BATCH_SIZE = 30;
const FFHQ_BATCH_SIZE = 60;
const MAX_ASSETS_PER_POSE_CELL = 4;
const DEFAULT_PITCH_GAIN = 1;
const MAX_ACTIVE_CATALOG_ASSETS = 360;
const MAX_CATALOG_SHARDS = 9;
const CATALOG_IMAGE_PRELOAD = 48;
const COVERAGE_YAWS = Array.from({ length: 31 }, (_, index) => -45 + index * 3);
const COVERAGE_PITCHES = Array.from({ length: 25 }, (_, index) => 36 - index * 3);

const SEARCH_PRESETS = [
  { label: "正面", query: "portrait face" },
  { label: "横顔", query: "side profile portrait person" },
  { label: "上向き", query: "portrait face looking up" },
  { label: "下向き", query: "portrait face looking down" },
  { label: "笑顔", query: "smiling portrait person" },
  { label: "口開き", query: "laughing portrait person" },
] as const;

type CropMode = "eyes" | "contour";
type MatchMode = "flow" | "direct" | "stable";
type FeatureMode = "pose" | "pose-expression";
type InputKind = "camera" | "video" | null;
type EngineState = "loading" | "ready" | "failed";

type FaceAsset = {
  id: string;
  name: string;
  url: string;
  feature: number[];
  cropMode: CropMode;
  catalogCell?: string;
  sourceId?: string;
  sourceName?: string;
  sourceUrl?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
};

type PublicFaceCandidate = {
  id: string;
  title: string;
  dataUrl?: string;
  imageUrl?: string;
  sourceName: string;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
};

type Progress = {
  done: number;
  total: number;
  rejected: number;
};

type CatalogEntry = {
  id: string;
  name: string;
  image?: string;
  pack?: string;
  offset?: number;
  length?: number;
  feature: number[];
  sourceName?: string;
  sourceUrl?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
};

type CatalogManifest = {
  schemaVersion: 1 | 3;
  catalogId?: string;
  generatedAt: string;
  totalFaces: number;
  poseStep: number;
  bounds: {
    yawMin: number;
    yawMax: number;
    pitchMin: number;
    pitchMax: number;
  };
  outputSize: number;
  cells: Record<string, { count: number; shards: string[]; shard?: string }>;
  indexFiles?: string[];
};

type CatalogState = "checking" | "empty" | "ready" | "uploading" | "failed";

type CatalogUploadProgress = {
  done: number;
  total: number;
};

function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function averagePoint(landmarks: NormalizedLandmark[], indexes: number[]) {
  const total = indexes.reduce(
    (sum, index) => {
      const point = landmarks[index];
      return { x: sum.x + point.x, y: sum.y + point.y };
    },
    { x: 0, y: 0 },
  );
  return { x: total.x / indexes.length, y: total.y / indexes.length };
}

function poseFromMatrix(result: FaceLandmarkerResult) {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  if (!matrix || matrix.length < 11) return [0, 0, 0];

  const pitch = Math.atan2(matrix[9], matrix[10]);
  const yaw = Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10]));
  const roll = Math.atan2(matrix[4], matrix[0]);

  return [
    clamp(yaw / (Math.PI / 2)),
    clamp(pitch / (Math.PI / 2)),
    clamp(roll / (Math.PI / 2)),
  ];
}

function featureFromResult(
  result: FaceLandmarkerResult,
  pitchGain = 1,
  pitchTracker?: LandmarkPitchTracker,
  poseStep = POSE_BIN_DEGREES,
) {
  const scores = new Map(
    (result.faceBlendshapes[0]?.categories ?? []).map((category) => [
      category.categoryName,
      category.score,
    ]),
  );
  const pose = poseFromMatrix(result);
  const landmarkPitch = pitchTracker && result.faceLandmarks[0]
    ? landmarkPitchDegrees(result.faceLandmarks[0], pitchTracker, pitchGain)
    : null;
  pose[1] = landmarkPitch === null
    ? clamp(pose[1] * pitchGain)
    : clamp(landmarkPitch / 90);
  const feature = faceFeatureFromScores(pose, scores);
  return feature.map((value, index) => {
    if (index > 2) return value;
    const degrees = value * 90;
    return (Math.round(degrees / poseStep) * poseStep) / 90;
  });
}

function featureDistance(a: number[], b: number[], featureMode: FeatureMode) {
  const poseWeights = [4.2, 4.8, 1.8];
  let distance = 0;
  for (let i = 0; i < 3; i += 1) {
    const delta = a[i] - b[i];
    distance += delta * delta * poseWeights[i];
  }
  return featureMode === "pose" ? distance : distance + expressionDistance(a, b);
}

function smoothFeature(previous: number[] | null, next: number[]) {
  if (!previous) return [...next];
  return next.map((value, index) => {
    const previousWeight = index === 1 ? 0.54 : 0.68;
    const smoothed = previous[index] * previousWeight + value * (1 - previousWeight);
    if (index > 2) return smoothed;
    const degrees = smoothed * 90;
    return (Math.round(degrees / LIVE_POSE_STEP_DEGREES) * LIVE_POSE_STEP_DEGREES) / 90;
  });
}

function poseDegrees(feature: number[]) {
  return {
    yaw: Math.round(feature[0] * 90),
    pitch: Math.round(feature[1] * 90),
  };
}

function poseCellKey(feature: number[]) {
  const { yaw, pitch } = poseDegrees(feature);
  return `${yaw}:${pitch}`;
}

function clampPoseCell(value: number, min: number, max: number, step: number) {
  return Math.max(min, Math.min(max, Math.round(value / step) * step));
}

function nearbyCatalogCells(manifest: CatalogManifest, yaw: number, pitch: number) {
  const centerYaw = clampPoseCell(
    yaw,
    manifest.bounds.yawMin,
    manifest.bounds.yawMax,
    manifest.poseStep,
  );
  const centerPitch = clampPoseCell(
    pitch,
    manifest.bounds.pitchMin,
    manifest.bounds.pitchMax,
    manifest.poseStep,
  );
  const candidates: Array<{ key: string; distance: number }> = [];
  for (let yOffset = -3; yOffset <= 3; yOffset += 1) {
    for (let pOffset = -3; pOffset <= 3; pOffset += 1) {
      const cellYaw = centerYaw + yOffset * manifest.poseStep;
      const cellPitch = centerPitch + pOffset * manifest.poseStep;
      if (
        cellYaw < manifest.bounds.yawMin ||
        cellYaw > manifest.bounds.yawMax ||
        cellPitch < manifest.bounds.pitchMin ||
        cellPitch > manifest.bounds.pitchMax
      ) {
        continue;
      }
      const key = `${cellYaw}:${cellPitch}`;
      if (!manifest.cells[key]) continue;
      candidates.push({ key, distance: yOffset * yOffset + pOffset * pOffset });
    }
  }
  return candidates
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_CATALOG_SHARDS)
    .map(({ key }) => key);
}

function isCatalogManifest(value: unknown): value is CatalogManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<CatalogManifest>;
  return (
    (manifest.schemaVersion === 1 || manifest.schemaVersion === 3) &&
    typeof manifest.totalFaces === "number" &&
    manifest.totalFaces > 0 &&
    typeof manifest.poseStep === "number" &&
    Boolean(manifest.bounds) &&
    Boolean(manifest.cells) &&
    typeof manifest.cells === "object"
  );
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画像変換に失敗しました"))),
      "image/webp",
      0.84,
    );
  });
}

function loadImage(file: File) {
  return new Promise<{ image: HTMLImageElement; release: () => void }>(
    (resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, release: () => URL.revokeObjectURL(url) });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("画像を開けませんでした"));
      };
      image.src = url;
    },
  );
}

function loadImageUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    if (/^https:\/\//i.test(url)) {
      image.crossOrigin = "anonymous";
      image.referrerPolicy = "no-referrer";
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("公開画像を開けませんでした"));
    image.src = url;
  });
}

async function loadCandidateImage(candidate: PublicFaceCandidate) {
  const sourceUrl = candidate.dataUrl ?? candidate.imageUrl;
  if (!sourceUrl) throw new Error("画像URLがありません");
  try {
    return await loadImageUrl(sourceUrl);
  } catch (error) {
    if (!candidate.imageUrl) throw error;
    return loadImageUrl(`/api/ffhq?image=${encodeURIComponent(candidate.imageUrl)}`);
  }
}

type FfhqRowsPayload = {
  rows?: Array<{
    row_idx?: number;
    row?: { image?: string | { src?: string } };
  }>;
  num_rows_total?: number;
};

function ffhqItemsFromRows(payload: FfhqRowsPayload, limit: number) {
  return (payload.rows ?? []).flatMap<PublicFaceCandidate>((entry) => {
    const image = entry.row?.image;
    const imageUrl = typeof image === "string" ? image : image?.src;
    let validImageUrl = false;
    try {
      const parsed = new URL(imageUrl ?? "");
      validImageUrl =
        parsed.protocol === "https:" &&
        parsed.hostname === "datasets-server.huggingface.co";
    } catch {
      validImageUrl = false;
    }
    if (entry.row_idx === undefined || !imageUrl || !validImageUrl) return [];
    return [
      {
        id: `ffhq-${entry.row_idx}`,
        title: `FFHQ ${String(entry.row_idx).padStart(5, "0")}`,
        imageUrl,
        sourceName: "FFHQ",
        sourceUrl: "https://huggingface.co/datasets/nuwandaa/ffhq128",
        creator: "NVIDIA FFHQ / Flickr photographers",
        license: "CC BY-NC-SA 4.0; per-image licenses vary",
        licenseUrl:
          "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt",
      },
    ];
  }).slice(0, limit);
}

async function fetchFfhqPack(limit: number, offset: number) {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const localResponse = await fetch(`/api/ffhq?${query.toString()}`);
  if (localResponse.ok) {
    const payload = (await localResponse.json()) as {
      items?: PublicFaceCandidate[];
      nextOffset?: number;
      total?: number;
    };
    if (payload.items?.length) return payload;
  }

  // The hosted Worker and the phone do not always share the same outbound
  // network path. Fall back to Hugging Face's CORS-enabled Dataset Viewer API.
  const directQuery = new URLSearchParams({
    dataset: "nuwandaa/ffhq128",
    config: "default",
    split: "train",
    offset: String(offset),
    length: String(Math.min(100, limit + 20)),
  });
  const directResponse = await fetch(
    `https://datasets-server.huggingface.co/rows?${directQuery.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  if (!directResponse.ok) throw new Error(`FFHQ ${directResponse.status}`);
  const rows = (await directResponse.json()) as FfhqRowsPayload;
  const items = ffhqItemsFromRows(rows, limit);
  if (!items.length) throw new Error("FFHQ images unavailable");
  const total = rows.num_rows_total ?? 70_000;
  return {
    items,
    total,
    nextOffset: (offset + (rows.rows?.length ?? items.length)) % total,
  };
}

function waitForVideo(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("動画を開けませんでした"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function makeAlignedCrop(
  image: HTMLImageElement,
  landmarks: NormalizedLandmark[],
  cropMode: CropMode,
) {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvasを初期化できませんでした");

  const leftEye = averagePoint(landmarks, [33, 133, 159, 145]);
  const rightEye = averagePoint(landmarks, [362, 263, 386, 374]);
  const eyeCenter = {
    x: (leftEye.x + rightEye.x) / 2,
    y: (leftEye.y + rightEye.y) / 2,
  };
  const angle = Math.atan2(
    (rightEye.y - leftEye.y) * image.naturalHeight,
    (rightEye.x - leftEye.x) * image.naturalWidth,
  );

  const xs = landmarks.map((point) => point.x * image.naturalWidth);
  const ys = landmarks.map((point) => point.y * image.naturalHeight);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const faceHeight = Math.max(1, maxY - minY);

  const sourceCenter =
    cropMode === "eyes"
      ? {
          x: eyeCenter.x * image.naturalWidth,
          y: eyeCenter.y * image.naturalHeight + faceHeight * 0.16,
        }
      : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  const targetFaceHeight = cropMode === "eyes" ? 274 : 262;
  const scale = Math.min(3.2, Math.max(0.18, targetFaceHeight / faceHeight));

  context.fillStyle = "#d8d4cc";
  context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  context.save();
  context.translate(OUTPUT_SIZE / 2, OUTPUT_SIZE * 0.49);
  context.rotate(-angle);
  context.scale(scale, scale);
  context.translate(-sourceCenter.x, -sourceCenter.y);
  context.drawImage(image, 0, 0);
  context.restore();

  const blob = await canvasToBlob(canvas);
  return URL.createObjectURL(blob);
}

function pickCandidate(
  assets: FaceAsset[],
  target: number[],
  mode: MatchMode,
  featureMode: FeatureMode,
  previousId: string | null,
  sequence: number,
) {
  const ranked = assets
    .map((asset) => ({
      asset,
      score: featureDistance(asset.feature, target, featureMode),
    }))
    .sort((a, b) => a.score - b.score);

  if (!ranked.length) return null;
  if (mode === "direct") return ranked[0];

  if (mode === "flow") {
    const tolerance = featureMode === "pose" ? 0.015 : 0.085;
    let pool = ranked
      .filter(({ score }) => score <= ranked[0].score + tolerance)
      .slice(0, 14);
    if (pool.length > 1) {
      const withoutPrevious = pool.filter(({ asset }) => asset.id !== previousId);
      if (withoutPrevious.length) pool = withoutPrevious;
    }
    return pool[sequence % pool.length] ?? ranked[0];
  }

  const previous = ranked.find(({ asset }) => asset.id === previousId);
  const tolerance = featureMode === "pose" ? 0.007 : 0.025;
  if (previous && previous.score <= ranked[0].score + tolerance) return previous;
  return ranked[0];
}

function formatPose(feature: number[] | null) {
  if (!feature) return "—";
  const degrees = feature.slice(0, 3).map((value) => Math.round(value * 90));
  return `${degrees[0]}° / ${degrees[1]}° / ${degrees[2]}°`;
}

function formatPoseShort(feature: number[]) {
  const yaw = Math.round(feature[0] * 90);
  const pitch = Math.round(feature[1] * 90);
  return `Y ${yaw > 0 ? "+" : ""}${yaw} / P ${pitch > 0 ? "+" : ""}${pitch}`;
}

function bulkPhaseLabel(phase: BulkCatalogProgress["phase"]) {
  if (phase === "fetching") return "FFHQ取得";
  if (phase === "detecting") return "顔検出・整列";
  if (phase === "uploading") return "安全に分割保存";
  return "索引を確定";
}

// Kept in this module while the offline sequence workflow is evaluated.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyLiveLab() {
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const trackingActiveRef = useRef(false);
  const inputKindRef = useRef<InputKind>(null);
  const animationRef = useRef<number | null>(null);
  const lastDetectionRef = useRef(0);
  const missingFaceFramesRef = useRef(0);
  const calibratingRef = useRef(false);
  const assetsRef = useRef<FaceAsset[]>([]);
  const currentIdRef = useRef<string | null>(null);
  const smoothedFeatureRef = useRef<number[] | null>(null);
  const lastSelectionRef = useRef(0);
  const selectionSequenceRef = useRef(0);
  const modeRef = useRef<MatchMode>("flow");
  const featureModeRef = useRef<FeatureMode>("pose-expression");
  const rateRef = useRef(7);
  const pitchGainRef = useRef(DEFAULT_PITCH_GAIN);
  const landmarkPitchRef = useRef(createLandmarkPitchTracker());
  const expressionTrackerRef = useRef(createExpressionTracker());
  const catalogManifestRef = useRef<CatalogManifest | null>(null);
  const catalogShardCacheRef = useRef(new Map<string, FaceAsset[]>());
  const catalogShardOrderRef = useRef<string[]>([]);
  const catalogLoadingRef = useRef(new Set<string>());
  const catalogRetryAfterRef = useRef(new Map<string, number>());
  const catalogLastCellRef = useRef<string | null>(null);
  const catalogPreloadRef = useRef<HTMLImageElement[]>([]);
  const catalogSessionSaltRef = useRef(Math.floor(Math.random() * 1_000_000));
  const bulkCancelRef = useRef(false);
  const detectionFpsRef = useRef(DESKTOP_DETECTION_FPS);

  const [engineState, setEngineState] = useState<EngineState>("loading");
  const [engineMessage, setEngineMessage] = useState("顔追跡エンジンを準備中");
  const [assets, setAssets] = useState<FaceAsset[]>([]);
  const [cropMode, setCropMode] = useState<CropMode>("eyes");
  const [matchMode, setMatchMode] = useState<MatchMode>("flow");
  const [featureMode, setFeatureMode] = useState<FeatureMode>("pose-expression");
  const [changeRate, setChangeRate] = useState(7);
  const [pitchGain, setPitchGain] = useState(DEFAULT_PITCH_GAIN);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [inputKind, setInputKind] = useState<InputKind>(null);
  const [inputName, setInputName] = useState<string | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [current, setCurrent] = useState<FaceAsset | null>(null);
  const [liveFeature, setLiveFeature] = useState<number[] | null>(null);
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publicQuery, setPublicQuery] = useState("portrait face");
  const [publicPage, setPublicPage] = useState(1);
  const [sourceMessage, setSourceMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [sourceTask, setSourceTask] = useState<"ffhq" | "public" | null>(null);
  const [ffhqOffset, setFfhqOffset] = useState(0);
  const [catalogManifest, setCatalogManifest] = useState<CatalogManifest | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>("checking");
  const [catalogCacheCount, setCatalogCacheCount] = useState(0);
  const [catalogNetworkIssue, setCatalogNetworkIssue] = useState(false);
  const [catalogUploadProgress, setCatalogUploadProgress] =
    useState<CatalogUploadProgress | null>(null);
  const [bulkTarget, setBulkTarget] = useState(15_000);
  const [bulkProgress, setBulkProgress] = useState<BulkCatalogProgress | null>(null);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    modeRef.current = matchMode;
  }, [matchMode]);

  useEffect(() => {
    featureModeRef.current = featureMode;
  }, [featureMode]);

  useEffect(() => {
    rateRef.current = changeRate;
  }, [changeRate]);

  useEffect(() => {
    pitchGainRef.current = pitchGain;
  }, [pitchGain]);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 680px), (pointer: coarse)").matches;
    detectionFpsRef.current = mobile ? MOBILE_DETECTION_FPS : DESKTOP_DETECTION_FPS;
  }, []);

  const refreshActiveCatalogAssets = useCallback((preferredKeys: string[]) => {
    const cache = catalogShardCacheRef.current;
    const oldOrder = catalogShardOrderRef.current;
    const order = [
      ...preferredKeys,
      ...oldOrder.filter((key) => !preferredKeys.includes(key)),
    ].filter((key, index, values) => values.indexOf(key) === index && cache.has(key));

    const retainedOrder = order.slice(0, MAX_CATALOG_SHARDS);
    for (const key of [...cache.keys()]) {
      if (!retainedOrder.includes(key)) cache.delete(key);
    }
    catalogShardOrderRef.current = retainedOrder;

    const catalogAssets: FaceAsset[] = [];
    const perShardLimit = Math.max(
      24,
      Math.floor(MAX_ACTIVE_CATALOG_ASSETS / Math.max(1, retainedOrder.length)),
    );
    for (const key of retainedOrder) {
      const shard = cache.get(key) ?? [];
      const take = Math.min(
        perShardLimit,
        MAX_ACTIVE_CATALOG_ASSETS - catalogAssets.length,
        shard.length,
      );
      if (take <= 0) break;
      if (take === shard.length) {
        catalogAssets.push(...shard);
      } else {
        const stride = shard.length / take;
        const offset = Math.abs(
          [...`${key}:${catalogSessionSaltRef.current}`].reduce(
            (sum, character) => sum + character.charCodeAt(0),
            0,
          ),
        ) % Math.max(1, Math.floor(stride));
        for (let index = 0; index < take; index += 1) {
          catalogAssets.push(shard[Math.floor((index * stride + offset) % shard.length)]);
        }
      }
    }

    const preloadCells = new Set(preferredKeys.slice(0, 3));
    const preloadAssets = catalogAssets
      .filter((asset) => asset.catalogCell && preloadCells.has(asset.catalogCell))
      .slice(0, CATALOG_IMAGE_PRELOAD);
    catalogPreloadRef.current.forEach((image) => {
      image.src = "";
    });
    catalogPreloadRef.current = preloadAssets.map((asset) => {
      const image = new Image();
      image.decoding = "async";
      image.src = asset.url;
      return image;
    });

    setCatalogCacheCount(catalogAssets.length);
    setAssets((previous) => {
      const localAssets = previous.filter((asset) => !asset.catalogCell);
      return [...localAssets, ...catalogAssets];
    });
  }, []);

  const loadCatalogNeighborhood = useCallback(
    async (yaw: number, pitch: number, force = false) => {
      const manifest = catalogManifestRef.current;
      if (!manifest) return;
      const preferredKeys = nearbyCatalogCells(manifest, yaw, pitch);
      if (!preferredKeys.length) return;
      const focusKey = preferredKeys[0];
      const hasAll = preferredKeys.every((key) =>
        catalogShardCacheRef.current.has(key),
      );
      if (!force && catalogLastCellRef.current === focusKey && hasAll) return;
      catalogLastCellRef.current = focusKey;

      const missing = preferredKeys.filter(
        (key) =>
          !catalogShardCacheRef.current.has(key) &&
          !catalogLoadingRef.current.has(key) &&
          Date.now() >= (catalogRetryAfterRef.current.get(key) ?? 0),
      );
      missing.forEach((key) => catalogLoadingRef.current.add(key));

      const results = await Promise.allSettled(
        missing.map(async (key) => {
          try {
            const cell = manifest.cells[key];
            const shardFiles = cell?.shards?.length
              ? cell.shards
              : cell?.shard
                ? [cell.shard]
                : [];
            const shardFile = shardFiles[
              Math.abs(
                [...`${key}:${catalogSessionSaltRef.current}`].reduce(
                  (sum, character) => sum + character.charCodeAt(0),
                  0,
                ),
              ) % Math.max(1, shardFiles.length)
            ];
            if (!shardFile) return;
            const catalogVersion = manifest.catalogId || manifest.generatedAt;
            const response = await fetch(
              `/api/catalog/shard?file=${encodeURIComponent(shardFile)}&catalog=${encodeURIComponent(catalogVersion)}`,
            );
            if (!response.ok) throw new Error(`catalog shard ${response.status}`);
            const payload = (await response.json()) as { items?: CatalogEntry[] };
            const items = (payload.items ?? []).flatMap<FaceAsset>((entry) => {
              if (
                !entry.id ||
                (!entry.image &&
                  !(
                    entry.pack &&
                    Number.isInteger(entry.offset) &&
                    Number.isInteger(entry.length)
                  )) ||
                !Array.isArray(entry.feature) ||
                entry.feature.length < 3
              ) {
                return [];
              }
              return [
                {
                  id: `catalog-${entry.id}`,
                  name: entry.name || entry.id,
                  url: entry.image
                    ? `/api/catalog/image?id=${encodeURIComponent(entry.image)}`
                    : `/api/catalog/image?pack=${encodeURIComponent(entry.pack ?? "")}&offset=${entry.offset}&length=${entry.length}`,
                  feature: entry.feature,
                  cropMode: "eyes",
                  catalogCell: key,
                  sourceId: `catalog-${entry.id}`,
                  sourceName: entry.sourceName || "Remote catalog",
                  sourceUrl: entry.sourceUrl,
                  creator: entry.creator,
                  license: entry.license,
                  licenseUrl: entry.licenseUrl,
                },
              ];
            });
            catalogShardCacheRef.current.set(key, items);
            catalogRetryAfterRef.current.delete(key);
          } catch (error) {
            catalogRetryAfterRef.current.set(key, Date.now() + 2_500);
            throw error;
          } finally {
            catalogLoadingRef.current.delete(key);
          }
        }),
      );
      if (results.some((result) => result.status === "rejected")) {
        setCatalogNetworkIssue(true);
      } else if (missing.length) {
        setCatalogNetworkIssue(false);
      }
      refreshActiveCatalogAssets(preferredKeys);
    },
    [refreshActiveCatalogAssets],
  );

  const reloadCatalog = useCallback(async () => {
    setCatalogState("checking");
    try {
      const response = await fetch("/api/catalog/manifest", { cache: "no-store" });
      if (response.status === 404) {
        catalogManifestRef.current = null;
        setCatalogManifest(null);
        setCatalogState("empty");
        return;
      }
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      const payload: unknown = await response.json();
      if (!isCatalogManifest(payload)) throw new Error("invalid catalog manifest");
      catalogManifestRef.current = payload;
      setCatalogManifest(payload);
      setCatalogState("ready");
      setCatalogNetworkIssue(false);
      await loadCatalogNeighborhood(0, 0, true);
    } catch (caught) {
      console.error("Catalog manifest load failed.", caught);
      setCatalogState("failed");
    }
  }, [loadCatalogNeighborhood]);

  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);

  const uploadCatalog = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (!selected.length) return;

      const catalogFiles = selected.flatMap((file) => {
        const relative = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        const parts = (relative || file.name).split("/").filter(Boolean);
        const path = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
        if (
          path === "manifest.json" ||
          /^index_[0-9]{3}\.json$/i.test(path) ||
          /^shards\/[a-z0-9_.+-]+\.json$/i.test(path) ||
          /^packs\/[a-z0-9_.-]+\.bin$/i.test(path) ||
          /^images\/[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i.test(path)
        ) {
          return [{ file, path }];
        }
        return [];
      });
      const manifestFile = catalogFiles.find((item) => item.path === "manifest.json");
      const objects = catalogFiles.filter((item) => item.path !== "manifest.json");
      if (!manifestFile || !objects.length) {
        setError("manifest.json・shards・packsを含む処理済みカタログを選んでください。");
        return;
      }

      try {
        const manifestPayload: unknown = JSON.parse(await manifestFile.file.text());
        if (!isCatalogManifest(manifestPayload)) {
          throw new Error("invalid manifest");
        }
        const selectedPaths = new Set(objects.map((item) => item.path));
        const referencedShards = Object.values(manifestPayload.cells).flatMap(
          (cell) => cell.shards ?? (cell.shard ? [cell.shard] : []),
        );
        const referencedIndexes = manifestPayload.indexFiles ?? [];
        if (
          referencedShards.some((file) => !selectedPaths.has(`shards/${file}`)) ||
          referencedIndexes.some((file) => !selectedPaths.has(file)) ||
          !objects.some((item) => item.path.startsWith("packs/") || item.path.startsWith("images/"))
        ) {
          throw new Error("incomplete catalog");
        }
      } catch (caught) {
        console.error("Catalog validation failed.", caught);
        setError("処理済みカタログが不完全です。前処理を最後まで実行したフォルダを選んでください。");
        return;
      }

      setError(null);
      setCatalogState("uploading");
      setCatalogUploadProgress({ done: 0, total: catalogFiles.length });
      let nextIndex = 0;
      let done = 0;
      const send = async ({ file, path }: { file: File; path: string }) => {
        const response = await fetch(
          `/api/catalog/upload?path=${encodeURIComponent(path)}`,
          {
            method: "POST",
            headers: { "content-type": file.type || "application/octet-stream" },
            body: file,
          },
        );
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        done += 1;
        setCatalogUploadProgress({ done, total: catalogFiles.length });
      };

      try {
        const workers = Array.from(
          { length: Math.min(4, objects.length) },
          async () => {
            while (nextIndex < objects.length) {
              const item = objects[nextIndex];
              nextIndex += 1;
              await send(item);
            }
          },
        );
        await Promise.all(workers);
        await send(manifestFile);
        catalogShardCacheRef.current.clear();
        catalogShardOrderRef.current = [];
        catalogLastCellRef.current = null;
        await reloadCatalog();
      } catch (caught) {
        console.error("Catalog upload failed.", caught);
        setCatalogState("failed");
        setError("カタログの転送が途中で止まりました。もう一度同じフォルダを選べば続きから上書きできます。");
      } finally {
        setCatalogUploadProgress(null);
      }
    },
    [reloadCatalog],
  );

  useEffect(() => {
    let disposed = false;
    async function prepareEngine() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );
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
        } catch (gpuError) {
          console.warn("GPU face tracking unavailable; using CPU.", gpuError);
          landmarker = await FaceLandmarker.createFromOptions(fileset, {
            ...sharedOptions,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          });
        }
        if (disposed) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setEngineState("ready");
        setEngineMessage("準備完了");
      } catch (caught) {
        console.error(caught);
        if (!disposed) {
          setEngineState("failed");
          setEngineMessage("顔追跡エンジンを読み込めませんでした");
        }
      }
    }
    prepareEngine();

    return () => {
      disposed = true;
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      landmarkerRef.current?.close();
      assetsRef.current
        .filter((asset) => !asset.catalogCell)
        .forEach((asset) => URL.revokeObjectURL(asset.url));
      catalogPreloadRef.current.forEach((image) => {
        image.src = "";
      });
      bulkCancelRef.current = true;
    };
  }, []);

  const stopLive = useCallback(async () => {
    trackingActiveRef.current = false;
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    setIsLive(false);
    inputKindRef.current = null;
    setInputKind(null);
    setInputName(null);
    calibratingRef.current = false;
    setIsCalibrating(false);
    smoothedFeatureRef.current = null;
    landmarkPitchRef.current = createLandmarkPitchTracker();
    expressionTrackerRef.current = createExpressionTracker();
    if (landmarkerRef.current) {
      await landmarkerRef.current.setOptions({ runningMode: "IMAGE" });
    }
  }, []);

  const processFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).slice(0, MAX_FILES);
      event.target.value = "";
      if (!files.length || !landmarkerRef.current) return;
      if (isLive) await stopLive();

      setError(null);
      setProgress({ done: 0, total: files.length, rejected: 0 });
      const accepted: FaceAsset[] = [];
      let rejected = 0;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
          const { image, release } = await loadImage(file);
          const result = landmarkerRef.current.detect(image);
          if (!result.faceLandmarks.length || !result.faceBlendshapes.length) {
            rejected += 1;
            release();
          } else {
            const url = await makeAlignedCrop(
              image,
              result.faceLandmarks[0],
              cropMode,
            );
            accepted.push({
              id: `manual-${Date.now()}-${index}-${Math.round(Math.random() * 10000)}`,
              name: file.name,
              url,
              feature: featureFromResult(result),
              cropMode,
            });
            release();
          }
        } catch (caught) {
          console.error(caught);
          rejected += 1;
        }
        setProgress({ done: index + 1, total: files.length, rejected });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      setAssets((previous) => [...previous, ...accepted]);
      setProgress(null);
      if (!accepted.length) {
        setError("顔を検出できる画像がありませんでした。正面に近い写真から試してください。");
      }
    },
    [cropMode, isLive, stopLive],
  );

  const ingestCandidates = useCallback(
    async (incoming: PublicFaceCandidate[]) => {
      const landmarker = landmarkerRef.current;
      if (!landmarker) {
        return { accepted: 0, rejected: incoming.length, skipped: 0, covered: 0 };
      }

      const existingIds = new Set(
        assetsRef.current.map((asset) => asset.sourceId).filter(Boolean),
      );
      const candidates = incoming.filter((item) => !existingIds.has(item.id));
      const skipped = incoming.length - candidates.length;
      if (!candidates.length) return { accepted: 0, rejected: 0, skipped, covered: 0 };

      const poseCounts = new Map<string, number>();
      for (const asset of assetsRef.current) {
        const key = poseCellKey(asset.feature);
        poseCounts.set(key, (poseCounts.get(key) ?? 0) + 1);
      }

      setProgress({ done: 0, total: candidates.length, rejected: 0 });
      const acceptedAssets: FaceAsset[] = [];
      let rejected = 0;
      let covered = 0;

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
          const image = await loadCandidateImage(candidate);
          const result = landmarker.detect(image);
          if (!result.faceLandmarks.length || !result.faceBlendshapes.length) {
            rejected += 1;
          } else {
            const feature = featureFromResult(result);
            const cellKey = poseCellKey(feature);
            if ((poseCounts.get(cellKey) ?? 0) >= MAX_ASSETS_PER_POSE_CELL) {
              covered += 1;
            } else {
              const url = await makeAlignedCrop(
                image,
                result.faceLandmarks[0],
                cropMode,
              );
              acceptedAssets.push({
                id: `source-${Date.now()}-${index}-${Math.round(Math.random() * 10000)}`,
                name: candidate.title,
                url,
                feature,
                cropMode,
                sourceId: candidate.id,
                sourceName: candidate.sourceName,
                sourceUrl: candidate.sourceUrl,
                creator: candidate.creator,
                license: candidate.license,
                licenseUrl: candidate.licenseUrl,
              });
              poseCounts.set(cellKey, (poseCounts.get(cellKey) ?? 0) + 1);
            }
          }
        } catch (caught) {
          console.error(caught);
          rejected += 1;
        }
        setProgress({ done: index + 1, total: candidates.length, rejected });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      setAssets((previous) => [...previous, ...acceptedAssets]);
      return { accepted: acceptedAssets.length, rejected, skipped, covered };
    },
    [cropMode],
  );

  const collectPublicFaces = useCallback(async () => {
    if (!landmarkerRef.current || !publicQuery.trim()) return;
    if (isLive) await stopLive();

    const localCount = assetsRef.current.filter((asset) => !asset.catalogCell).length;
    const availableSlots = Math.max(0, MAX_FILES - localCount);
    if (!availableSlots) {
      setError(`素材は最大${MAX_FILES}枚です。`);
      return;
    }

    setError(null);
    setSourceMessage(null);
    setIsSearching(true);
    setSourceTask("public");
    try {
      const query = new URLSearchParams({
        q: publicQuery.trim(),
        limit: String(Math.min(PUBLIC_BATCH_SIZE, availableSlots)),
        page: String(publicPage),
      });
      const response = await fetch(`/api/openverse?${query.toString()}`);
      const payload = (await response.json()) as {
        items?: PublicFaceCandidate[];
        source?: string;
        error?: string;
      };
      if (!response.ok || !payload.items) {
        throw new Error(payload.error || "公開素材を取得できませんでした");
      }

      const result = await ingestCandidates(payload.items);
      setPublicPage((page) => page + 1);
      setSourceMessage(
        `${payload.source ?? "公開アーカイブ"}から${result.accepted}枚追加。顔検出外${result.rejected}枚、埋まった角度${result.covered}枚を除外しました。`,
      );
      if (!result.accepted && !result.skipped && !result.covered) {
        setError("今回の候補から顔を検出できませんでした。別の検索語を試してください。");
      }
    } catch (caught) {
      console.error(caught);
      setError(
        caught instanceof Error
          ? caught.message
          : "公開素材の検索に失敗しました。少し待って再試行してください。",
      );
    } finally {
      setProgress(null);
      setIsSearching(false);
      setSourceTask(null);
    }
  }, [ingestCandidates, isLive, publicPage, publicQuery, stopLive]);

  const collectFfhqFaces = useCallback(async () => {
    if (!landmarkerRef.current) return;
    if (isLive) await stopLive();

    const localCount = assetsRef.current.filter((asset) => !asset.catalogCell).length;
    const availableSlots = Math.max(0, MAX_FILES - localCount);
    if (!availableSlots) {
      setError(`素材は最大${MAX_FILES}枚です。`);
      return;
    }

    setError(null);
    setSourceMessage(null);
    setIsSearching(true);
    setSourceTask("ffhq");
    try {
      const payload = await fetchFfhqPack(
        Math.min(FFHQ_BATCH_SIZE, availableSlots),
        ffhqOffset,
      );

      const result = await ingestCandidates(payload.items ?? []);
      setFfhqOffset(payload.nextOffset ?? ffhqOffset + payload.items.length);
      setSourceMessage(
        `FFHQを${payload.items?.length ?? 0}枚探索し${result.accepted}枚追加。顔検出外${result.rejected}枚、埋まった角度${result.covered}枚を除外しました。`,
      );
      if (!result.accepted && !result.skipped && !result.covered) {
        setError("このFFHQ素材群から顔を検出できませんでした。次のまとまりを試してください。");
      }
    } catch (caught) {
      console.error(caught);
      setError(
        caught instanceof Error
          ? caught.message
          : "FFHQ素材パックの取得に失敗しました。少し待って再試行してください。",
      );
    } finally {
      setProgress(null);
      setIsSearching(false);
      setSourceTask(null);
    }
  }, [ffhqOffset, ingestCandidates, isLive, stopLive]);

  const buildRemoteFfhqCatalog = useCallback(async () => {
    const landmarker = landmarkerRef.current;
    if (!landmarker || bulkProgress) return;
    if (isLive) await stopLive();

    type WakeLock = { release(): Promise<void> };
    const wakeLockApi = (
      navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<WakeLock> };
      }
    ).wakeLock;
    let wakeLock: WakeLock | undefined;
    bulkCancelRef.current = false;
    setError(null);
    setSourceMessage(null);
    setCatalogState("uploading");
    try {
      try {
        wakeLock = await wakeLockApi?.request("screen");
      } catch {
        // A missing wake lock is harmless; the progress copy asks to keep the tab open.
      }
      const result = await buildFfhqCatalog({
        landmarker,
        targetFaces: bulkTarget,
        startOffset: ffhqOffset,
        onProgress: setBulkProgress,
        isCancelled: () => bulkCancelRef.current,
      });
      setFfhqOffset(result.nextOffset);
      catalogShardCacheRef.current.clear();
      catalogShardOrderRef.current = [];
      catalogRetryAfterRef.current.clear();
      catalogLastCellRef.current = null;
      await reloadCatalog();
      setSourceMessage(
        `FFHQ ${result.manifest.totalFaces.toLocaleString()}枚を整列・3°分類し、リモートカタログへ反映しました。`,
      );
    } catch (caught) {
      console.error("Automatic FFHQ catalog build stopped.", caught);
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setSourceMessage("自動構築を中止しました。完成済みの旧カタログはそのまま使えます。");
      } else {
        setError(
          "自動構築が途中で止まりました。完成済みの旧カタログは壊れていません。通信を確認して再実行してください。",
        );
      }
      await reloadCatalog();
    } finally {
      bulkCancelRef.current = false;
      setBulkProgress(null);
      await wakeLock?.release().catch(() => undefined);
    }
  }, [bulkProgress, bulkTarget, ffhqOffset, isLive, reloadCatalog, stopLive]);

  const runTracking = useCallback(function trackFrame() {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker || !trackingActiveRef.current) return;

    const now = performance.now();
    const detectionInterval = 1000 / detectionFpsRef.current;
    if (now - lastDetectionRef.current < detectionInterval) {
      animationRef.current = requestAnimationFrame(trackFrame);
      return;
    }
    lastDetectionRef.current = now;
    if (video.readyState >= 2) {
      try {
        const result = landmarker.detectForVideo(video, now);
        if (result.faceLandmarks.length && result.faceBlendshapes.length) {
          const rawFeature = featureFromResult(
            result,
            pitchGainRef.current,
            landmarkPitchRef.current,
            LIVE_POSE_STEP_DEGREES,
          );
          const detectedFeature = calibrateExpressionFeature(
            rawFeature,
            expressionTrackerRef.current,
          );
          if (
            calibratingRef.current &&
            expressionTrackerRef.current.frames >= 12 &&
            landmarkPitchRef.current.calibrationFrames >= 12
          ) {
            calibratingRef.current = false;
            setIsCalibrating(false);
          }
          if (inputKindRef.current === "camera") {
            detectedFeature[0] *= -1;
          }
          const previousFeature = smoothedFeatureRef.current;
          const feature = smoothFeature(previousFeature, detectedFeature);
          smoothedFeatureRef.current = feature;
          missingFaceFramesRef.current = 0;
          void loadCatalogNeighborhood(feature[0] * 90, feature[1] * 90);
          if (
            !previousFeature ||
            feature.slice(0, 3).some((value, index) => value !== previousFeature[index])
          ) {
            setLiveFeature(feature);
          }

          const interval = 1000 / rateRef.current;
          if (now - lastSelectionRef.current >= interval) {
            const selected = pickCandidate(
              assetsRef.current,
              feature,
              modeRef.current,
              featureModeRef.current,
              currentIdRef.current,
              selectionSequenceRef.current,
            );
            if (selected) {
              lastSelectionRef.current = now;
              selectionSequenceRef.current += 1;
              if (selected.asset.id !== currentIdRef.current) {
                currentIdRef.current = selected.asset.id;
                setCurrent(selected.asset);
              }
              setMatchScore(selected.score);
            }
          }
        } else {
          missingFaceFramesRef.current += 1;
          if (missingFaceFramesRef.current === 8) {
            smoothedFeatureRef.current = null;
            setLiveFeature(null);
            setMatchScore(null);
          }
        }
      } catch (caught) {
        console.error(caught);
      }
    }
    animationRef.current = requestAnimationFrame(trackFrame);
  }, [loadCatalogNeighborhood]);

  const startLive = useCallback(async () => {
    if (!landmarkerRef.current || !assetsRef.current.length) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 640 },
          frameRate: { ideal: 24, max: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("カメラ表示を準備できませんでした");
      video.removeAttribute("src");
      video.srcObject = stream;
      await video.play();
      await landmarkerRef.current.setOptions({ runningMode: "VIDEO" });
      inputKindRef.current = "camera";
      setInputKind("camera");
      setInputName("FRONT CAMERA");
      setIsLive(true);
      trackingActiveRef.current = true;
      lastDetectionRef.current = 0;
      missingFaceFramesRef.current = 0;
      smoothedFeatureRef.current = null;
      landmarkPitchRef.current = createLandmarkPitchTracker();
      expressionTrackerRef.current = createExpressionTracker();
      selectionSequenceRef.current = 0;
      calibratingRef.current = true;
      setIsCalibrating(true);
      lastSelectionRef.current = 0;
      runTracking();
    } catch (caught) {
      console.error(caught);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError("カメラを開始できませんでした。ブラウザのカメラ許可を確認してください。");
    }
  }, [runTracking]);

  const startVideoInput = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !landmarkerRef.current || !assetsRef.current.length) return;

      if (isLive) await stopLive();
      setError(null);
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
        video.load();
        await waitForVideo(video);
        await landmarkerRef.current.setOptions({ runningMode: "VIDEO" });
        await video.play();
        inputKindRef.current = "video";
        setInputKind("video");
        setInputName(file.name);
        setIsLive(true);
        trackingActiveRef.current = true;
        lastDetectionRef.current = 0;
        missingFaceFramesRef.current = 0;
        smoothedFeatureRef.current = null;
        landmarkPitchRef.current = createLandmarkPitchTracker();
        expressionTrackerRef.current = createExpressionTracker();
        selectionSequenceRef.current = 0;
        calibratingRef.current = true;
        setIsCalibrating(true);
        lastSelectionRef.current = 0;
        runTracking();
      } catch (caught) {
        console.error(caught);
        if (videoUrlRef.current) {
          URL.revokeObjectURL(videoUrlRef.current);
          videoUrlRef.current = null;
        }
        setError("この動画を再生できませんでした。MP4、MOV、WebMなどで試してください。");
      }
    },
    [isLive, runTracking, stopLive],
  );

  const clearAssets = useCallback(async () => {
    if (isLive) await stopLive();
    const catalogAssets = assetsRef.current.filter((asset) => asset.catalogCell);
    assetsRef.current
      .filter((asset) => !asset.catalogCell)
      .forEach((asset) => URL.revokeObjectURL(asset.url));
    assetsRef.current = catalogAssets;
    setAssets(catalogAssets);
    setCurrent(null);
    setLiveFeature(null);
    setMatchScore(null);
    setFfhqOffset(0);
    setSourceMessage(null);
    currentIdRef.current = null;
  }, [isLive, stopLive]);

  const statusText = useMemo(() => {
    if (engineState === "loading") return "ENGINE LOADING";
    if (engineState === "failed") return "ENGINE OFFLINE";
    if (bulkProgress) return "CATALOG BUILD";
    if (isLive && inputKind === "video") return "VIDEO MATCHING";
    if (isLive) return "LIVE MATCHING";
    if (isSearching) return "SOURCE SEARCH";
    if (progress) return "PROCESSING";
    return "READY";
  }, [bulkProgress, engineState, inputKind, isLive, isSearching, progress]);

  const localAssets = assets.filter((asset) => !asset.catalogCell);
  const visibleAssets = assets.slice(-12).reverse();
  const ffhqCount = localAssets.filter((asset) => asset.sourceName === "FFHQ").length;
  const availableFaceCount = (catalogManifest?.totalFaces ?? 0) + localAssets.length;
  const poseCoverage = useMemo(() => {
    if (!localAssets.length) return null;
    const yaws = localAssets.map((asset) => Math.round(asset.feature[0] * 90));
    const pitches = localAssets.map((asset) => Math.round(asset.feature[1] * 90));
    return {
      yawMin: Math.min(...yaws),
      yawMax: Math.max(...yaws),
      pitchMin: Math.min(...pitches),
      pitchMax: Math.max(...pitches),
      bins: new Set(localAssets.map((asset) => poseCellKey(asset.feature))).size,
    };
  }, [localAssets]);
  const coverageMap = useMemo(() => {
    const counts = new Map<string, number>();
    if (catalogManifest) {
      for (const [key, cell] of Object.entries(catalogManifest.cells)) {
        counts.set(key, cell.count);
      }
    }
    for (const asset of localAssets) {
      const { yaw, pitch } = poseDegrees(asset.feature);
      if (yaw < -45 || yaw > 45 || pitch < -36 || pitch > 36) continue;
      const key = `${yaw}:${pitch}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const cells = COVERAGE_PITCHES.flatMap((pitch) =>
      COVERAGE_YAWS.map((yaw) => ({
        key: `${yaw}:${pitch}`,
        yaw,
        pitch,
        count: counts.get(`${yaw}:${pitch}`) ?? 0,
      })),
    );
    return {
      cells,
      covered: cells.filter((cell) => cell.count > 0).length,
      total: cells.length,
    };
  }, [catalogManifest, localAssets]);
  const currentCoverageKey = useMemo(() => {
    if (!liveFeature) return null;
    const { yaw, pitch } = poseDegrees(liveFeature);
    if (yaw < -45 || yaw > 45 || pitch < -36 || pitch > 36) return null;
    return `${clampPoseCell(yaw, -45, 45, POSE_BIN_DEGREES)}:${clampPoseCell(pitch, -36, 36, POSE_BIN_DEGREES)}`;
  }, [liveFeature]);
  const creditedAssets = assets.filter(
    (asset) => asset.sourceUrl && asset.sourceName !== "FFHQ",
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MANY FACES / LAB 01</p>
          <h1>ひとつの動き、別々の顔。</h1>
        </div>
        <div className={`status ${engineState === "failed" ? "status-error" : ""}`}>
          <span />
          {statusText}
        </div>
      </header>

      <section className="stage-wrap" aria-label="選択された顔の表示">
        <div className={`stage ${isLive ? "stage-live" : ""}`}>
          {current ? (
            <img src={current.url} alt="現在の表情に近い顔" draggable={false} />
          ) : (
            <div className="stage-empty">
              <div className="target-mark" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
              <p>{assets.length ? "カメラか動画を選んでください" : "顔素材を追加してください"}</p>
              <small>
                {catalogState === "checking"
                  ? "リモートカタログを確認中"
                  : "追加した写真だけ端末内で解析されます"}
              </small>
            </div>
          )}

          <div className="stage-readout">
            <span>{current ? current.name : "NO SIGNAL"}</span>
            <span>{matchScore === null ? "DIST —" : `DIST ${matchScore.toFixed(3)}`}</span>
          </div>
          <div className={`input-monitor ${isLive ? "input-monitor-visible" : ""}`}>
            <span>INPUT / {inputName ?? "—"}</span>
            <video
              ref={videoRef}
              className={inputKind === "camera" ? "mirrored" : ""}
              muted
              playsInline
              controls={inputKind === "video"}
            />
          </div>
          {isLive && isCalibrating && (
            <div className="calibration-banner" role="status">
              <strong>正面・無表情を維持</strong>
              <span>CALIBRATING</span>
            </div>
          )}
        </div>

        <div className="telemetry" aria-label="追跡情報">
          <div>
            <span>POSE Y / P / R</span>
            <strong>{formatPose(liveFeature)}</strong>
          </div>
          <div>
            <span>FACES</span>
            <strong>{availableFaceCount || assets.length}</strong>
          </div>
          <div>
            <span>EXPRESSION</span>
            <strong>{expressionLabel(liveFeature)}</strong>
          </div>
          <div>
            <span>MATCH RATE</span>
            <strong>{changeRate}/s</strong>
          </div>
          <div>
            <span>TRACK / CATALOG</span>
            <strong>{LIVE_POSE_STEP_DEGREES}° / {POSE_BIN_DEGREES}°</strong>
          </div>
        </div>
      </section>

      <section className="control-panel">
        <div className="source-hub">
          <div className="section-label">
            <span>PRIMARY FACE SOURCE</span>
            <span>NON-COMMERCIAL LAB</span>
          </div>
          <div className={`remote-catalog remote-catalog-${catalogState}`}>
            <div className="remote-catalog-head">
              <div>
                <strong>REMOTE FACE CATALOG</strong>
                <span>
                  {catalogState === "ready" && catalogManifest
                    ? `${catalogManifest.totalFaces.toLocaleString()} faces / ${Object.keys(catalogManifest.cells).length} pose cells`
                    : catalogState === "empty"
                      ? "処理済みカタログはまだありません"
                      : catalogState === "uploading"
                        ? "カタログを転送中"
                        : catalogState === "failed"
                          ? "カタログへ接続できません"
                          : "カタログを確認中"}
                </span>
              </div>
              <b>{catalogState === "ready" ? "ONLINE" : catalogState.toUpperCase()}</b>
            </div>
            {catalogState === "ready" && catalogManifest && (
              <div className="catalog-runtime-stats">
                <span>全体 <b>{catalogManifest.totalFaces.toLocaleString()}</b></span>
                <span>端末上 <b>{catalogCacheCount}</b></span>
                <span>先読み <b>{CATALOG_IMAGE_PRELOAD}</b></span>
              </div>
            )}
            <label className={`catalog-upload ${catalogState === "uploading" ? "disabled" : ""}`}>
              <input
                type="file"
                multiple
                onChange={uploadCatalog}
                disabled={catalogState === "uploading" || isLive || Boolean(bulkProgress)}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
              {catalogUploadProgress
                ? `${catalogUploadProgress.done.toLocaleString()} / ${catalogUploadProgress.total.toLocaleString()} 転送中`
                : catalogState === "ready"
                  ? "処理済みカタログを更新"
                  : "処理済みカタログを接続"}
            </label>
            <small>角度・表情を分散した15,000枚を内蔵済み。上向き・下向きの希少姿勢も優先収録し、スマホは数値索引から必要な画像だけ読み込みます。</small>
            <div className="catalog-auto-build">
              <div>
                <strong>カタログを拡張（PC）</strong>
                <span>別素材で15,000枚を作り直す場合だけ使用</span>
              </div>
              <div className="catalog-auto-controls">
                <select
                  value={bulkTarget}
                  onChange={(event) => setBulkTarget(Number(event.target.value))}
                  disabled={Boolean(bulkProgress)}
                  aria-label="自動構築する顔の枚数"
                >
                  <option value="15000">15,000 faces</option>
                </select>
                {bulkProgress ? (
                  <button
                    type="button"
                    className="catalog-cancel"
                    onClick={() => {
                      bulkCancelRef.current = true;
                    }}
                  >
                    中止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={buildRemoteFfhqCatalog}
                    disabled={engineState !== "ready" || isLive || isSearching || Boolean(progress)}
                  >
                    自動構築を開始
                  </button>
                )}
              </div>
              {bulkProgress ? (
                <div className="catalog-build-progress" aria-live="polite">
                  <span>
                    <i
                      style={{
                        width: `${Math.min(100, (bulkProgress.accepted / bulkProgress.target) * 100)}%`,
                      }}
                    />
                  </span>
                  <p>
                    {bulkPhaseLabel(bulkProgress.phase)} / 採用 {bulkProgress.accepted.toLocaleString()} / 目標 {bulkProgress.target.toLocaleString()}
                  </p>
                  <small>
                    確認 {bulkProgress.checked.toLocaleString()}・検出外 {bulkProgress.rejected.toLocaleString()}・範囲外 {bulkProgress.outsideBounds.toLocaleString()}・重複 {bulkProgress.duplicates.toLocaleString()}
                  </small>
                </div>
              ) : (
                <small>PC推奨。処理中はこのタブを開いたままにしてください。完成時だけ索引を切り替えるので、途中停止しても旧カタログは残ります。</small>
              )}
            </div>
            {catalogNetworkIssue && (
              <button
                type="button"
                className="catalog-retry"
                onClick={() => {
                  catalogRetryAfterRef.current.clear();
                  void loadCatalogNeighborhood(
                    liveFeature?.[0] ? liveFeature[0] * 90 : 0,
                    liveFeature?.[1] ? liveFeature[1] * 90 : 0,
                    true,
                  );
                }}
              >
                一部の顔を再読み込み
              </button>
            )}
          </div>
          <div className="ffhq-loader">
            <div>
              <strong>FFHQ / 70,000 FACES</strong>
              <span>
                {ffhqCount && poseCoverage
                  ? `${ffhqCount}枚 / 左右 ${poseCoverage.yawMin}°〜${poseCoverage.yawMax}° / 上下 ${poseCoverage.pitchMin}°〜${poseCoverage.pitchMax}° / ${poseCoverage.bins}区画`
                  : "整列済み128px素材"}
              </span>
            </div>
            <button
              type="button"
              onClick={collectFfhqFaces}
              disabled={engineState !== "ready" || isSearching || Boolean(progress) || Boolean(bulkProgress)}
            >
              {sourceTask === "ffhq" ? "FFHQ解析中…" : `FFHQを${FFHQ_BATCH_SIZE}枚探索する`}
            </button>
          </div>
          <p className="ffhq-note">
            非商用実験用。3°区画ごとに最大{MAX_ASSETS_PER_POSE_CELL}枚だけ残し、正面顔への偏りを抑えます。
          </p>

          <details className="source-fallback">
            <summary>角度や表情の不足分を公開検索で補う</summary>
            <div className="source-import">
              <div className="source-search">
                <input
                  type="search"
                  value={publicQuery}
                  onChange={(event) => {
                    setPublicQuery(event.target.value);
                    setPublicPage(1);
                  }}
                  placeholder="portrait face"
                  aria-label="公開顔素材の検索語"
                  disabled={isSearching || Boolean(progress) || Boolean(bulkProgress)}
                />
                <button
                  type="button"
                  onClick={collectPublicFaces}
                  disabled={engineState !== "ready" || isSearching || Boolean(progress) || Boolean(bulkProgress)}
                >
                  {sourceTask === "public" ? "収集中…" : `公開素材を${PUBLIC_BATCH_SIZE}枚集める`}
                </button>
              </div>
              <div className="source-presets" aria-label="検索プリセット">
                {SEARCH_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setPublicQuery(preset.query);
                      setPublicPage(1);
                    }}
                    disabled={isSearching || Boolean(progress) || Boolean(bulkProgress)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p>
                Openverseを優先し、取得できない場合はWikimedia Commonsへ切替。顔検出に通った画像だけを追加します。
              </p>
            </div>
          </details>
          {sourceMessage && <strong className="source-message">{sourceMessage}</strong>}
        </div>

        <section className="coverage-panel" aria-labelledby="coverage-title">
          <div className="coverage-heading">
            <div>
              <span id="coverage-title">POSE COVERAGE / YAW × PITCH</span>
              <small>左右 ±45°・上下 ±36°・3°刻み</small>
            </div>
            <strong>
              {coverageMap.covered}<small> / {coverageMap.total} 区画</small>
            </strong>
          </div>
          <div className="coverage-grid-shell">
            <div className="coverage-y-axis" aria-hidden="true">
              {COVERAGE_PITCHES.map((pitch) => (
                <span key={pitch}>{pitch > 0 ? "+" : ""}{pitch}</span>
              ))}
            </div>
            <div
              className="coverage-grid"
              role="img"
              aria-label={`${coverageMap.total}区画中${coverageMap.covered}区画に素材があります`}
            >
              {coverageMap.cells.map((cell) => (
                <i
                  key={cell.key}
                  className={`coverage-cell coverage-level-${Math.min(cell.count, MAX_ASSETS_PER_POSE_CELL)}${currentCoverageKey === cell.key ? " coverage-cell-current" : ""}`}
                  title={`左右 ${cell.yaw}° / 上下 ${cell.pitch}° / ${cell.count}枚`}
                  aria-hidden="true"
                />
              ))}
            </div>
          </div>
          <div className="coverage-x-axis" aria-hidden="true">
            <span>−45°</span><span>0°</span><span>＋45°</span>
          </div>
          <div className="coverage-legend">
            <span><i className="coverage-level-0" />不足</span>
            <span><i className="coverage-level-1" />1枚</span>
            <span><i className={`coverage-level-${MAX_ASSETS_PER_POSE_CELL}`} />充足</span>
            <span><i className="coverage-cell-current" />現在位置</span>
          </div>
        </section>

        <div className="primary-actions">
          <label className={`button button-primary ${engineState !== "ready" ? "disabled" : ""}`}>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={processFiles}
              disabled={engineState !== "ready" || isSearching || Boolean(progress) || Boolean(bulkProgress)}
            />
            {progress
              ? `${progress.done} / ${progress.total} 解析中`
              : assets.length
                ? "顔写真を追加"
                : "顔写真を選ぶ"}
          </label>
          <label
            className={`button button-video ${!assets.length || engineState !== "ready" ? "disabled" : ""}`}
          >
            <input
              type="file"
              accept="video/*,.mp4,.mov,.m4v,.webm"
              onChange={startVideoInput}
              disabled={!assets.length || engineState !== "ready" || isSearching || Boolean(progress) || Boolean(bulkProgress)}
            />
            動画で試す
          </label>
          <button
            className="button button-live"
            onClick={isLive ? stopLive : startLive}
            disabled={!assets.length || engineState !== "ready" || isSearching || Boolean(progress) || Boolean(bulkProgress)}
          >
            {isLive ? "追跡を停止" : "カメラで動かす"}
          </button>
        </div>

        {progress && (
          <div className="progress" aria-live="polite">
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            <p>{progress.rejected ? `${progress.rejected}枚は顔を検出できず除外` : "顔を検出して整列中"}</p>
          </div>
        )}

        {error && <p className="error-message">{error}</p>}
        {engineState !== "ready" && <p className="engine-message">{engineMessage}</p>}

        <div className="experiment-grid">
          <label>
            <span>切り抜き基準</span>
            <select
              value={cropMode}
              onChange={(event) => setCropMode(event.target.value as CropMode)}
              disabled={isLive || Boolean(progress) || Boolean(bulkProgress)}
            >
              <option value="eyes">目線固定</option>
              <option value="contour">輪郭中心</option>
            </select>
            <small>次に追加する画像へ適用</small>
          </label>

          <label>
            <span>選択方式</span>
            <select
              value={matchMode}
              onChange={(event) => setMatchMode(event.target.value as MatchMode)}
            >
              <option value="flow">同じ動きの別人を巡回</option>
              <option value="stable">角度追従（安定）</option>
              <option value="direct">最短一致（敏感）</option>
            </select>
            <small>初期値は近い顔を連続して入れ替え</small>
          </label>

          <label>
            <span>一致させる特徴</span>
            <select
              value={featureMode}
              onChange={(event) => setFeatureMode(event.target.value as FeatureMode)}
            >
              <option value="pose-expression">向き＋表情</option>
              <option value="pose">顔の向きだけ</option>
            </select>
            <small>笑顔・口開き・驚き・しかめ顔を追従</small>
          </label>

          <label className="range-control">
            <span>上下ランドマーク感度</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={pitchGain}
              onChange={(event) => setPitchGain(Number(event.target.value))}
            />
            <small>鼻・目・顎の比率 × {pitchGain.toFixed(1)}（開始時の正面を0°にします）</small>
          </label>

          <button
            type="button"
            className="pitch-recalibrate"
            disabled={!isLive}
            onClick={() => {
              landmarkPitchRef.current = createLandmarkPitchTracker();
              expressionTrackerRef.current = createExpressionTracker();
              selectionSequenceRef.current = 0;
              calibratingRef.current = true;
              setIsCalibrating(true);
              smoothedFeatureRef.current = null;
              setLiveFeature(null);
              setMatchScore(null);
            }}
          >
            <span>顔の基準</span>
            <strong>正面・無表情を再設定</strong>
            <small>正面・無表情で押し、約0.4秒そのまま</small>
          </button>

          <label className="range-control">
            <span>追従判定速度</span>
            <input
              type="range"
              min="2"
              max="18"
              step="1"
              value={changeRate}
              onChange={(event) => setChangeRate(Number(event.target.value))}
            />
            <small>{changeRate} checks / second</small>
          </label>
        </div>

        <div className="asset-strip">
          <div className="section-label">
            <span>PROCESSED FACES</span>
            {assets.length > 0 && (
              <button onClick={clearAssets} type="button">
                すべて消去
              </button>
            )}
          </div>
          {visibleAssets.length ? (
            <div className="thumbs">
              {visibleAssets.map((asset) => (
                <figure key={asset.id}>
                  <img src={asset.url} alt="整列済み顔写真" />
                  <figcaption>{formatPoseShort(asset.feature)}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="asset-empty">
              手動素材は最大{MAX_FILES}枚。大量素材は処理済みカタログから角度周辺だけ読み込みます。
            </p>
          )}
        </div>

        {ffhqCount > 0 && (
          <div className="dataset-credit">
            <strong>FFHQ / {ffhqCount} faces</strong>
            <span>非商用・切り抜き／3°姿勢タグを追加</span>
            <a
              href="https://github.com/NVlabs/ffhq-dataset"
              target="_blank"
              rel="noreferrer"
            >
              Dataset &amp; license
            </a>
          </div>
        )}

        {creditedAssets.length > 0 && (
          <details className="credits">
            <summary>公開素材の出典・ライセンス（{creditedAssets.length}件）</summary>
            <ul>
              {creditedAssets.slice(-60).reverse().map((asset) => (
                <li key={asset.id}>
                  <a href={asset.sourceUrl} target="_blank" rel="noreferrer">
                    {asset.name}
                  </a>
                  <span>{asset.creator || "作者不明"}</span>
                  {asset.licenseUrl ? (
                    <a href={asset.licenseUrl} target="_blank" rel="noreferrer">
                      {asset.license}
                    </a>
                  ) : (
                    <span>{asset.license}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <footer>
        <p>手動追加画像は端末メモリだけで処理。処理済みカタログは角度ごとに必要分のみ配信します。</p>
        <p>FFHQ © original Flickr photographers / CC BY-NC-SA 4.0. Openverseは不足素材の補助に使用。</p>
      </footer>
    </main>
  );
}

export default function Home() {
  return <OfflineVideoLab />;
}
