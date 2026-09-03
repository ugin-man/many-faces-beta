export type ReviewPhaseTimings = {
  preparation: number;
  faceMesh: number;
  candidateSearch: number;
  pathOptimization: number;
  imagePreload: number;
};

export function emptyReviewPhaseTimings(): ReviewPhaseTimings {
  return {
    preparation: 0,
    faceMesh: 0,
    candidateSearch: 0,
    pathOptimization: 0,
    imagePreload: 0,
  };
}

/**
 * Small deterministic fingerprint for E2E parity checks. The complete ordered
 * ID list is also kept in the report; the fingerprint only makes regressions
 * easy to spot in logs and review receipts.
 */
export function reviewSequenceFingerprint(ids: readonly string[]) {
  let hash = 0x811c9dc5;
  const text = ids.join("\u001f");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function roundedReviewPhaseTimings(
  timings: ReviewPhaseTimings,
): ReviewPhaseTimings {
  return {
    preparation: Math.round(timings.preparation * 10) / 10,
    faceMesh: Math.round(timings.faceMesh * 10) / 10,
    candidateSearch: Math.round(timings.candidateSearch * 10) / 10,
    pathOptimization: Math.round(timings.pathOptimization * 10) / 10,
    imagePreload: Math.round(timings.imagePreload * 10) / 10,
  };
}
