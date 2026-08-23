import {
  FixedCandidateSearchIndex,
  type FixedSearchFrame,
} from "./fixed-candidate-search";
import type { FaceGeometry } from "./offline-matching";
import {
  projectionError,
  type ProjectionError,
  type ProjectionRankMode,
} from "./projection-matching";

export type LiveCatalogEntry = {
  id: string;
  name?: string;
  image?: string;
  pack?: string;
  offset?: number;
  length?: number;
  feature?: number[];
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

export type LiveCandidate = {
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
  shard?: string;
};

export type LiveRankedCandidate = {
  candidate: LiveCandidate;
  error: ProjectionError;
  score: number;
};

export type LiveRankResult = {
  winner: LiveRankedCandidate | null;
  ranked: LiveRankedCandidate[];
  inspected: number;
  bucketHits: number;
  fallbackCandidates: number;
};

export type LiveRankOptions = {
  mode?: ProjectionRankMode;
  budget?: number;
  detailedLimit?: number;
  currentId?: string | null;
  recentIds?: readonly string[];
  holdBias?: number;
  diversityPenalty?: number;
  hysteresis?: number;
};

function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function decodeCatalogVector(encoded: string | undefined) {
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

function validLayout(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}

function entryImageUrl(entry: LiveCatalogEntry) {
  if (entry.image) {
    return `/api/catalog/image?id=${encodeURIComponent(entry.image)}`;
  }
  if (
    !entry.pack ||
    !Number.isSafeInteger(entry.offset) ||
    !Number.isSafeInteger(entry.length) ||
    Number(entry.offset) < 0 ||
    Number(entry.length) < 1
  ) {
    return null;
  }
  return `/api/catalog/image?pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}`;
}

export function liveCandidateFromEntry(
  entry: LiveCatalogEntry,
  shard?: string,
): LiveCandidate | null {
  if (!entry.id || !Array.isArray(entry.feature) || entry.feature.length < 22) {
    return null;
  }
  const structure = decodeCatalogVector(entry.shape);
  const projection = decodeCatalogVector(entry.projection);
  const surface = decodeCatalogVector(entry.mesh) ?? projection;
  const url = entryImageUrl(entry);
  if (
    !structure || structure.length < 13 ||
    !projection || projection.length < 936 ||
    !surface ||
    !url
  ) {
    return null;
  }
  const layout = validLayout(entry.layout)
    ? entry.layout
    : [0.5, 0.5, 1, 1] as [number, number, number, number];
  return {
    id: entry.id,
    name: entry.name || entry.id,
    url,
    feature: entry.feature.map(finite),
    geometry: { structure, surface, projection, layout },
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
    creator: entry.creator,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
    shard,
  };
}

export function buildLiveCandidateIndex(candidates: readonly LiveCandidate[]) {
  return new FixedCandidateSearchIndex(candidates, {
    poseStepDegrees: 6,
    maxBucketEntries: 64,
  });
}

function scoreForMode(error: ProjectionError, mode: ProjectionRankMode) {
  switch (mode) {
    case "strict": return error.strictTotal;
    case "semantic": return error.semanticTotal;
    case "expression": return error.expressionTotal;
    case "eyes": return error.eyeBrowTotal;
    case "mouth": return error.mouthTotal;
    case "balanced": return error.balancedTotal;
  }
}

export function rankLiveCandidates(
  index: FixedCandidateSearchIndex<LiveCandidate> | null,
  frame: FixedSearchFrame,
  options: LiveRankOptions = {},
): LiveRankResult {
  if (!index || !index.size) {
    return {
      winner: null,
      ranked: [],
      inspected: 0,
      bucketHits: 0,
      fallbackCandidates: 0,
    };
  }
  const mode = options.mode ?? "strict";
  const recentIds = [...new Set(options.recentIds ?? [])];
  const query = index.query(frame, {
    budget: options.budget ?? 96,
    maxInspected: Math.max(256, (options.budget ?? 96) * 4),
    yawRadiusDegrees: 15,
    pitchRadiusDegrees: 18,
    previousIds: [options.currentId, ...recentIds].filter(
      (value): value is string => Boolean(value),
    ),
  });
  const detailedLimit = Math.max(8, Math.min(
    query.candidates.length,
    options.detailedLimit ?? 40,
  ));
  const holdBias = options.holdBias ?? 0.012;
  const diversityPenalty = options.diversityPenalty ?? 0.012;
  const measured = query.candidates.slice(0, detailedLimit).map((candidate) => {
    const error = projectionError(
      {
        time: 0,
        feature: Array.from(frame.feature),
        geometry: frame.geometry as FaceGeometry,
      },
      candidate,
    );
    let score = scoreForMode(error, mode);
    if (candidate.id === options.currentId) score -= holdBias;
    const recentIndex = recentIds.indexOf(candidate.id);
    if (recentIndex >= 0 && candidate.id !== options.currentId) {
      score += diversityPenalty * (recentIds.length - recentIndex) / Math.max(1, recentIds.length);
    }
    return { candidate, error: { ...error, total: score }, score };
  }).sort((left, right) => left.score - right.score || left.candidate.id.localeCompare(right.candidate.id));

  let winner = measured[0] ?? null;
  const current = options.currentId
    ? measured.find((item) => item.candidate.id === options.currentId) ?? null
    : null;
  if (
    winner &&
    current &&
    current.score <= winner.score + (options.hysteresis ?? 0.01)
  ) {
    winner = current;
  }
  return {
    winner,
    ranked: measured.slice(0, 12),
    inspected: query.inspected,
    bucketHits: query.bucketHits,
    fallbackCandidates: query.fallbackCandidates,
  };
}
