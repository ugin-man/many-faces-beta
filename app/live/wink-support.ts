import type { SequenceFrame } from "../offline-matching.ts";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching.ts";
import { winkEvidence, type WinkSide } from "./wink-evidence.ts";
import type { ReviewStrictRanker } from "./review-strict-ranker.ts";

export type WinkSupportCandidate = LiveCandidate & { supportSide: WinkSide; supportKind: "core-refresh" | "addition" };
export const WINK_SUPPORT_BASE_TREE = "559f7f39e3a8eed452ef7eb6a3355a318235c307";
const safeFile = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";

/** The original photograph and descriptor files are immutable. Core entries
 * here are fresh descriptors of the exact same encoded photograph; additions
 * have independently attributed image bytes. Neither kind changes raw scores.
 */
export function parseWinkSupport(value: unknown, origin: string): WinkSupportCandidate[] {
  if (!value || typeof value !== "object") throw new Error("WINK_SUPPORT_INVALID");
  const payload = value as { schemaVersion?: number; baseCatalogTree?: string; items?: (LiveCatalogEntry & { side?: string; supportKind?: string; imageSha256?: string })[] };
  if (![1, 2].includes(payload.schemaVersion ?? 0) || payload.baseCatalogTree !== WINK_SUPPORT_BASE_TREE || !Array.isArray(payload.items) || payload.items.length > 1024) throw new Error("WINK_SUPPORT_INVALID");
  const seen = new Set<string>();
  return payload.items.map(entry => {
    const kind = payload.schemaVersion === 1 ? "addition" : entry.supportKind;
    if (kind !== "addition" && kind !== "core-refresh") throw new Error("WINK_SUPPORT_INVALID_KIND");
    if (!entry.id || entry.id.length > 240 || seen.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.imageSha256 ?? "")) throw new Error("WINK_SUPPORT_INVALID_ID");
    if (kind === "addition" && (!/^wink-extra-[a-f0-9]{24}$/.test(entry.id) || entry.image !== `${entry.id}.webp`)) throw new Error("WINK_SUPPORT_INVALID_IMAGE");
    if (kind === "core-refresh" && (!entry.id.startsWith("clean-v3-") || (entry.image ? !safeFile(entry.image) : !safeFile(entry.pack)))) throw new Error("WINK_SUPPORT_INVALID_CORE_REFERENCE");
    if (!entry.feature || entry.feature.length !== 55 || !entry.feature.every(Number.isFinite) || !entry.creator || !entry.license || !entry.sourceUrl?.startsWith("https://")) throw new Error("WINK_SUPPORT_INVALID_METADATA");
    const candidate = liveCandidateFromEntry(entry, "wink-support-v1");
    if (!candidate || ![candidate.geometry.structure, candidate.geometry.surface, candidate.geometry.projection].every(vector => Array.from(vector).every(Number.isFinite))) throw new Error("WINK_SUPPORT_INVALID_GEOMETRY");
    const evidence = winkEvidence(candidate.feature, candidate.geometry.projection);
    if (!evidence || evidence.side !== entry.side) throw new Error(`WINK_SUPPORT_EVIDENCE_MISMATCH: ${entry.id}`);
    seen.add(entry.id);
    const url = kind === "addition" ? new URL(`/wink-support/v1/images/${entry.image}`, origin) : new URL(candidate.url, origin);
    if (kind === "core-refresh") url.searchParams.set("source", "seed");
    url.searchParams.set("winkIndex", "v1");
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
