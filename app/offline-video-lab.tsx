"use client";
/* eslint-disable @next/next/no-img-element */

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
import { expressionLabel } from "./expression-matching";
import { faceFeatureFromScores } from "./face-actions";
import {
  alignmentTransform,
  faceGeometryFromLandmarks,
  objectFitCoverLayout,
  optimizeFaceSequenceBeams,
  type FaceGeometry,
  type SequenceChoice,
  type SequenceFrame,
} from "./offline-matching";
import {
  BROWS,
  FACE_OVAL,
  INNER_LIPS,
  LEFT_EYE,
  NOSE,
  optimizeDistinctProjectionSequence,
  OUTER_LIPS,
  PROJECTION_RANK_MODES,
  projectionError,
  rankProjectionCandidateModes,
  rankProjectionCandidateModesTwoStage,
  RIGHT_EYE,
  type ProjectionError,
  type ProjectionRankMode,
} from "./projection-matching";
import { ANALYSIS_CHUNK_SECONDS, buildAnalysisChunks } from "./video-chunking";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const TEST_VIDEO_URL = "/test-fixtures/reference-face-motion.mp4";
const TEST_ANALYSIS_URL = "/test-fixtures/reference-face-motion-analysis.json";
const TEST_RANKINGS_URL = "/test-fixtures/reference-face-motion-rankings.json";
const INDEX_BEAM_PER_FRAME = 64;
const DEFAULT_SAMPLE_RATE = 30;
const DEFAULT_COOLDOWN = 12;
const DEFAULT_QUALITY_THRESHOLD = 0.055;

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
  sourceUrl?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
};

type CatalogManifest = {
  schemaVersion: 1 | 2 | 3;
  catalogId?: string;
  generatedAt?: string;
  shapeVersion?: string;
  indexFile?: string;
  indexFiles?: string[];
  featureLength?: number;
  shardsContainGeometry?: boolean;
  totalFaces: number;
  poseStep: number;
  bounds: {
    yawMin: number;
    yawMax: number;
    pitchMin: number;
    pitchMax: number;
  };
  cells: Record<string, { count: number; shards: string[]; shard?: string }>;
};

type OfflineCandidate = {
  id: string;
  name: string;
  url: string;
  feature: number[];
  geometry: FaceGeometry;
  sourceName?: string;
  sourceUrl?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
};

type Phase =
  | "preparing"
  | "ready"
  | "scanning"
  | "catalog"
  | "geometry"
  | "optimizing"
  | "done"
  | "error";

type Progress = {
  done: number;
  total: number;
  label: string;
};

type Segment = {
  start: number;
  end: number;
  candidate: OfflineCandidate;
};

type CatalogScanStats = {
  indexed: number;
  searched: number;
  beam: number;
  imageLoads: number;
};

type SearchMode = ProjectionRankMode | "legacy";
type DisplayMode = "raw" | "face" | "split";

type VideoSource = {
  name: string;
  url: string;
  revokeOnReplace: boolean;
  analysisUrl?: string;
  rankingsUrl?: string;
};

type CachedAnalysisFrame = {
  time: number;
  feature: number[];
  shape: string;
  mesh: string;
  projection: string;
  layout: [number, number, number, number];
};

type CachedAnalysis = {
  schemaVersion: 1;
  duration: number;
  sampleRate: number;
  frames: CachedAnalysisFrame[];
};

type CachedRankings = {
  schemaVersion: 1 | 2;
  indexBytes?: 2 | 4;
  catalogId?: string;
  candidateCount: number;
  beamSize: number;
  frameTimes: number[];
  beams: Record<ProjectionRankMode, string[]>;
  sequences?: Partial<Record<ProjectionRankMode, string>>;
};

type LabChoice = SequenceChoice<OfflineCandidate> & {
  error?: ProjectionError;
  accepted?: boolean;
  expressionMotion?: number;
};

type RankedCandidate = {
  candidate: OfflineCandidate;
  error: ProjectionError;
};

type RankedBeamMap = Partial<Record<ProjectionRankMode, RankedCandidate[][]>>;

const MODE_LABELS: Record<ProjectionRankMode, string> = {
  strict: "V5：母音と局所の最悪値を潰す",
  semantic: "V4：表情動作を優先",
  expression: "V3：表情と動きを優先",
  eyes: "実験：目・眉を優先",
  mouth: "実験：口を優先",
  balanced: "V2：輪郭中心",
};

const MODE_SEQUENCE_OPTIONS: Record<ProjectionRankMode, {
  beamWidth: number;
  residualCoherence: number;
  expressionMotionWeight: number;
  motionWeights: { mouth: number; eyes: number; brows: number };
}> = {
  strict: {
    beamWidth: 24,
    residualCoherence: 0.46,
    expressionMotionWeight: 6.2,
    motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
  },
  semantic: {
    beamWidth: 22,
    residualCoherence: 0.48,
    expressionMotionWeight: 5.8,
    motionWeights: { mouth: 0.42, eyes: 0.34, brows: 0.24 },
  },
  expression: {
    beamWidth: 20,
    residualCoherence: 0.55,
    expressionMotionWeight: 4.8,
    motionWeights: { mouth: 0.58, eyes: 0.27, brows: 0.15 },
  },
  eyes: {
    beamWidth: 22,
    residualCoherence: 0.48,
    expressionMotionWeight: 6.2,
    motionWeights: { mouth: 0.12, eyes: 0.56, brows: 0.32 },
  },
  mouth: {
    beamWidth: 22,
    residualCoherence: 0.48,
    expressionMotionWeight: 6.2,
    motionWeights: { mouth: 0.76, eyes: 0.14, brows: 0.1 },
  },
  balanced: {
    beamWidth: 16,
    residualCoherence: 0.65,
    expressionMotionWeight: 0,
    motionWeights: { mouth: 0.5, eyes: 0.3, brows: 0.2 },
  },
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

function waitForVideo(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2 && Number.isFinite(video.duration)) {
      resolve();
      return;
    }
    const cleanup = () => {
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("error", failed);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("動画を開けませんでした"));
    };
    video.addEventListener("loadeddata", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const target = clamp(time, 0, Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) {
      requestAnimationFrame(() => resolve());
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("動画フレームの読み込みが止まりました"));
    }, 6_000);
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
      reject(new Error("動画フレームを読み込めませんでした"));
    };
    video.addEventListener("seeked", finished, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.currentTime = target;
  });
}

function cellValue(value: number, min: number, max: number, step: number) {
  return clamp(Math.round(value / step) * step, min, max);
}

function nearbyCells(manifest: CatalogManifest, feature: number[]) {
  const yaw = cellValue(
    feature[0] * 90,
    manifest.bounds.yawMin,
    manifest.bounds.yawMax,
    manifest.poseStep,
  );
  const pitch = cellValue(
    feature[1] * 90,
    manifest.bounds.pitchMin,
    manifest.bounds.pitchMax,
    manifest.poseStep,
  );
  const cells: Array<{ key: string; distance: number }> = [];
  // Pitch estimates are noisier than yaw, so search a taller neighborhood.
  // The catalog shard remains the coarse index; exact 3D mesh comparison comes later.
  for (let y = -2; y <= 2; y += 1) {
    for (let p = -3; p <= 3; p += 1) {
      const key = `${yaw + y * manifest.poseStep}:${pitch + p * manifest.poseStep}`;
      if (manifest.cells[key]) cells.push({ key, distance: y * y + p * p });
    }
  }
  return cells.sort((left, right) => left.distance - right.distance).map(({ key }) => key);
}

function entryUrl(entry: CatalogEntry) {
  if (entry.image) {
    return `/api/catalog/image?id=${encodeURIComponent(entry.image)}`;
  }
  return `/api/catalog/image?pack=${encodeURIComponent(entry.pack ?? "")}&offset=${entry.offset}&length=${entry.length}`;
}

function decodeVector(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.byteLength % 2) return null;
    const values = new Int16Array(bytes.buffer);
    return Float32Array.from(values, (value) => value / 4096);
  } catch {
    return null;
  }
}

function decodeIndexes(encoded: string | undefined, indexBytes: 2 | 4 = 2) {
  if (!encoded) return [];
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.byteLength % indexBytes) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: bytes.byteLength / indexBytes }, (_, index) =>
      indexBytes === 4
        ? view.getUint32(index * indexBytes, true)
        : view.getUint16(index * indexBytes, true)
    );
  } catch {
    return [];
  }
}

function cachedSequenceFrame(frame: CachedAnalysisFrame): SequenceFrame | null {
  const structure = decodeVector(frame.shape);
  const surface = decodeVector(frame.mesh);
  const projection = decodeVector(frame.projection);
  const geometry = structure && surface && projection
    ? { structure, surface, projection, layout: frame.layout }
    : null;
  if (!geometry || !validGeometry(geometry) || !Array.isArray(frame.feature)) return null;
  return { time: frame.time, feature: frame.feature, geometry };
}

async function fetchCatalogEntries(
  manifest: CatalogManifest,
  frames: SequenceFrame[],
  onProgress: (progress: Progress) => void,
  isCancelled: () => boolean,
) {
  const indexFiles = manifest.indexFiles?.length
    ? manifest.indexFiles
    : manifest.indexFile
      ? [manifest.indexFile]
      : [];
  if (indexFiles.length) {
    const entries: CatalogEntry[] = [];
    for (let index = 0; index < indexFiles.length; index += 2) {
      if (isCancelled()) throw new DOMException("Cancelled", "AbortError");
      const batch = indexFiles.slice(index, index + 2);
      const payloads = await Promise.all(batch.map(async (file) => {
        const catalogVersion = manifest.catalogId || manifest.generatedAt || "current";
        const response = await fetch(
          `/api/catalog/index?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalogVersion)}`,
        );
        if (!response.ok) throw new Error(`顔ベクトル索引を取得できませんでした (${response.status})`);
        return response.json() as Promise<{ items?: CatalogEntry[] }>;
      }));
      payloads.forEach((payload) => entries.push(...(payload.items ?? [])));
      onProgress({
        done: Math.min(index + batch.length, indexFiles.length),
        total: indexFiles.length,
        label: "全顔投影索引を読み込み中",
      });
    }
    return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
      .filter((entry) =>
        Array.isArray(entry.feature) && entry.feature.length >= 22 &&
        Boolean(entry.shape) && Boolean(entry.mesh) && Boolean(entry.projection) &&
        Array.isArray(entry.layout) && entry.layout.length === 4,
      );
  }
  const cells = new Set(frames.flatMap((frame) => nearbyCells(manifest, frame.feature)));
  const shardFiles = [...cells].flatMap((key) => {
    const cell = manifest.cells[key];
    return cell?.shards?.length ? cell.shards : cell?.shard ? [cell.shard] : [];
  });
  const uniqueShards = [...new Set(shardFiles)];
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < uniqueShards.length; index += 6) {
    if (isCancelled()) throw new DOMException("Cancelled", "AbortError");
    const batch = uniqueShards.slice(index, index + 6);
    const payloads = await Promise.all(batch.map(async (file) => {
      const catalogVersion = manifest.catalogId || manifest.generatedAt || "current";
      const response = await fetch(
        `/api/catalog/shard?file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalogVersion)}`,
      );
      if (!response.ok) throw new Error(`顔カタログを取得できませんでした (${response.status})`);
      return response.json() as Promise<{ items?: CatalogEntry[] }>;
    }));
    payloads.forEach((payload) => entries.push(...(payload.items ?? [])));
    onProgress({
      done: Math.min(index + batch.length, uniqueShards.length),
      total: uniqueShards.length,
      label: "必要な角度の顔を収集中",
    });
  }
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .filter((entry) =>
      Array.isArray(entry.feature) && entry.feature.length >= 22 &&
      Boolean(entry.shape) && Boolean(entry.mesh) && Boolean(entry.projection) &&
      Array.isArray(entry.layout) && entry.layout.length === 4,
    );
}

function validGeometry(value: unknown): value is FaceGeometry {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Partial<FaceGeometry>;
  const isVector = (vector: unknown, minimum: number) =>
    (Array.isArray(vector) || vector instanceof Float32Array) && vector.length >= minimum;
  return isVector(geometry.structure, 13) &&
    isVector(geometry.surface, 300) &&
    isVector(geometry.projection, 936) &&
    Array.isArray(geometry.layout) && geometry.layout.length === 4;
}

function indexedCandidate(entry: CatalogEntry): OfflineCandidate | null {
  const structure = decodeVector(entry.shape);
  const surface = decodeVector(entry.mesh);
  const projection = decodeVector(entry.projection);
  const geometry = structure && surface && projection && entry.layout
    ? { structure, surface, projection, layout: entry.layout }
    : null;
  if (!geometry || !validGeometry(geometry)) return null;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url: entryUrl(entry),
    feature: entry.feature,
    geometry,
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
    creator: entry.creator,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
  };
}

async function searchProjectionBeams(
  frames: SequenceFrame[],
  candidates: OfflineCandidate[],
  onProgress: (progress: Progress) => void,
  isCancelled: () => boolean,
) {
  const beams = Object.fromEntries(
    PROJECTION_RANK_MODES.map((mode) => [mode, []]),
  ) as Record<ProjectionRankMode, RankedCandidate[][]>;
  let comparisons = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    if (isCancelled()) throw new DOMException("Cancelled", "AbortError");
    const frame = frames[frameIndex];
    const withinPose = (yawLimit: number, pitchLimit: number) => candidates.filter((candidate) =>
      Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90 <= yawLimit &&
      Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90 <= pitchLimit
    );
    let localCandidates = withinPose(12, 15);
    if (localCandidates.length < Math.min(384, candidates.length)) {
      localCandidates = withinPose(18, 21);
    }
    if (localCandidates.length < 4) localCandidates = candidates;
    const ranked = rankProjectionCandidateModesTwoStage(
      frame,
      localCandidates,
      INDEX_BEAM_PER_FRAME,
      Math.min(1_024, localCandidates.length),
    );
    comparisons += localCandidates.length;
    PROJECTION_RANK_MODES.forEach((mode) => beams[mode].push(ranked[mode]));
    if (frameIndex % 6 === 5 || frameIndex + 1 === frames.length) {
      onProgress({
        done: frameIndex + 1,
        total: frames.length,
        label: `角度で絞り込み・詳細形状を2段階照合中（${comparisons.toLocaleString()} comparisons）`,
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  if (PROJECTION_RANK_MODES.some((mode) => beams[mode].some((beam) => !beam.length))) {
    throw new Error("投影形状を比較できる候補がありませんでした");
  }
  return { beams, comparisons };
}

async function preloadImages(
  urls: string[],
  onProgress: (loaded: number) => void,
  isCancelled: () => boolean,
  concurrency = 12,
) {
  if (!urls.length) return;
  let nextIndex = 0;
  let loaded = 0;
  const worker = async () => {
    while (!isCancelled()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= urls.length) return;
      await new Promise<void>((resolve) => {
        const image = new Image();
        image.decoding = "async";
        const finish = () => resolve();
        image.onload = finish;
        image.onerror = finish;
        image.src = urls[index];
      });
      loaded += 1;
      onProgress(loaded);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()),
  );
}

function resultIndexAtTime(sequence: LabChoice[], time: number) {
  if (!sequence.length) return -1;
  let low = 0;
  let high = sequence.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sequence[middle].frame.time <= time) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function resultAtTime(sequence: LabChoice[], time: number) {
  const index = resultIndexAtTime(sequence, time);
  return index >= 0 ? sequence[index] : null;
}

function assessCoverage(
  strictBeam: RankedCandidate[],
  selected: LabChoice | null,
) {
  const best = strictBeam[0];
  if (!best) return null;
  const bestWorst = best.error.worstLocal;
  const selectedWorst = selected?.error?.worstLocal ?? bestWorst;
  if (bestWorst > 0.062) {
    return {
      tone: "gap",
      label: "DATA GAP",
      text: "形を保ったまま目・眉・口まで近い素材が上位候補にありません。画像側の不足が濃いフレームです。",
    };
  }
  if (selectedWorst > bestWorst * 1.22) {
    return {
      tone: "path",
      label: "PATH TRADEOFF",
      text: "近い一枚はありますが、別人制約や前後フレームとの連続性で別候補が選ばれています。",
    };
  }
  if (best.error.blendshape > 0.16) {
    return {
      tone: "semantic",
      label: "ACTION GAP",
      text: "点の形は近い一方、笑う・瞬く・眉を上げるなどの動作値が離れています。",
    };
  }
  return {
    tone: "found",
    label: "CANDIDATE FOUND",
    text: "このフレームには近い候補があります。違和感が残るなら評価式か時間経路の問題です。",
  };
}

function buildSegments(sequence: LabChoice[], duration: number) {
  const segments: Segment[] = [];
  sequence.forEach((choice) => {
    const previous = segments[segments.length - 1];
    if (!previous || previous.candidate.id !== choice.candidate.id) {
      if (previous) previous.end = choice.frame.time;
      segments.push({
        start: choice.frame.time,
        end: duration,
        candidate: choice.candidate,
      });
    }
  });
  return segments;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function formatPose(feature: number[] | undefined) {
  if (!feature) return "—";
  return feature.slice(0, 3).map((value) => `${Math.round(value * 90)}°`).join(" / ");
}

function polylinePoints(projection: ArrayLike<number>, indexes: readonly number[]) {
  return indexes
    .flatMap((index) => {
      const offset = index * 2;
      const x = projection[offset];
      const y = projection[offset + 1];
      return Number.isFinite(x) && Number.isFinite(y) ? [`${x},${y}`] : [];
    })
    .join(" ");
}

const OVERLAY_REGIONS = [FACE_OVAL, LEFT_EYE, RIGHT_EYE, OUTER_LIPS, INNER_LIPS, NOSE, BROWS];

function ProjectionOverlay({ choice }: { choice: LabChoice }) {
  if (!choice.error) return null;
  const target = choice.frame.geometry.projection;
  const candidate = choice.candidate.geometry.projection;
  return (
    <div className={`offline-projection-diagnostic ${choice.accepted ? "match" : "miss"}`} aria-label="入力と候補のFace Mesh誤差">
      <div>
        <strong>{choice.accepted ? "MATCH" : "MISS"}</strong>
        <span>INPUT</span><i className="target" />
        <span>CANDIDATE</span><i className="candidate" />
      </div>
      <svg viewBox="-1.65 -1.15 3.3 3.75" role="img">
        {OVERLAY_REGIONS.map((region, index) => (
          <polyline key={`target-${index}`} className="target" points={polylinePoints(target, region)} />
        ))}
        {OVERLAY_REGIONS.map((region, index) => (
          <polyline key={`candidate-${index}`} className="candidate" points={polylinePoints(candidate, region)} />
        ))}
      </svg>
    </div>
  );
}

function faceMaskGradient(choice: LabChoice) {
  const [centerX, centerY, width, height] = choice.candidate.geometry.layout;
  const radiusX = clamp(width * 52, 19, 43);
  const radiusY = clamp(height * 54, 25, 49);
  const center = `${clamp(centerX * 100, 15, 85)}% ${clamp(centerY * 100, 15, 85)}%`;
  return `radial-gradient(ellipse ${radiusX}% ${radiusY}% at ${center}, #000 70%, rgba(0,0,0,.92) 82%, transparent 100%)`;
}

function MatchedFace({
  choice,
  alignment,
  displayMode,
}: {
  choice: LabChoice;
  alignment: { xPercent: number; yPercent: number; scale: number };
  displayMode: DisplayMode;
}) {
  const transform = `translate(${alignment.xPercent}%, ${alignment.yPercent}%) scale(${alignment.scale})`;
  return (
    <>
      <img
        className="offline-raw-face"
        src={choice.candidate.url}
        alt="入力の投影形状に最も近い顔"
        draggable={false}
        style={{ transform }}
      />
      {displayMode !== "raw" && (
        <div className={`offline-face-isolation offline-face-isolation-${displayMode}`} aria-hidden="true">
          <img
            src={choice.candidate.url}
            alt=""
            draggable={false}
            style={{
              transform,
              maskImage: faceMaskGradient(choice),
              WebkitMaskImage: faceMaskGradient(choice),
            }}
          />
        </div>
      )}
      {displayMode === "split" && (
        <div className="offline-ab-labels" aria-hidden="true"><span>RAW</span><span>FACE ONLY</span></div>
      )}
    </>
  );
}

export default function OfflineVideoLab() {
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const analysisTokenRef = useRef(0);
  const sequenceTokenRef = useRef(0);
  const rawFramesRef = useRef<SequenceFrame[]>([]);
  const candidateBeamsRef = useRef<OfflineCandidate[][]>([]);
  const rankedBeamsRef = useRef<RankedBeamMap>({});

  const [phase, setPhase] = useState<Phase>("preparing");
  const [engineReady, setEngineReady] = useState(false);
  const [manifest, setManifest] = useState<CatalogManifest | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [sourceAspectRatio, setSourceAspectRatio] = useState(1);
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE);
  const [searchMode, setSearchMode] = useState<SearchMode>("strict");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("split");
  const [coherence, setCoherence] = useState(78);
  const [cooldown, setCooldown] = useState(DEFAULT_COOLDOWN);
  const [qualityThreshold, setQualityThreshold] = useState(DEFAULT_QUALITY_THRESHOLD);
  const [catalogStats, setCatalogStats] = useState<CatalogScanStats | null>(null);
  const [rankedBeams, setRankedBeams] = useState<RankedBeamMap>({});
  const [rankingsReady, setRankingsReady] = useState(false);
  const [sequence, setSequence] = useState<LabChoice[]>([]);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    let disposed = false;
    let catalogReady = false;
    async function prepare() {
      try {
        const manifestResponse = await fetch("/api/catalog/manifest", { cache: "no-store" });
        if (!manifestResponse.ok) throw new Error("顔カタログへ接続できませんでした");
        const catalog = await manifestResponse.json() as CatalogManifest;
        if (disposed) return;
        catalogReady = true;
        setManifest(catalog);
        setPhase("ready");
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
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
        } catch (gpuError) {
          console.warn("GPU face mesh unavailable; using CPU.", gpuError);
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
        setEngineReady(true);
      } catch (caught) {
        console.error(caught);
        if (!disposed) {
          // The bundled verification run does not need a local Face Landmarker.
          // Keep it usable on devices and browser sandboxes without WebGL.
          if (!catalogReady) {
            setError(caught instanceof Error ? caught.message : "顔カタログを準備できませんでした");
            setPhase("error");
          }
        }
      }
    }
    void prepare();
    return () => {
      disposed = true;
      analysisTokenRef.current += 1;
      landmarkerRef.current?.close();
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  const recomputeSequence = useCallback((
    nextMode = searchMode,
    nextCoherence = coherence,
    nextCooldown = cooldown,
    nextQualityThreshold = qualityThreshold,
  ) => {
    if (!rawFramesRef.current.length || !candidateBeamsRef.current.length) return;
    setPhase("optimizing");
    const projectionMode = nextMode === "legacy" ? null : nextMode;
    const rankedBeams = projectionMode ? rankedBeamsRef.current[projectionMode] : null;
    if (projectionMode && !rankedBeams?.length) return;
    const modeOptions = projectionMode ? MODE_SEQUENCE_OPTIONS[projectionMode] : null;
    const result: LabChoice[] = projectionMode && rankedBeams && modeOptions
      ? optimizeDistinctProjectionSequence(rawFramesRef.current, rankedBeams, {
        cooldown: nextCooldown,
        qualityThreshold: nextQualityThreshold,
        ...modeOptions,
      })
      : optimizeFaceSequenceBeams(rawFramesRef.current, candidateBeamsRef.current, {
        coherence: nextCoherence / 100,
        beamWidth: 16,
      });
    const uniqueImages = [...new Set(result.map((choice) => choice.candidate.url))];
    const initialImages = uniqueImages.slice(0, 24);
    const backgroundImages = uniqueImages.slice(initialImages.length);
    const sequenceToken = sequenceTokenRef.current + 1;
    sequenceTokenRef.current = sequenceToken;
    setProgress({ done: 0, total: initialImages.length, label: "冒頭の採用フレームを先読み中" });
    void preloadImages(
      initialImages,
      (loaded) => {
        if (sequenceTokenRef.current === sequenceToken) {
          setProgress({ done: loaded, total: initialImages.length, label: "冒頭の採用フレームを先読み中" });
        }
      },
      () => sequenceTokenRef.current !== sequenceToken,
    ).then(() => {
      if (sequenceTokenRef.current !== sequenceToken) return;
      setCatalogStats((stats) => stats ? { ...stats, imageLoads: initialImages.length } : stats);
      setSequence(result);
      setPlaybackTime(0);
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
      setProgress(null);
      setPhase("done");
      void preloadImages(
        backgroundImages,
        () => {},
        () => sequenceTokenRef.current !== sequenceToken,
      ).then(() => {
        if (sequenceTokenRef.current === sequenceToken) {
          setCatalogStats((stats) => stats ? { ...stats, imageLoads: uniqueImages.length } : stats);
        }
      });
    });
  }, [coherence, cooldown, qualityThreshold, searchMode]);

  const analyzeVideo = useCallback(async (source: VideoSource) => {
    const landmarker = landmarkerRef.current;
    const video = videoRef.current;
    const hasPrecomputedRun = Boolean(source.analysisUrl && source.rankingsUrl);
    if (!video || !manifest || (!landmarker && !hasPrecomputedRun)) return;
    const token = analysisTokenRef.current + 1;
    analysisTokenRef.current = token;
    sequenceTokenRef.current += 1;
    const cancelled = () => analysisTokenRef.current !== token;
    setError(null);
    setCatalogStats(null);
    setSequence([]);
    rawFramesRef.current = [];
    candidateBeamsRef.current = [];
    rankedBeamsRef.current = {};
    setRankedBeams({});
    setRankingsReady(false);
    setFileName(source.name);
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = source.revokeOnReplace ? source.url : null;
    video.src = source.url;
    video.load();

    try {
      await waitForVideo(video);
      const analysisDuration = video.duration;
      if (!Number.isFinite(analysisDuration) || analysisDuration <= 0) {
        throw new Error("動画の長さを取得できませんでした");
      }
      setDuration(analysisDuration);
      setSourceAspectRatio(
        video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : 1,
      );
      video.pause();

      if (source.analysisUrl && source.rankingsUrl) {
        setPhase("scanning");
        setProgress({ done: 0, total: 3, label: "事前解析済みFace Meshを読み込み中" });
        const [analysisResponse, rankingsResponse] = await Promise.all([
          fetch(source.analysisUrl),
          fetch(`${source.rankingsUrl}?catalog=${encodeURIComponent(manifest.catalogId || manifest.generatedAt || "current")}`),
        ]);
        if (!analysisResponse.ok) {
          throw new Error("固定動画の事前解析結果を読み込めませんでした");
        }
        const [analysis, rankingCache] = await Promise.all([
          analysisResponse.json() as Promise<CachedAnalysis>,
          rankingsResponse.ok
            ? rankingsResponse.json() as Promise<CachedRankings>
            : Promise.resolve(null),
        ]);
        const frames = analysis.frames.flatMap((frame) => {
          const decoded = cachedSequenceFrame(frame);
          return decoded ? [decoded] : [];
        });
        if (frames.length < 2) {
          throw new Error("固定動画の事前解析結果が壊れています");
        }
        const cacheMatchesCatalog = Boolean(
          rankingCache &&
          rankingCache.frameTimes.length === frames.length &&
          (!manifest.catalogId || rankingCache.catalogId === manifest.catalogId),
        );
        if (!cacheMatchesCatalog) {
          setProgress({ done: 1, total: 3, label: "新しい顔カタログを読み込み中" });
          setPhase("catalog");
          const entries = await fetchCatalogEntries(
            manifest,
            frames,
            (next) => setProgress({
              done: 1 + 0.7 * (next.total ? next.done / next.total : 0),
              total: 3,
              label: next.label,
            }),
            cancelled,
          );
          const indexed = entries.flatMap((entry) => {
            const candidate = indexedCandidate(entry);
            return candidate ? [candidate] : [];
          });
          if (indexed.length < 4) {
            throw new Error("骨格比較に使える索引済み顔素材が足りませんでした");
          }
          setPhase("geometry");
          const projectionSearch = await searchProjectionBeams(
            frames,
            indexed,
            (next) => setProgress({
              done: 1.7 + 1.3 * (next.total ? next.done / next.total : 0),
              total: 3,
              label: `解析済み動画を新カタログで再検索中 · ${next.label}`,
            }),
            cancelled,
          );
          rawFramesRef.current = frames;
          rankedBeamsRef.current = projectionSearch.beams;
          candidateBeamsRef.current = projectionSearch.beams.balanced.map((beam) =>
            beam.map(({ candidate }) => candidate)
          );
          setRankedBeams(projectionSearch.beams);
          setRankingsReady(true);
          setCatalogStats({
            indexed: manifest.totalFaces,
            searched: projectionSearch.comparisons,
            beam: INDEX_BEAM_PER_FRAME,
            imageLoads: 0,
          });
          setProgress(null);
          recomputeSequence(searchMode, coherence, cooldown, qualityThreshold);
          return;
        }
        // The cache is narrowed above; keeping the guard local makes future
        // catalog upgrades fall back to mesh search without re-running Face Mesh.
        if (!rankingCache) throw new Error("固定動画の候補キャッシュが壊れています");
        setProgress({ done: 1, total: 3, label: "事前探索済み候補を復元中" });
        setPhase("catalog");
        const entries = await fetchCatalogEntries(
          manifest,
          frames,
          (next) => setProgress({
            done: 1 + 0.7 * (next.total ? next.done / next.total : 0),
            total: 3,
            label: next.label,
          }),
          cancelled,
        );
        if (entries.length !== rankingCache.candidateCount) {
          throw new Error(
            `固定動画の候補キャッシュ件数が現在の顔カタログと一致しません (${entries.length.toLocaleString()} / ${rankingCache.candidateCount.toLocaleString()})`,
          );
        }
        const cachedStrictIndexes = decodeIndexes(
          rankingCache.sequences?.strict,
          rankingCache.indexBytes ?? (rankingCache.schemaVersion >= 2 ? 4 : 2),
        );
        const useCachedStrictSequence = searchMode === "strict" &&
          cachedStrictIndexes.length === frames.length;
        if (useCachedStrictSequence) {
          const selectedCandidateCache = new Map<number, OfflineCandidate>();
          const cachedChoices = frames.map((frame, frameIndex) => {
            const candidateIndex = cachedStrictIndexes[frameIndex];
            let candidate = selectedCandidateCache.get(candidateIndex);
            if (!candidate) {
              const decoded = indexedCandidate(entries[candidateIndex]);
              if (decoded) {
                candidate = decoded;
                selectedCandidateCache.set(candidateIndex, decoded);
              }
            }
            if (!candidate) throw new Error("固定動画の選択済み経路を復元できませんでした");
            const candidateError = projectionError(frame, candidate);
            return {
              frame,
              candidate,
              emission: candidateError.strictTotal,
              error: { ...candidateError, total: candidateError.strictTotal },
              accepted: candidateError.strictTotal <= qualityThreshold,
              expressionMotion: 0,
            } satisfies LabChoice;
          });
          rawFramesRef.current = frames;
          setCatalogStats({
            indexed: manifest.totalFaces,
            searched: frames.length * rankingCache.candidateCount,
            beam: rankingCache.beamSize,
            imageLoads: 0,
          });
          setSequence(cachedChoices);
          setPlaybackTime(0);
          video.currentTime = 0;
          setPhase("done");
          const selectedUrls = [...new Set(cachedChoices.map((choice) => choice.candidate.url))];
          void preloadImages(
            selectedUrls,
            () => {},
            cancelled,
          ).then(() => {
            if (!cancelled()) {
              setCatalogStats((stats) => stats ? { ...stats, imageLoads: selectedUrls.length } : stats);
            }
          });
        }
        const indexed = entries.flatMap((entry) => {
          const candidate = indexedCandidate(entry);
          return candidate ? [candidate] : [];
        });
        if (indexed.length !== rankingCache.candidateCount) {
          throw new Error("固定動画の候補ベクトルを復元できませんでした");
        }
        setProgress({ done: 2, total: 3, label: "ウィンク・上下姿勢を再評価中" });
        if (!useCachedStrictSequence) setPhase("geometry");
        const allRankedBeams = Object.fromEntries(
          PROJECTION_RANK_MODES.map((mode) => [mode, []]),
        ) as Record<ProjectionRankMode, RankedCandidate[][]>;
        const allCandidateBeams: OfflineCandidate[][] = [];
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
          if (cancelled()) throw new DOMException("Cancelled", "AbortError");
          const candidateIndexes = new Set<number>();
          for (const mode of PROJECTION_RANK_MODES) {
            for (const index of decodeIndexes(
              rankingCache.beams[mode]?.[frameIndex],
              rankingCache.indexBytes ?? (rankingCache.schemaVersion >= 2 ? 4 : 2),
            )) {
              if (index < indexed.length) candidateIndexes.add(index);
            }
          }
          const candidates = [...candidateIndexes].map((index) => indexed[index]);
          if (!candidates.length) throw new Error("事前探索済み候補を復元できませんでした");
          const ranked = rankProjectionCandidateModes(
            frames[frameIndex],
            candidates,
            Math.min(INDEX_BEAM_PER_FRAME, candidates.length),
          );
          for (const mode of PROJECTION_RANK_MODES) {
            allRankedBeams[mode].push(ranked[mode]);
          }
          allCandidateBeams.push(ranked.balanced.map(({ candidate }) => candidate));
          if (frameIndex % 12 === 11 || frameIndex + 1 === frames.length) {
            setProgress({
              done: 2 + (frameIndex + 1) / frames.length,
              total: 3,
              label: `候補を再評価中（${frameIndex + 1}/${frames.length} frames）`,
            });
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
        }
        rawFramesRef.current = frames;
        rankedBeamsRef.current = allRankedBeams;
        candidateBeamsRef.current = allCandidateBeams;
        setRankedBeams(allRankedBeams);
        setRankingsReady(true);
        setCatalogStats({
          indexed: manifest.totalFaces,
          searched: frames.length * rankingCache.candidateCount,
          beam: rankingCache.beamSize,
          imageLoads: 0,
        });
        setProgress(null);
        if (!useCachedStrictSequence) {
          recomputeSequence(searchMode, coherence, cooldown, qualityThreshold);
        }
        return;
      }

      if (!landmarker) throw new Error("この端末では新しい動画のFace Mesh解析を開始できません");
      const chunks = buildAnalysisChunks(
        analysisDuration,
        sampleRate,
        ANALYSIS_CHUNK_SECONDS,
      );
      if (!chunks.length) throw new Error("動画の解析区間を作れませんでした");
      await landmarker.setOptions({ runningMode: "IMAGE" });
      await landmarker.setOptions({ runningMode: "VIDEO" });
      const allFrames: SequenceFrame[] = [];
      const allCandidateBeams: OfflineCandidate[][] = [];
      const allRankedBeams = Object.fromEntries(
        PROJECTION_RANK_MODES.map((mode) => [mode, []]),
      ) as Record<ProjectionRankMode, RankedCandidate[][]>;
      const candidateCache = new Map<string, OfflineCandidate>();
      const hasFullIndex = Boolean(manifest.indexFiles?.length || manifest.indexFile);
      let fullIndex: OfflineCandidate[] | null = null;
      let comparisons = 0;

      const chunkProgress = (
        chunkIndex: number,
        localDone: number,
        localTotal: number,
        stageStart: number,
        stageEnd: number,
        label: string,
      ) => {
        const localRatio = localTotal > 0 ? clamp(localDone / localTotal, 0, 1) : 0;
        setProgress({
          done: chunkIndex + stageStart + (stageEnd - stageStart) * localRatio,
          total: chunks.length,
          label: `区間 ${chunkIndex + 1}/${chunks.length} · ${label}`,
        });
      };

      for (const chunk of chunks) {
        if (cancelled()) throw new DOMException("Cancelled", "AbortError");
        const frames: SequenceFrame[] = [];
        setPhase("scanning");
        for (
          let sampleIndex = chunk.firstSampleIndex;
          sampleIndex < chunk.lastSampleIndexExclusive;
          sampleIndex += 1
        ) {
          if (cancelled()) throw new DOMException("Cancelled", "AbortError");
          const time = Math.min(analysisDuration - 0.001, sampleIndex / sampleRate);
          await seekVideo(video, time);
          const result = landmarker.detectForVideo(video, time * 1000);
          const landmarks = result.faceLandmarks[0] as NormalizedLandmark[] | undefined;
          const geometry = landmarks
            ? faceGeometryFromLandmarks(
              landmarks,
              video.videoWidth / Math.max(1, video.videoHeight),
            )
            : null;
          if (geometry && result.faceBlendshapes.length) {
            frames.push({ time, feature: featureFromResult(result), geometry });
          }
          chunkProgress(
            chunk.index,
            sampleIndex - chunk.firstSampleIndex + 1,
            chunk.sampleCount,
            0,
            0.35,
            `Face Meshを解析中（${formatTime(chunk.start)}–${formatTime(chunk.end)}）`,
          );
        }

        if (!frames.length) {
          chunkProgress(chunk.index, 1, 1, 0, 1, "顔なし・次の区間へ");
          continue;
        }

        setPhase("catalog");
        let indexed: OfflineCandidate[];
        if (hasFullIndex && fullIndex) {
          indexed = fullIndex;
        } else {
          const entries = await fetchCatalogEntries(
            manifest,
            frames,
            (next) => chunkProgress(
              chunk.index,
              next.done,
              next.total,
              0.35,
              0.47,
              next.label,
            ),
            cancelled,
          );
          if (!entries.length) {
            throw new Error("顔カタログに事前計測済み形状索引がありません");
          }
          indexed = entries.flatMap((entry) => {
            const cached = candidateCache.get(entry.id);
            if (cached) return [cached];
            const candidate = indexedCandidate(entry);
            if (!candidate) return [];
            candidateCache.set(candidate.id, candidate);
            return [candidate];
          });
          if (hasFullIndex) fullIndex = indexed;
        }
        if (indexed.length < 4) {
          throw new Error("骨格比較に使える索引済み顔素材が足りませんでした");
        }

        setPhase("geometry");
        const projectionSearch = await searchProjectionBeams(
          frames,
          indexed,
          (next) => chunkProgress(
            chunk.index,
            next.done,
            next.total,
            0.47,
            1,
            next.label,
          ),
          cancelled,
        );
        comparisons += projectionSearch.comparisons;
        allFrames.push(...frames);
        PROJECTION_RANK_MODES.forEach((mode) => {
          allRankedBeams[mode].push(...projectionSearch.beams[mode]);
        });
        allCandidateBeams.push(...projectionSearch.beams.balanced.map((beam) =>
          beam.map(({ candidate }) => candidate)
        ));

        rawFramesRef.current = allFrames;
        candidateBeamsRef.current = allCandidateBeams;
        rankedBeamsRef.current = allRankedBeams;
        setCatalogStats({
          indexed: manifest.totalFaces,
          searched: comparisons,
          beam: INDEX_BEAM_PER_FRAME,
          imageLoads: 0,
        });
      }

      if (allFrames.length < 2) throw new Error("動画から顔を十分に検出できませんでした");
      rankedBeamsRef.current = allRankedBeams;
      setRankedBeams(allRankedBeams);
      setRankingsReady(true);
      candidateBeamsRef.current = allCandidateBeams;
      rawFramesRef.current = allFrames;
      setProgress(null);
      recomputeSequence(searchMode, coherence, cooldown, qualityThreshold);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      console.error(caught);
      setProgress(null);
      setError(caught instanceof Error ? caught.message : "動画解析が途中で止まりました");
      setPhase("error");
    }
  }, [coherence, cooldown, manifest, qualityThreshold, recomputeSequence, sampleRate, searchMode]);

  const handleVideo = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void analyzeVideo({
      name: file.name,
      url: URL.createObjectURL(file),
      revokeOnReplace: true,
    });
  }, [analyzeVideo]);

  const handleTestVideo = useCallback(() => {
    void analyzeVideo({
      name: "FIXTURE / IMG_3665.mp4",
      url: TEST_VIDEO_URL,
      revokeOnReplace: false,
      analysisUrl: TEST_ANALYSIS_URL,
      rankingsUrl: TEST_RANKINGS_URL,
    });
  }, [analyzeVideo]);

  useEffect(() => {
    if (!isPlaying) return;
    let animation = 0;
    const update = () => {
      const video = videoRef.current;
      if (!video || video.paused || video.ended) {
        setIsPlaying(false);
        return;
      }
      setPlaybackTime(video.currentTime);
      animation = requestAnimationFrame(update);
    };
    animation = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animation);
  }, [isPlaying]);

  const currentChoice = useMemo(
    () => resultAtTime(sequence, playbackTime),
    [playbackTime, sequence],
  );
  const currentFrameIndex = useMemo(
    () => resultIndexAtTime(sequence, playbackTime),
    [playbackTime, sequence],
  );
  const diagnosticBeam = searchMode === "legacy" || currentFrameIndex < 0
    ? []
    : rankedBeams[searchMode]?.[currentFrameIndex] ?? [];
  const strictBeam = currentFrameIndex < 0
    ? []
    : rankedBeams.strict?.[currentFrameIndex] ?? [];
  const coverageAssessment = assessCoverage(strictBeam, currentChoice);
  const currentAlignment = currentChoice
    ? alignmentTransform(
      currentChoice.candidate.geometry,
      objectFitCoverLayout(currentChoice.frame.geometry.layout, sourceAspectRatio),
    )
    : null;
  const segments = useMemo(() => buildSegments(sequence, duration), [duration, sequence]);
  const uniqueFaces = useMemo(
    () => new Set(sequence.map((choice) => choice.candidate.id)).size,
    [sequence],
  );
  const meanMatchError = useMemo(() => sequence.length
    ? sequence.reduce((total, choice) => total + choice.emission, 0) / sequence.length
    : null, [sequence]);
  const projectionStats = useMemo(() => {
    const measured = sequence.filter((choice) => choice.error);
    if (!measured.length) return null;
    return {
      contour: measured.reduce((sum, choice) => sum + (choice.error?.contour ?? 0), 0) /
        measured.length,
      features: measured.reduce((sum, choice) => sum + (choice.error?.features ?? 0), 0) /
        measured.length,
      mouth: measured.reduce((sum, choice) => sum + (choice.error?.mouth ?? 0), 0) /
        measured.length,
      mouthShape: measured.reduce((sum, choice) => sum + (choice.error?.mouthShape ?? 0), 0) /
        measured.length,
      eyes: measured.reduce((sum, choice) => sum + (choice.error?.eyes ?? 0), 0) /
        measured.length,
      wink: measured.reduce((sum, choice) => sum + (choice.error?.wink ?? 0), 0) /
        measured.length,
      brows: measured.reduce((sum, choice) => sum + (choice.error?.brows ?? 0), 0) /
        measured.length,
      pitch: measured.reduce((sum, choice) => sum + Math.abs(choice.error?.pitchDegrees ?? 0), 0) /
        measured.length,
      blendshape: measured.reduce((sum, choice) => sum + (choice.error?.blendshape ?? 0), 0) /
        measured.length,
      worstLocal: measured.reduce((sum, choice) => sum + (choice.error?.worstLocal ?? 0), 0) /
        measured.length,
      motion: measured.reduce((sum, choice) => sum + (choice.expressionMotion ?? 0), 0) /
        measured.length,
      passRate: measured.filter((choice) => choice.accepted).length / measured.length,
    };
  }, [sequence]);
  const selectedCredits = useMemo(() => {
    const selected = new Map<string, OfflineCandidate>();
    sequence.forEach(({ candidate }) => selected.set(candidate.id, candidate));
    return [...selected.values()].filter((candidate) => candidate.sourceUrl);
  }, [sequence]);
  const analyzedDuration = duration;
  const progressPercent = progress?.total
    ? Math.round(progress.done / progress.total * 100)
    : 0;

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !sequence.length) return;
    if (video.paused) {
      if (video.currentTime >= analyzedDuration - 0.05) video.currentTime = 0;
      await video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [analyzedDuration, sequence.length]);

  const stepDiagnosticFrame = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video || !sequence.length) return;
    video.pause();
    setIsPlaying(false);
    const nextIndex = clamp(currentFrameIndex + delta, 0, sequence.length - 1);
    const nextTime = sequence[nextIndex].frame.time;
    video.currentTime = nextTime;
    setPlaybackTime(nextTime);
  }, [currentFrameIndex, sequence]);

  const cancelAnalysis = useCallback(() => {
    analysisTokenRef.current += 1;
    sequenceTokenRef.current += 1;
    const video = videoRef.current;
    video?.pause();
    if (video) {
      video.removeAttribute("src");
      video.load();
    }
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    rawFramesRef.current = [];
    candidateBeamsRef.current = [];
    rankedBeamsRef.current = {};
    setRankedBeams({});
    setRankingsReady(false);
    setProgress(null);
    setCatalogStats(null);
    setSequence([]);
    setFileName(null);
    setDuration(0);
    setSourceAspectRatio(1);
    setPlaybackTime(0);
    setIsPlaying(false);
    setError(null);
    setPhase("ready");
  }, []);

  const isAnalyzing = phase === "scanning" || phase === "catalog" ||
    phase === "geometry" || phase === "optimizing";
  const canStartAnalysis = Boolean(engineReady && manifest) &&
    (phase === "ready" || phase === "done" || phase === "error");
  const canStartTestAnalysis = Boolean(manifest) &&
    (phase === "ready" || phase === "done" || phase === "error");

  const phaseLabel = phase === "preparing"
    ? "ENGINE LOADING"
    : phase === "ready"
      ? "VIDEO READY"
      : phase === "done"
        ? "SEQUENCE READY"
        : phase === "error"
          ? "CHECK INPUT"
          : "ANALYZING";

  return (
    <main className="offline-shell">
      <header className="offline-header">
        <div>
          <p className="offline-kicker">MANY FACES / EXPRESSION LAB V4</p>
          <h1>正解がないのか、<br />選べていないのか。</h1>
        </div>
        <div className={`offline-status offline-status-${phase}`}>
          <i />
          <span>{phaseLabel}</span>
        </div>
      </header>

      <section className="offline-workspace">
        <div className="offline-output-column">
          <div className="offline-compare-grid" aria-label="元動画と変換結果の同期比較">
            <div className={`offline-compare-pane offline-compare-source ${fileName ? "active" : ""}`}>
              <div className="offline-compare-label"><span>01 / ORIGINAL</span><b>元動画</b></div>
              <div className="offline-source-stage">
                <video
                  ref={videoRef}
                  aria-label="元動画"
                  muted
                  playsInline
                  controls={Boolean(fileName) && (phase === "done" || phase === "error")}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onTimeUpdate={(event) => {
                    const video = event.currentTarget;
                    if (sequence.length && video.currentTime >= analyzedDuration) {
                      video.pause();
                      setIsPlaying(false);
                      setPlaybackTime(analyzedDuration);
                      return;
                    }
                    setPlaybackTime(video.currentTime);
                  }}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.playbackRate = 1;
                  }}
                  onSeeking={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                />
                {!fileName && (
                  <div className="offline-source-empty">
                    <span>SOURCE VIDEO</span>
                    <small>NO INPUT</small>
                  </div>
                )}
                <div className="offline-readout">
                  <span>{fileName ?? "NO VIDEO"}</span>
                  <span>{formatTime(playbackTime)} / {formatTime(analyzedDuration)}</span>
                </div>
              </div>
            </div>

            <div className={`offline-compare-pane offline-compare-result ${phase === "done" ? "active" : ""}`}>
              <div className="offline-compare-label"><span>02 / MATCHED</span><b>変換結果</b></div>
              <div className={`offline-stage offline-stage-display-${displayMode} ${phase === "done" ? "offline-stage-ready" : ""}`}>
                {currentChoice ? (
                  <MatchedFace
                    choice={currentChoice}
                    alignment={currentAlignment ?? { xPercent: 0, yPercent: 0, scale: 1 }}
                    displayMode={displayMode}
                  />
                ) : (
                  <div className="offline-empty">
                    <div className="offline-mesh-mark" aria-hidden="true"><i /><i /><i /><i /></div>
                    <strong>{progress ? progress.label : "顔動画を選ぶ"}</strong>
                    <span>{progress ? `${progressPercent}%` : "468-POINT PROJECTION SEARCH"}</span>
                  </div>
                )}
                {currentChoice?.error && <ProjectionOverlay choice={currentChoice} />}
                {progress && (
                  <div className="offline-stage-progress" role="status">
                    <i style={{ width: `${progressPercent}%` }} />
                  </div>
                )}
                <div className="offline-readout">
                  <span>{currentChoice?.candidate.name ?? fileName ?? "NO VIDEO"}</span>
                  <span>{formatTime(playbackTime)} / {formatTime(analyzedDuration)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="offline-view-switch" role="group" aria-label="背景ノイズの比較表示">
            {([
              ["raw", "RAW"],
              ["face", "顔だけ"],
              ["split", "左右比較"],
            ] as Array<[DisplayMode, string]>).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                className={displayMode === mode ? "active" : ""}
                onClick={() => setDisplayMode(mode)}
              >
                {label}
              </button>
            ))}
            <span>同じ選択結果・部位合成なし</span>
          </div>

          <div className="offline-telemetry" aria-label="解析結果">
            <div><span>CONTOUR RMS ↓</span><strong>{projectionStats ? `${(projectionStats.contour * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>MOUTH RMS ↓</span><strong>{projectionStats ? `${(projectionStats.mouth * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>VOWEL SHAPE ↓</span><strong>{projectionStats ? `${(projectionStats.mouthShape * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>EYE RMS ↓</span><strong>{projectionStats ? `${(projectionStats.eyes * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>WINK ERROR ↓</span><strong>{projectionStats ? `${(projectionStats.wink * 100).toFixed(1)}%` : "—"}</strong></div>
            <div><span>BROW RMS ↓</span><strong>{projectionStats ? `${(projectionStats.brows * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>PITCH ERROR ↓</span><strong>{projectionStats ? `${projectionStats.pitch.toFixed(1)}°` : "—"}</strong></div>
            <div><span>ACTION RMS ↓</span><strong>{projectionStats ? `${(projectionStats.blendshape * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>WORST LOCAL ↓</span><strong>{projectionStats ? `${(projectionStats.worstLocal * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>EXPR MOTION ↓</span><strong>{projectionStats ? `${(projectionStats.motion * 100).toFixed(2)}%` : "—"}</strong></div>
            <div><span>PASS RATE</span><strong>{projectionStats ? `${Math.round(projectionStats.passRate * 100)}%` : "—"}</strong></div>
            <div><span>DISTINCT IDS</span><strong>{sequence.length ? `${uniqueFaces} / ${sequence.length}` : "—"}</strong></div>
            <div><span>INDEX / SEARCH</span><strong>{catalogStats ? `${catalogStats.indexed.toLocaleString()} / ${catalogStats.searched.toLocaleString()}` : "—"}</strong></div>
            {searchMode === "legacy" && (
              <>
                <div><span>POSE Y / P / R</span><strong>{formatPose(currentChoice?.frame.feature)}</strong></div>
                <div><span>EXPRESSION</span><strong>{expressionLabel(currentChoice?.frame.feature ?? null)}</strong></div>
                <div><span>LEGACY ERROR ↓</span><strong>{meanMatchError === null ? "—" : meanMatchError.toFixed(4)}</strong></div>
              </>
            )}
          </div>

          {sequence.length > 0 && (
            <button type="button" className="offline-play" onClick={togglePlayback}>
              <span>{isPlaying ? "PAUSE" : "PLAY RESULT"}</span>
              <strong>{isPlaying ? "一時停止" : "解析結果を再生"}</strong>
            </button>
          )}
        </div>

        <aside className="offline-controls">
          <div className="offline-section-label">
            <span>OFFLINE INPUT</span>
            <span>NON-COMMERCIAL</span>
          </div>

          <label className={`offline-upload ${!canStartAnalysis ? "disabled" : ""}`}>
            <input
              type="file"
              accept="video/*,.mp4,.mov,.m4v,.webm"
              onChange={handleVideo}
              disabled={!canStartAnalysis}
            />
            <span>{fileName ? "別の動画を選ぶ" : "動画を選んで解析"}</span>
            <small>端末内で{ANALYSIS_CHUNK_SECONDS}秒ずつ動画全体を解析・アップロードなし</small>
          </label>

          <button
            type="button"
            className="offline-test-video"
            onClick={handleTestVideo}
            disabled={!canStartTestAnalysis}
          >
            <span>{fileName === "FIXTURE / IMG_3665.mp4" ? "解析済み結果を再読込" : "固定検証動画を開く（解析済み）"}</span>
            <small>IMG_3665 · 23.3秒 · 613 Face Mesh frames · 全件探索済み</small>
          </button>

          {isAnalyzing && (
            <button type="button" className="offline-cancel-analysis" onClick={cancelAnalysis}>
              解析を中止
            </button>
          )}

          {error && <p className="offline-error">{error}</p>}

          <div className="offline-method">
            <div><b>01</b><span><strong>Two Stage</strong>角度と軽量形状で絞りつつ、母音に合う口の候補を別枠で残して詳細照合</span></div>
            <div><b>02</b><span><strong>Minimax</strong>輪郭の良さで左右別の目・眉・口の大きなズレを相殺させない</span></div>
            <div><b>03</b><span><strong>Action Units</strong>片目の瞬き、上下姿勢、唇の横幅・開き・すぼまりを独立評価</span></div>
            <div><b>04</b><span><strong>Coverage Lab</strong>上位8候補と局所誤差を止めたフレームごとに確認</span></div>
          </div>

          <div className="offline-settings">
            <label>
              <span>照合方式</span>
              <select
                value={searchMode}
                onChange={(event) => {
                  const nextMode = event.target.value as SearchMode;
                  setSearchMode(nextMode);
                  if (sequence.length) recomputeSequence(nextMode, coherence, cooldown, qualityThreshold);
                }}
                disabled={isAnalyzing || (sequence.length > 0 && !rankingsReady)}
              >
                <option value="strict">V5：母音と局所の最悪値を潰す</option>
                <option value="semantic">V4：表情動作を優先</option>
                <option value="eyes">実験：目・眉を優先</option>
                <option value="mouth">実験：口を優先</option>
                <option value="expression">V3：表情と動きを優先</option>
                <option value="balanced">V2：輪郭中心（比較用）</option>
                <option value="legacy">比較用：旧方式</option>
              </select>
              <small>同じ動画の解析結果から検索経路だけを切り替えて比較</small>
            </label>
            <label>
              <span>解析密度</span>
              <select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))} disabled={phase !== "ready" && phase !== "done" && phase !== "error"}>
                <option value="24">24 frames / sec</option>
                <option value="30">30 frames / sec</option>
                <option value="60">60 frames / sec</option>
              </select>
              <small>既定30fps・60fpsは時間をかけて全フレームを追う</small>
            </label>
            {searchMode !== "legacy" ? (
              <>
                <label>
                  <span>人物の再登場禁止</span>
                  <input type="range" min="2" max="24" step="1" value={cooldown} onChange={(event) => setCooldown(Number(event.target.value))} />
                  <small>{cooldown}フレーム・隣り合うフレームは必ず別人</small>
                </label>
                <label>
                  <span>一致品質ゲート</span>
                  <input type="range" min="25" max="100" step="1" value={Math.round(qualityThreshold * 1000)} onChange={(event) => setQualityThreshold(Number(event.target.value) / 1000)} />
                  <small>{(qualityThreshold * 100).toFixed(1)}%以下をMATCHと判定・悪い候補を隠さない</small>
                </label>
              </>
            ) : (
              <label>
                <span>旧方式の連続性</span>
                <input type="range" min="35" max="100" step="1" value={coherence} onChange={(event) => setCoherence(Number(event.target.value))} />
                <small>{coherence}%・高いほど同じ顔を保持（比較専用）</small>
              </label>
            )}
            <div className="offline-index-setting">
              <span>現在の探索母集団</span>
              <strong>{manifest?.totalFaces.toLocaleString() ?? "—"} PILOT FACES</strong>
              <small>全件を毎フレーム照合。本番は同じ索引を百万枚級へ載せ替える</small>
            </div>
          </div>

          {sequence.length > 0 && rankingsReady && (
            <button type="button" className="offline-recalculate" onClick={() => recomputeSequence(searchMode, coherence, cooldown, qualityThreshold)}>
              現在の条件で経路を再計算
            </button>
          )}

          <p className="offline-caveat">
            V4は同じ全件計測から複数方式を切り替えます。候補ラボでどの方式にも近い顔がなければ素材不足、近い顔があるのに本編で選ばれなければ評価式か時間経路の問題です。部位合成はしていません。
          </p>
        </aside>
      </section>

      {sequence.length > 0 && searchMode !== "legacy" && (
        <section className="offline-candidate-lab" aria-label="現在フレームの候補診断">
          <div className="offline-candidate-lab-head">
            <div>
              <p>COVERAGE LAB / FRAME {String(currentFrameIndex + 1).padStart(3, "0")}</p>
              <h2>{MODE_LABELS[searchMode]}の上位候補</h2>
            </div>
            <div className="offline-frame-step" role="group" aria-label="診断フレーム移動">
              <button type="button" onClick={() => stepDiagnosticFrame(-1)} aria-label="前のフレーム">←</button>
              <span>{formatTime(currentChoice?.frame.time ?? 0)}</span>
              <button type="button" onClick={() => stepDiagnosticFrame(1)} aria-label="次のフレーム">→</button>
            </div>
          </div>
          {coverageAssessment && (
            <div className={`offline-coverage-verdict offline-coverage-${coverageAssessment.tone}`}>
              <strong>{coverageAssessment.label}</strong>
              <span>{coverageAssessment.text}</span>
            </div>
          )}
          {isPlaying ? (
            <p className="offline-candidate-paused">再生を止めると、そのフレームの上位8件と誤差内訳を表示します。</p>
          ) : (
            <div className="offline-candidate-grid">
              {diagnosticBeam.slice(0, 8).map(({ candidate, error }, index) => (
                <article
                  key={candidate.id}
                  className={currentChoice?.candidate.id === candidate.id ? "selected" : ""}
                >
                  <div>
                    <img src={candidate.url} alt={`${index + 1}位の候補顔`} loading="lazy" />
                    <b>#{String(index + 1).padStart(2, "0")}</b>
                    {currentChoice?.candidate.id === candidate.id && <em>SELECTED</em>}
                  </div>
                  <p>{candidate.name}</p>
                  <dl>
                    <div><dt>口</dt><dd>{(error.mouth * 100).toFixed(1)}%</dd></div>
                    <div><dt>目</dt><dd>{(error.eyes * 100).toFixed(1)}%</dd></div>
                    <div><dt>片目</dt><dd>{(error.wink * 100).toFixed(1)}%</dd></div>
                    <div><dt>眉</dt><dd>{(error.brows * 100).toFixed(1)}%</dd></div>
                    <div><dt>上下</dt><dd>{Math.abs(error.pitchDegrees).toFixed(1)}°</dd></div>
                    <div><dt>動作</dt><dd>{(error.blendshape * 100).toFixed(1)}%</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {segments.length > 0 && (
        <section className="offline-timeline" aria-label="選ばれた顔の区間">
          <div className="offline-section-label">
            <span>SELECTED PATH / {segments.length} CUTS</span>
            <span>{uniqueFaces} FACES</span>
          </div>
          <div className="offline-segments">
            {segments.slice(0, 90).map((segment, index) => (
              <button
                type="button"
                key={`${segment.start}-${segment.candidate.id}`}
                className={currentChoice?.candidate.id === segment.candidate.id && playbackTime >= segment.start && playbackTime < segment.end ? "active" : ""}
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  video.currentTime = segment.start;
                  setPlaybackTime(segment.start);
                }}
              >
                <img src={segment.candidate.url} alt="" />
                <span>{String(index + 1).padStart(2, "0")}</span>
                <small>{formatTime(segment.start)}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedCredits.length > 0 && (
        <details className="offline-web-credits">
          <summary>選ばれた顔素材の出典・ライセンス（{selectedCredits.length}件）</summary>
          <ul>
            {selectedCredits.map((candidate) => (
              <li key={candidate.id}>
                <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">{candidate.name}</a>
                <span>{candidate.creator || candidate.sourceName || "Unknown creator"} / </span>
                <a href={candidate.licenseUrl || candidate.sourceUrl} target="_blank" rel="noreferrer">
                  {candidate.license || "License details"}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      <footer className="offline-footer">
        <p>FFHQ {manifest?.totalFaces.toLocaleString() ?? "—"} PILOT / 6 RANKERS + COVERAGE DIAGNOSIS / DISTINCT-ID PATH</p>
        <p>MINIMAX・ACTION・目眉・口 / 動画とFace Meshは端末内処理</p>
      </footer>
    </main>
  );
}
