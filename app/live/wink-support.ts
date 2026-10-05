import type { SequenceFrame } from "../offline-matching.ts";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching.ts";
import { winkEvidence, type WinkSide } from "./wink-evidence.ts";
import type { ReviewStrictRanker } from "./review-strict-ranker.ts";

export type WinkSupportCandidate = LiveCandidate & { supportSide: WinkSide; supportKind: "core-refresh" | "addition" };
export const WINK_SUPPORT_BASE_TREE = "559f7f39e3a8eed452ef7eb6a3355a318235c307";
const LEGACY_CATALOG_ID = "many-faces-clean-core-v3";
const safeFile = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
type QualityRecord = { policy?: string; pixelSha256?: string; attributes?: number[]; faceAttributes?: number[] };
type SupportEntry = LiveCatalogEntry & { side?: string; supportKind?: string; imageSha256?: string; qualityV4?: QualityRecord };

function visibleAttributes(values: unknown): values is number[] {
  return Array.isArray(values) && values.length === 5 && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && values[3] < 0.2 && values[4] < 0.2;
}

/** Legacy input remains readable for regression tests. New indexes are bound to
 * the actual manifest ID and contain only unchanged rows from that physical
 * catalog, never a second descriptor version or an outside photograph. */
export function parseWinkSupport(value: unknown, origin: string, expectedCatalogId?: string): WinkSupportCandidate[] {
  if (!value || typeof value !== "object") throw new Error("WINK_SUPPORT_INVALID");
  const payload = value as { schemaVersion?: number; baseCatalogTree?: string; baseCatalogId?: string; items?: SupportEntry[] };
  const current = payload.schemaVersion === 3;
  if (![1, 2, 3].includes(payload.schemaVersion ?? 0) || !Array.isArray(payload.items) || payload.items.length > 1024) throw new Error("WINK_SUPPORT_INVALID");
  if (current) {
    if (!expectedCatalogId || payload.baseCatalogId !== expectedCatalogId || !expectedCatalogId.startsWith("many-faces-visible-v4-")) throw new Error("WINK_SUPPORT_CATALOG_MISMATCH");
  } else if (payload.baseCatalogTree !== WINK_SUPPORT_BASE_TREE || (expectedCatalogId !== undefined && expectedCatalogId !== LEGACY_CATALOG_ID)) {
    throw new Error("WINK_SUPPORT_CATALOG_MISMATCH");
  }
  const seen = new Set<string>();
  return payload.items.map(entry => {
    const kind = payload.schemaVersion === 1 ? "addition" : entry.supportKind;
    if (kind !== "addition" && kind !== "core-refresh") throw new Error("WINK_SUPPORT_INVALID_KIND");
    if (!entry.id || entry.id.length > 240 || seen.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.imageSha256 ?? "")) throw new Error("WINK_SUPPORT_INVALID_ID");
    if (current) {
      const quality = entry.qualityV4;
      if (kind !== "core-refresh" || entry.image || !safeFile(entry.pack) || !/^(clean-v3-|v4-)[A-Za-z0-9_.-]+$/.test(entry.id)) throw new Error("WINK_SUPPORT_INVALID_CORE_REFERENCE");
      if (quality?.policy !== "visible-exact-pixels-v4.1" || quality.pixelSha256 !== entry.imageSha256 || !visibleAttributes(quality.attributes) || !visibleAttributes(quality.faceAttributes)) throw new Error("WINK_SUPPORT_NOT_ADMITTED");
    } else {
      if (kind === "addition" && (!/^wink-extra-[a-f0-9]{24}$/.test(entry.id) || entry.image !== `${entry.id}.webp`)) throw new Error("WINK_SUPPORT_INVALID_IMAGE");
      if (kind === "core-refresh" && (!entry.id.startsWith("clean-v3-") || (entry.image ? !safeFile(entry.image) : !safeFile(entry.pack)))) throw new Error("WINK_SUPPORT_INVALID_CORE_REFERENCE");
    }
    if (!entry.feature || entry.feature.length !== 55 || !entry.feature.every(Number.isFinite) || !entry.creator || !entry.license || !entry.sourceUrl?.startsWith("https://")) throw new Error("WINK_SUPPORT_INVALID_METADATA");
    const candidate = liveCandidateFromEntry(entry, current ? "wink-support-v4" : "wink-support-v1");
    if (!candidate || ![candidate.geometry.structure, candidate.geometry.surface, candidate.geometry.projection].every(vector => Array.from(vector).every(Number.isFinite))) throw new Error("WINK_SUPPORT_INVALID_GEOMETRY");
    const evidence = winkEvidence(candidate.feature, candidate.geometry.projection);
    if (!evidence || evidence.side !== entry.side) throw new Error(`WINK_SUPPORT_EVIDENCE_MISMATCH: ${entry.id}`);
    seen.add(entry.id);
    const url = kind === "addition" ? new URL(`/wink-support/v1/images/${entry.image}`, origin) : new URL(candidate.url, origin);
    if (kind === "core-refresh") url.searchParams.set("source", "seed");
    if (current) url.searchParams.set("catalog", expectedCatalogId!);
    url.searchParams.set("winkIndex", current ? "v4" : "v1");
    return { ...candidate, url: url.href, supportSide: evidence.side, supportKind: kind };
  });
}

export function supportForFrame(frame: SequenceFrame, support: readonly WinkSupportCandidate[]): WinkSupportCandidate[] {
  const evidence = winkEvidence(frame.feature, frame.geometry.projection);
  if (!evidence) return [];
  return support.filter(candidate => candidate.supportSide === evidence.side &&
    Math.abs(candidate.feature[0] - frame.feature[0]) * 90 <= 18 &&
    Math.abs(candidate.feature[1] - frame.feature[1]) * 90 <= 21);
}

// Matching weights, specialist activation and temporal selection are unchanged.
export function rankWinkSupport(frame: SequenceFrame, support: readonly WinkSupportCandidate[], ranker: ReviewStrictRanker, limit = 64) {
  const compatible = supportForFrame(frame, support);
  if (!compatible.length) return null;
  const close = compatible.filter(candidate => Math.abs(candidate.feature[0] - frame.feature[0]) * 90 <= 12 && Math.abs(candidate.feature[1] - frame.feature[1]) * 90 <= 15);
  const candidates = close.length ? close : compatible;
  return ranker.rank(frame, candidates, limit, Math.max(1024, candidates.length));
}
