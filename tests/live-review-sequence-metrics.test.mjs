import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyReviewPhaseTimings,
  reviewSequenceFingerprint,
  roundedReviewPhaseTimings,
} from "../app/live/review-sequence-metrics.ts";

test("sequence fingerprints preserve order and repeat deterministically", () => {
  const ids = ["face-a", "face-b", "face-c"];
  assert.equal(reviewSequenceFingerprint(ids), reviewSequenceFingerprint(ids));
  assert.notEqual(
    reviewSequenceFingerprint(ids),
    reviewSequenceFingerprint(["face-a", "face-c", "face-b"]),
  );
  assert.notEqual(
    reviewSequenceFingerprint(ids),
    reviewSequenceFingerprint(["face-a", "face-b"]),
  );
});

test("phase timings start at zero and are rounded for stable receipts", () => {
  assert.deepEqual(emptyReviewPhaseTimings(), {
    preparation: 0,
    faceMesh: 0,
    candidateSearch: 0,
    pathOptimization: 0,
    imagePreload: 0,
  });
  assert.deepEqual(
    roundedReviewPhaseTimings({
      preparation: 1.234,
      faceMesh: 2.345,
      candidateSearch: 3.456,
      pathOptimization: 4.567,
      imagePreload: 5.678,
    }),
    {
      preparation: 1.2,
      faceMesh: 2.3,
      candidateSearch: 3.5,
      pathOptimization: 4.6,
      imagePreload: 5.7,
    },
  );
});
