import { decodeCatalogVector, type LiveCandidate, type LiveCatalogEntry } from "../live-matching.ts";

export const REVIEW_CATALOG_SCHEMA = "many-faces-review-catalog-v1";
export type ReviewCompactManifest = {
  schema: typeof REVIEW_CATALOG_SCHEMA;
  sourceManifestSha256: string;
  catalogId: string;
  records: number;
  shards: Record<string, { sha256: string; records: number; bytes: number }>;
};
export type ReviewCompactShard = {
  schema: typeof REVIEW_CATALOG_SCHEMA;
  sourceManifestSha256: string;
  sourceShardSha256: string;
  catalogId: string;
  items: LiveCatalogEntry[];
};

const EMPTY_STRUCTURE = new Float32Array(0);
function finite(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** Validate the legacy admission rule without constructing its unused vector. */
function validLegacyShape(encoded: string | undefined) {
  if (!encoded) return false;
  try {
    const binary = atob(encoded);
    return binary.length >= 26 && binary.length % 2 === 0;
  } catch { return false; }
}

/** Video matching and composition consume projection/layout, not structure or
 * surface. Compact records have already passed liveCandidateFromEntry at build
 * time; legacy fallback still checks its original shape admission condition.
 * This loader must not be used by the other geometry matching modes. */
export function reviewCandidateFromEntry(entry: LiveCatalogEntry, shard: string, compact = false): LiveCandidate | null {
  if (!entry.id || !Array.isArray(entry.feature) || entry.feature.length < 22) return null;
  if (!compact && !validLegacyShape(entry.shape)) return null;
  const projection = decodeCatalogVector(entry.projection);
  if (!projection || projection.length < 936) return null;
  const url = entry.image ? `/api/catalog/image?id=${encodeURIComponent(entry.image)}`
    : entry.pack && Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.length) &&
      Number(entry.offset) >= 0 && Number(entry.length) >= 1
      ? `/api/catalog/image?pack=${encodeURIComponent(entry.pack)}&offset=${entry.offset}&length=${entry.length}` : null;
  if (!url) return null;
  const layout = Array.isArray(entry.layout) && entry.layout.length === 4 && entry.layout.every(Number.isFinite)
    ? entry.layout : [0.5, 0.5, 1, 1] as [number, number, number, number];
  return {
    id: entry.id, name: entry.name || entry.id, url,
    image: entry.image, pack: entry.pack, offset: entry.offset, length: entry.length,
    feature: entry.feature.map(finite), geometry: { structure: EMPTY_STRUCTURE, surface: projection, projection, layout },
    sourceName: entry.sourceName, sourceUrl: entry.sourceUrl, creator: entry.creator,
    license: entry.license, licenseUrl: entry.licenseUrl, shard,
  };
}

export function isReviewCompactManifest(value: unknown, sourceManifestSha256: string, catalogId: string): value is ReviewCompactManifest {
  if (!value || typeof value !== "object") return false;
  const data = value as ReviewCompactManifest;
  return data.schema === REVIEW_CATALOG_SCHEMA && data.sourceManifestSha256 === sourceManifestSha256 &&
    data.catalogId === catalogId && Number.isSafeInteger(data.records) && data.records >= 0 &&
    Boolean(data.shards && typeof data.shards === "object" && !Array.isArray(data.shards)) &&
    Object.entries(data.shards).every(([file, item]) => /^[a-z0-9_.+-]+\.json$/i.test(file) &&
      item && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.records) && item.records >= 0 &&
      Number.isSafeInteger(item.bytes) && item.bytes > 0);
}

export function isReviewCompactShard(value: unknown, manifest: ReviewCompactManifest, file: string): value is ReviewCompactShard {
  if (!value || typeof value !== "object") return false;
  const data = value as ReviewCompactShard;
  return data.schema === REVIEW_CATALOG_SCHEMA && data.sourceManifestSha256 === manifest.sourceManifestSha256 &&
    data.catalogId === manifest.catalogId && data.sourceShardSha256 === manifest.shards[file]?.sha256 &&
    Array.isArray(data.items) && data.items.length === manifest.shards[file]?.records;
}

/** Payload estimate, not browser RSS. Includes numeric storage plus bounded
 * metadata allowance; an oversized shard is served but never retained. */
export function reviewCandidateBytes(candidates: readonly LiveCandidate[]) {
  return candidates.reduce((total, candidate) => total +
    candidate.geometry.projection.length * 4 + candidate.feature.length * 8 +
    (candidate.id.length + candidate.url.length + candidate.name.length +
      (candidate.sourceName?.length ?? 0) + (candidate.sourceUrl?.length ?? 0) +
      (candidate.creator?.length ?? 0) + (candidate.license?.length ?? 0) + (candidate.licenseUrl?.length ?? 0)) * 2 + 512, 0);
}
