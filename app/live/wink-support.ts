import type { SequenceFrame } from "../offline-matching.ts";
import { liveCandidateFromEntry, type LiveCandidate, type LiveCatalogEntry } from "../live-matching.ts";
import { winkEvidence, type WinkSide } from "./wink-evidence.ts";

export type WinkSupportCandidate = LiveCandidate & { supportSide: WinkSide };
export const WINK_SUPPORT_BASE_TREE = "559f7f39e3a8eed452ef7eb6a3355a318235c307";

/** Small additive corpus. The original 70k descriptors and photos are never
 * edited, resampled or removed. Metadata and pixels are explicitly coupled.
 */
export function parseWinkSupport(value: unknown, origin: string): WinkSupportCandidate[] {
  if (!value || typeof value !== "object") throw new Error("WINK_SUPPORT_INVALID");
  const payload = value as { schemaVersion?: number; baseCatalogTree?: string; items?: (LiveCatalogEntry & { side?: string; imageSha256?: string })[] };
  if (payload.schemaVersion !== 1 || payload.baseCatalogTree !== WINK_SUPPORT_BASE_TREE || !Array.isArray(payload.items) || payload.items.length > 32) throw new Error("WINK_SUPPORT_INVALID");
  const seen = new Set<string>();
  return payload.items.map(entry => {
    if (!/^wink-extra-[a-f0-9]{24}$/.test(entry.id) || entry.image !== `${entry.id}.webp` || seen.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.imageSha256 ?? "")) throw new Error("WINK_SUPPORT_INVALID_ID");
    if (!entry.feature || entry.feature.length !== 55 || !entry.feature.every(Number.isFinite) || !entry.creator || !entry.license || !entry.sourceUrl?.startsWith("https://")) throw new Error("WINK_SUPPORT_INVALID_METADATA");
    const candidate = liveCandidateFromEntry(entry, "wink-support-v1");
    if (!candidate || !Array.from(candidate.geometry.projection).every(Number.isFinite)) throw new Error("WINK_SUPPORT_INVALID_GEOMETRY");
    const evidence = winkEvidence(candidate.feature, candidate.geometry.projection);
    if (!evidence || evidence.side !== entry.side) throw new Error("WINK_SUPPORT_EVIDENCE_MISMATCH");
    seen.add(entry.id);
    return { ...candidate, url: new URL(`/wink-support/v1/images/${entry.image}`, origin).href, supportSide: evidence.side };
  });
}

/** Only append compatible same-side candidates for corroborated winks. No
 * changed raw scores and no forced winner; ordinary expressions use the same
 * original pool. Bounds match the existing expanded pose neighborhood.
 */
export function supportForFrame(frame: SequenceFrame, support: readonly WinkSupportCandidate[]): WinkSupportCandidate[] {
  const evidence = winkEvidence(frame.feature, frame.geometry.projection);
  if (!evidence) return [];
  return support.filter(candidate => candidate.supportSide === evidence.side &&
    Math.abs(candidate.feature[0] - frame.feature[0]) * 90 <= 18 &&
    Math.abs(candidate.feature[1] - frame.feature[1]) * 90 <= 21);
}
