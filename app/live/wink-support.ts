import type { SequenceFrame } from "../offline-matching.ts";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching.ts";
import { winkEvidence, type WinkSide } from "./wink-evidence.ts";
import type { ReviewStrictRanker } from "./review-strict-ranker.ts";

export type WinkSupportCandidate = LiveCandidate & { supportSide: WinkSide; supportKind: "core-refresh" | "addition" };
export const WINK_SUPPORT_BASE_TREE = "559f7f39e3a8eed452ef7eb6a3355a318235c307";
export type WinkSupportBinding = { catalogId?: string; manifestSha256?: string; qualityAdmission?: unknown; winkExpressionReview?: unknown };
export const WINK_SUPPORT_MAX_ITEMS = 1024;
export const WINK_SUPPORT_MAX_BYTES = 4 * 1024 * 1024;
const safeFile = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** The original photograph and descriptor files are immutable. Newly admitted
 * cores require exact-image reviewed wink sides as well as unchanged automatic
 * evidence. Historical unstamped catalogs retain their original additions.
 */
export function parseWinkSupport(value: unknown, origin: string, binding?: WinkSupportBinding): WinkSupportCandidate[] {
  if (!value || typeof value !== "object") throw new Error("WINK_SUPPORT_INVALID");
  const payload = value as {
    schemaVersion?: number; baseCatalogTree?: string; baseCatalogId?: string; baseCatalogManifestSha256?: string;
    policySha256?: string; winkExpressionReviewSha256?: string;
    items?: (LiveCatalogEntry & {
      side?: string; supportKind?: string; imageSha256?: string; admissionSha256?: string; admissionPolicySha256?: string;
      cleanProfile?: string; cleanTier?: string;
      winkExpressionEvidence?: { schemaVersion?: number; encodedSha256?: string; side?: string; reviewSha256?: string } | null;
    })[];
  };
  if (![1, 2, 3].includes(payload.schemaVersion ?? 0) || !Array.isArray(payload.items) || payload.items.length > WINK_SUPPORT_MAX_ITEMS) throw new Error("WINK_SUPPORT_INVALID");
  const bound = payload.schemaVersion === 3;
  // Old recorded-video baselines keep their original specialist behavior. A
  // newly admitted core may never reuse the legacy extras or old pack offsets.
  if (binding?.qualityAdmission !== undefined && !bound) throw new Error("WINK_SUPPORT_LEGACY_UNBOUND");
  if (bound) {
    const stamp = binding?.qualityAdmission as { schemaVersion?: number; status?: string; policySha256?: string; receiptSha256?: string; recordsSha256?: string; selectedCount?: number; runtimeExclusionOverlayRequired?: boolean } | null | undefined;
    if (!stamp || stamp.schemaVersion !== 2 || stamp.status !== "complete" || stamp.selectedCount !== 70000 || stamp.runtimeExclusionOverlayRequired !== false || !digest(stamp.policySha256)) throw new Error("WINK_SUPPORT_ADMISSION_REQUIRED");
    if (!binding?.catalogId || !digest(binding.manifestSha256) || payload.baseCatalogId !== binding.catalogId || payload.baseCatalogManifestSha256 !== binding.manifestSha256 || payload.policySha256 !== stamp.policySha256) throw new Error("WINK_SUPPORT_CATALOG_MISMATCH");
    const review = binding.winkExpressionReview as {
      schemaVersion?: number; documentKind?: string; mode?: string; reviewSha256?: string;
      candidateAuditSha256?: string; recordsSha256?: string; reviewer?: string; humanVerified?: boolean;
    } | null | undefined;
    if (!review || review.schemaVersion !== 1 || review.documentKind !== "clean-core-wink-expression-review" || review.mode !== "confirmed-side-only" || !digest(review.reviewSha256) || !digest(review.candidateAuditSha256) || !digest(review.recordsSha256) || review.candidateAuditSha256 !== stamp.receiptSha256 || review.recordsSha256 !== stamp.recordsSha256 || review.reviewer !== "assistant-visual-review" || review.humanVerified !== false) throw new Error("WINK_SUPPORT_REVIEW_REQUIRED");
    if (payload.winkExpressionReviewSha256 !== review.reviewSha256) throw new Error("WINK_SUPPORT_REVIEW_MISMATCH");
  } else if (payload.baseCatalogTree !== WINK_SUPPORT_BASE_TREE) throw new Error("WINK_SUPPORT_INVALID");
  const seen = new Set<string>();
  return payload.items.map(entry => {
    const kind = payload.schemaVersion === 1 ? "addition" : entry.supportKind;
    if (kind !== "addition" && kind !== "core-refresh") throw new Error("WINK_SUPPORT_INVALID_KIND");
    if (!entry.id || entry.id.length > 240 || seen.has(entry.id) || !digest(entry.imageSha256)) throw new Error("WINK_SUPPORT_INVALID_ID");
    if (bound && (kind !== "core-refresh" || entry.admissionSha256 !== entry.imageSha256 || entry.admissionPolicySha256 !== payload.policySha256)) throw new Error("WINK_SUPPORT_UNADMITTED_IMAGE");
    if (kind === "addition" && (!/^wink-extra-[a-f0-9]{24}$/.test(entry.id) || entry.image !== `${entry.id}.webp`)) throw new Error("WINK_SUPPORT_INVALID_IMAGE");
    if (kind === "core-refresh") {
      if (bound) {
        if (entry.id !== `clean-v5-${entry.imageSha256.slice(0, 28)}` || Object.prototype.hasOwnProperty.call(entry, "image") || !safeFile(entry.pack) || !Number.isSafeInteger(entry.offset) || Number(entry.offset) < 0 || !Number.isSafeInteger(entry.length) || Number(entry.length) < 1) throw new Error("WINK_SUPPORT_INVALID_CORE_REFERENCE");
      } else if (!entry.id.startsWith("clean-v3-") || (entry.image ? !safeFile(entry.image) : !safeFile(entry.pack))) throw new Error("WINK_SUPPORT_INVALID_CORE_REFERENCE");
    }
    if (bound) {
      const side = entry.cleanProfile === "winkLeft" ? "left" : entry.cleanProfile === "winkRight" ? "right" : undefined;
      const reviewed = entry.winkExpressionEvidence;
      if (!side || !["strict", "observed"].includes(entry.cleanTier ?? "") || entry.side !== side || !reviewed || reviewed.schemaVersion !== 1 || reviewed.side !== side || reviewed.encodedSha256 !== entry.imageSha256 || reviewed.reviewSha256 !== payload.winkExpressionReviewSha256) throw new Error("WINK_SUPPORT_REVIEW_EVIDENCE_MISMATCH");
    }
    if (!entry.feature || entry.feature.length !== 55 || !entry.feature.every(Number.isFinite) || !entry.creator || !entry.license || !entry.sourceUrl?.startsWith("https://")) throw new Error("WINK_SUPPORT_INVALID_METADATA");
    const candidate = liveCandidateFromEntry(entry, "wink-support-v1");
    if (!candidate || ![candidate.geometry.structure, candidate.geometry.surface, candidate.geometry.projection].every(vector => Array.from(vector).every(Number.isFinite))) throw new Error("WINK_SUPPORT_INVALID_GEOMETRY");
    const evidence = winkEvidence(candidate.feature, candidate.geometry.projection);
    if (!evidence || evidence.side !== entry.side) throw new Error(`WINK_SUPPORT_EVIDENCE_MISMATCH: ${entry.id}`);
    seen.add(entry.id);
    const url = kind === "addition" ? new URL(`/wink-support/v1/images/${entry.image}`, origin) : new URL(candidate.url, origin);
    if (kind === "core-refresh") url.searchParams.set("source", "seed");
    if (bound) url.searchParams.set("catalog", payload.baseCatalogManifestSha256!);
    url.searchParams.set("winkIndex", bound ? "v3" : "v1");
    return { ...candidate, url: url.href, supportSide: evidence.side, supportKind: kind };
  });
}

/** Provisional positive-action gate. Negative/ambiguous input is an exact
 * no-op. Source/photograph anatomical eye sides must agree; a generic blink
 * difference alone is insufficient. Bounds never exceed the existing expanded
 * video neighborhood. A missing compatible photo returns to the old matcher.
 */
export function supportForFrame(frame: SequenceFrame, support: readonly WinkSupportCandidate[]): WinkSupportCandidate[] {
  const evidence = winkEvidence(frame.feature, frame.geometry.projection);
  if (!evidence) return [];
  return support.filter(candidate => candidate.supportSide === evidence.side &&
    Math.abs(candidate.feature[0] - frame.feature[0]) * 90 <= 18 &&
    Math.abs(candidate.feature[1] - frame.feature[1]) * 90 <= 21);
}

/** For a clearly corroborated wink, preserve the closed-eye state first and
 * rank compatible real photographs with the unchanged detailed scorer. This
 * is an explicit matching-policy change, not merely a larger data count, and
 * can trade other facial similarity for the correct eye state. It is restricted
 * to recorded video; ordinary frames use the original full candidate pool.
 */
export function rankWinkSupport(frame: SequenceFrame, support: readonly WinkSupportCandidate[], ranker: ReviewStrictRanker, limit = 64) {
  const compatible = supportForFrame(frame, support);
  if (!compatible.length) return null;
  const close = compatible.filter(candidate => Math.abs(candidate.feature[0] - frame.feature[0]) * 90 <= 12 && Math.abs(candidate.feature[1] - frame.feature[1]) * 90 <= 15);
  const candidates = close.length ? close : compatible;
  return ranker.rank(frame, candidates, limit, Math.max(1024, candidates.length));
}
