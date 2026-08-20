import type {
  FaceLandmarker,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  faceGeometryFromLandmarks,
} from "./offline-matching";
import { FACE_FEATURE_LENGTH, faceFeatureFromScores } from "./face-actions";

const DATASET_PAGE = "https://huggingface.co/datasets/nuwandaa/ffhq128";
const LICENSE_URL =
  "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt";
const DATASET_HOST = "datasets-server.huggingface.co";
const POSE_STEP = 3;
const YAW_MIN = -45;
const YAW_MAX = 45;
const PITCH_MIN = -36;
const PITCH_MAX = 36;
const OUTPUT_SIZE = 256;
const PACK_TARGET_BYTES = 6 * 1024 * 1024;
const SHARD_ENTRY_LIMIT = 512;
const INDEX_ENTRY_LIMIT = 1_000;
const FETCH_BATCH_SIZE = 60;
const IMAGE_LOAD_CONCURRENCY = 6;

type Candidate = {
  id: string;
  title: string;
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
};

type CatalogEntry = {
  id: string;
  name: string;
  pack: string;
  offset: number;
  length: number;
  feature: number[];
  shape: string;
  mesh: string;
  projection: string;
  layout: [number, number, number, number];
  sourceName: string;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
};

export type BulkCatalogProgress = {
  phase: "fetching" | "detecting" | "uploading" | "finalizing";
  checked: number;
  accepted: number;
  target: number;
  rejected: number;
  duplicates: number;
  outsideBounds: number;
  uploadedObjects: number;
};

export type BuildFfhqCatalogOptions = {
  landmarker: FaceLandmarker;
  targetFaces: number;
  startOffset?: number;
  onProgress(progress: BulkCatalogProgress): void;
  isCancelled(): boolean;
};

type DatasetPayload = {
  rows?: Array<{
    row_idx?: number;
    row?: { image?: string | { src?: string } };
  }>;
  num_rows_total?: number;
};

function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function retry<T>(operation: () => Promise<T>, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await wait(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function rowsToCandidates(payload: DatasetPayload) {
  return (payload.rows ?? []).flatMap<Candidate>((entry) => {
    const image = entry.row?.image;
    const imageUrl = typeof image === "string" ? image : image?.src;
    if (entry.row_idx === undefined || !imageUrl) return [];
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== DATASET_HOST) return [];
    } catch {
      return [];
    }
    return [
      {
        id: `ffhq-${entry.row_idx}`,
        title: `FFHQ ${String(entry.row_idx).padStart(5, "0")}`,
        imageUrl,
        sourceName: "FFHQ",
        sourceUrl: DATASET_PAGE,
        creator: "NVIDIA FFHQ / Flickr photographers",
        license: "CC BY-NC-SA 4.0; per-image licenses vary",
        licenseUrl: LICENSE_URL,
      },
    ];
  });
}

async function fetchBatch(offset: number) {
  const localQuery = new URLSearchParams({
    limit: String(FETCH_BATCH_SIZE),
    offset: String(offset),
  });
  try {
    const response = await retry(() =>
      fetch(`/api/ffhq?${localQuery.toString()}`, { cache: "no-store" }),
    );
    if (response.ok) {
      const payload = (await response.json()) as {
        items?: Candidate[];
        nextOffset?: number;
        total?: number;
      };
      if (payload.items?.length) {
        return {
          items: payload.items,
          nextOffset: payload.nextOffset ?? offset + payload.items.length,
          total: payload.total ?? 70_000,
        };
      }
    }
  } catch {
    // The Dataset Viewer has CORS enabled, so the browser can bypass a busy Worker.
  }

  const directQuery = new URLSearchParams({
    dataset: "nuwandaa/ffhq128",
    config: "default",
    split: "train",
    offset: String(offset),
    length: String(FETCH_BATCH_SIZE),
  });
  const response = await retry(() =>
    fetch(`https://${DATASET_HOST}/rows?${directQuery.toString()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
  );
  if (!response.ok) throw new Error(`FFHQ ${response.status}`);
  const payload = (await response.json()) as DatasetPayload;
  const items = rowsToCandidates(payload);
  if (!items.length) throw new Error("FFHQ images unavailable");
  const total = payload.num_rows_total ?? 70_000;
  return {
    items,
    nextOffset: (offset + (payload.rows?.length ?? items.length)) % total,
    total,
  };
}

function loadImageUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.src = "";
      reject(new Error("image timeout"));
    }, 12_000);
    if (/^https:\/\//i.test(url)) {
      image.crossOrigin = "anonymous";
      image.referrerPolicy = "no-referrer";
    }
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("image unavailable"));
    };
    image.src = url;
  });
}

async function loadCandidate(candidate: Candidate) {
  try {
    return await retry(() => loadImageUrl(candidate.imageUrl), 2);
  } catch {
    return retry(
      () =>
        loadImageUrl(`/api/ffhq?image=${encodeURIComponent(candidate.imageUrl)}`),
      2,
    );
  }
}

function averagePoint(landmarks: NormalizedLandmark[], indexes: number[]) {
  const sum = indexes.reduce(
    (result, index) => ({
      x: result.x + landmarks[index].x,
      y: result.y + landmarks[index].y,
    }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / indexes.length, y: sum.y / indexes.length };
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("WebP encoding failed"))),
      "image/webp",
      0.78,
    );
  });
}

async function alignedCrop(image: HTMLImageElement, landmarks: NormalizedLandmark[]) {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas unavailable");

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
  const ys = landmarks.map((point) => point.y * image.naturalHeight);
  const faceHeight = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const sourceX = eyeCenter.x * image.naturalWidth;
  const sourceY = eyeCenter.y * image.naturalHeight + faceHeight * 0.16;
  const targetFaceHeight = OUTPUT_SIZE * (274 / 384);
  const scale = Math.min(3.2, Math.max(0.18, targetFaceHeight / faceHeight));

  context.fillStyle = "#d8d4cc";
  context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  context.save();
  context.translate(OUTPUT_SIZE / 2, OUTPUT_SIZE * 0.49);
  context.rotate(-angle);
  context.scale(scale, scale);
  context.translate(-sourceX, -sourceY);
  context.drawImage(image, 0, 0);
  context.restore();

  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hashContext = hashCanvas.getContext("2d", { willReadFrequently: true });
  if (!hashContext) throw new Error("Hash canvas unavailable");
  hashContext.drawImage(canvas, 0, 0, 9, 8);
  const pixels = hashContext.getImageData(0, 0, 9, 8).data;
  let visualHash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4;
      const right = left + 4;
      const leftLuma = pixels[left] * 3 + pixels[left + 1] * 6 + pixels[left + 2];
      const rightLuma = pixels[right] * 3 + pixels[right + 1] * 6 + pixels[right + 2];
      if (rightLuma > leftLuma) visualHash |= 1n << BigInt(y * 8 + x);
    }
  }
  return {
    canvas,
    blob: await canvasToBlob(canvas),
    visualHash: visualHash.toString(16).padStart(16, "0"),
  };
}

function poseFromResult(result: FaceLandmarkerResult) {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  if (!matrix || matrix.length < 11) return null;
  return [
    clamp(Math.atan2(-matrix[8], Math.hypot(matrix[9], matrix[10])) / (Math.PI / 2)),
    clamp(Math.atan2(matrix[9], matrix[10]) / (Math.PI / 2)),
    clamp(Math.atan2(matrix[4], matrix[0]) / (Math.PI / 2)),
  ];
}

function featureFromResult(result: FaceLandmarkerResult) {
  const pose = poseFromResult(result);
  if (!pose) return null;
  const scores = new Map(
    (result.faceBlendshapes[0]?.categories ?? []).map((category) => [
      category.categoryName,
      category.score,
    ]),
  );
  const quantizedPose = pose.map((value, index) =>
      index === 1
        ? (Math.round((clamp(value * 1.4) * 90) / POSE_STEP) * POSE_STEP) / 90
        :
      (Math.round((value * 90) / POSE_STEP) * POSE_STEP) / 90,
    );
  return faceFeatureFromScores(quantizedPose, scores, 5);
}

function cellFilename(yaw: number, pitch: number) {
  const token = (value: number) =>
    value >= 0 ? `p${String(value).padStart(3, "0")}` : `n${String(Math.abs(value)).padStart(3, "0")}`;
  return `yaw_${token(yaw)}_pitch_${token(pitch)}`;
}

function encodeShape(values: number[]) {
  const quantized = new Int16Array(values.length);
  values.forEach((value, index) => {
    quantized[index] = Math.max(-32768, Math.min(32767, Math.round(value * 4096)));
  });
  const bytes = new Uint8Array(quantized.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function uploadObject(path: string, body: Blob | string) {
  const payload = typeof body === "string" ? new Blob([body], { type: "application/json" }) : body;
  await retry(async () => {
    const response = await fetch(`/api/catalog/upload?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": payload.type || "application/octet-stream" },
      body: payload,
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
  });
}

export async function buildFfhqCatalog({
  landmarker,
  targetFaces,
  startOffset = 0,
  onProgress,
  isCancelled,
}: BuildFfhqCatalogOptions) {
  const target = Math.max(100, Math.min(15_000, Math.round(targetFaces)));
  const generation = Date.now().toString(36);
  const cells = new Map<string, CatalogEntry[]>();
  const seenHashes = new Set<string>();
  const seenIds = new Set<string>();
  let offset = startOffset;
  let checked = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let outsideBounds = 0;
  let uploadedObjects = 0;
  let packIndex = 0;
  let packName = `${generation}_faces_${String(packIndex).padStart(5, "0")}.bin`;
  let packSize = 0;
  let packParts: Blob[] = [];

  const report = (phase: BulkCatalogProgress["phase"]) =>
    onProgress({
      phase,
      checked,
      accepted,
      target,
      rejected,
      duplicates,
      outsideBounds,
      uploadedObjects,
    });
  const assertActive = () => {
    if (isCancelled()) throw new DOMException("Catalog build cancelled", "AbortError");
  };
  const flushPack = async () => {
    if (!packParts.length) return;
    report("uploading");
    await uploadObject(`packs/${packName}`, new Blob(packParts, { type: "application/octet-stream" }));
    uploadedObjects += 1;
    packIndex += 1;
    packName = `${generation}_faces_${String(packIndex).padStart(5, "0")}.bin`;
    packSize = 0;
    packParts = [];
  };

  report("fetching");
  const maxChecked = Math.min(70_000, Math.max(target * 4, target + 500));
  while (accepted < target && checked < maxChecked) {
    assertActive();
    report("fetching");
    const batch = await fetchBatch(offset);
    offset = batch.nextOffset;

    for (let chunkStart = 0; chunkStart < batch.items.length; chunkStart += IMAGE_LOAD_CONCURRENCY) {
      assertActive();
      const candidates = batch.items
        .slice(chunkStart, chunkStart + IMAGE_LOAD_CONCURRENCY)
        .filter((candidate) => !seenIds.has(candidate.id));
      candidates.forEach((candidate) => seenIds.add(candidate.id));
      const loaded = await Promise.allSettled(candidates.map(loadCandidate));

      for (let index = 0; index < loaded.length; index += 1) {
        assertActive();
        if (accepted >= target || checked >= maxChecked) break;
        checked += 1;
        const imageResult = loaded[index];
        const candidate = candidates[index];
        if (imageResult.status === "rejected") {
          rejected += 1;
          report("detecting");
          continue;
        }

        try {
          const result = landmarker.detect(imageResult.value);
          if (
            !result.faceLandmarks.length ||
            !result.faceBlendshapes.length ||
            !result.facialTransformationMatrixes.length
          ) {
            rejected += 1;
            report("detecting");
            continue;
          }
          const feature = featureFromResult(result);
          if (!feature) {
            rejected += 1;
            report("detecting");
            continue;
          }
          const yaw = Math.round(feature[0] * 90);
          const pitch = Math.round(feature[1] * 90);
          if (yaw < YAW_MIN || yaw > YAW_MAX || pitch < PITCH_MIN || pitch > PITCH_MAX) {
            outsideBounds += 1;
            report("detecting");
            continue;
          }

          const crop = await alignedCrop(imageResult.value, result.faceLandmarks[0]);
          const cropResult = landmarker.detect(crop.canvas);
          const geometry = cropResult.faceLandmarks[0]
            ? faceGeometryFromLandmarks(cropResult.faceLandmarks[0])
            : null;
          if (!geometry) {
            rejected += 1;
            report("detecting");
            continue;
          }
          if (seenHashes.has(crop.visualHash)) {
            duplicates += 1;
            report("detecting");
            continue;
          }
          seenHashes.add(crop.visualHash);
          if (packSize > 0 && packSize + crop.blob.size > PACK_TARGET_BYTES) {
            await flushPack();
          }
          const entry: CatalogEntry = {
            id: candidate.id,
            name: candidate.title,
            pack: packName,
            offset: packSize,
            length: crop.blob.size,
            feature,
            shape: encodeShape(geometry.structure),
            mesh: encodeShape(geometry.surface),
            projection: encodeShape(geometry.projection),
            layout: geometry.layout,
            sourceName: candidate.sourceName,
            sourceUrl: candidate.sourceUrl,
            creator: candidate.creator,
            license: candidate.license,
            licenseUrl: candidate.licenseUrl,
          };
          packParts.push(crop.blob);
          packSize += crop.blob.size;
          const key = `${yaw}:${pitch}`;
          const cell = cells.get(key);
          if (cell) cell.push(entry);
          else cells.set(key, [entry]);
          accepted += 1;
        } catch (error) {
          console.warn("FFHQ catalog candidate rejected.", candidate.id, error);
          rejected += 1;
        }
        report("detecting");
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  assertActive();
  await flushPack();
  if (!accepted) throw new Error("顔を検出できるFFHQ素材がありませんでした");

  report("finalizing");
  const manifestCells: Record<string, { count: number; shards: string[] }> = {};
  const shardObjects: Array<{ path: string; body: string }> = [];
  for (const [key, entries] of [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [yaw, pitch] = key.split(":").map(Number);
    const filenames: string[] = [];
    for (let start = 0; start < entries.length; start += SHARD_ENTRY_LIMIT) {
      const filename = `${generation}_${cellFilename(yaw, pitch)}_${String(start / SHARD_ENTRY_LIMIT).padStart(3, "0")}.json`;
      filenames.push(filename);
      shardObjects.push({
        path: `shards/${filename}`,
        body: JSON.stringify({ cell: key, items: entries.slice(start, start + SHARD_ENTRY_LIMIT) }),
      });
    }
    manifestCells[key] = { count: entries.length, shards: filenames };
  }

  let nextShard = 0;
  const shardWorkers = Array.from({ length: Math.min(4, shardObjects.length) }, async () => {
    while (nextShard < shardObjects.length) {
      assertActive();
      const shard = shardObjects[nextShard];
      nextShard += 1;
      await uploadObject(shard.path, shard.body);
      uploadedObjects += 1;
      report("uploading");
    }
  });
  await Promise.all(shardWorkers);

  const allEntries = [...cells.values()].flat();
  const indexFiles: string[] = [];
  for (let start = 0; start < allEntries.length; start += INDEX_ENTRY_LIMIT) {
    assertActive();
    const filename = `index_${String(start / INDEX_ENTRY_LIMIT).padStart(3, "0")}.json`;
    indexFiles.push(filename);
    await uploadObject(
      filename,
      JSON.stringify({
        shapeVersion: "mediapipe-projection-468-v4",
        items: allEntries.slice(start, start + INDEX_ENTRY_LIMIT),
      }),
    );
    uploadedObjects += 1;
    report("uploading");
  }

  assertActive();
  const manifest = {
    schemaVersion: 3,
    catalogId: generation,
    generatedAt: new Date().toISOString(),
    totalFaces: accepted,
    poseStep: POSE_STEP,
    bounds: {
      yawMin: YAW_MIN,
      yawMax: YAW_MAX,
      pitchMin: PITCH_MIN,
      pitchMax: PITCH_MAX,
    },
    outputSize: OUTPUT_SIZE,
    shapeVersion: "mediapipe-projection-468-v4",
    projectionPoints: 468,
    featureSchema: "mediapipe-face-actions-v2",
    featureLength: FACE_FEATURE_LENGTH,
    shardsContainGeometry: true,
    indexFiles,
    cells: manifestCells,
    stats: { checked, accepted, rejected, duplicates, outsideBounds },
    source: {
      name: "FFHQ",
      url: DATASET_PAGE,
      license: "CC BY-NC-SA 4.0; per-image licenses vary",
      licenseUrl: LICENSE_URL,
    },
  };
  await uploadObject("manifest.json", JSON.stringify(manifest));
  uploadedObjects += 1;
  report("finalizing");
  return { manifest, nextOffset: offset };
}
