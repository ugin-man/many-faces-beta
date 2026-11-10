import type { NumericVector, SequenceFrame } from "../offline-matching.ts";
import { FACE_ACTION_FEATURE_INDEX } from "../face-actions.ts";
import { TopK } from "./astra/top-k.ts";
import {
  BROWS, FACE_OVAL, LEFT_EYE, NOSE, OUTER_LIPS, RIGHT_EYE,
  mouthShapeDescriptor, projectionError, ProjectionDescriptorCache,
  type ProjectionCandidate, type ProjectionError,
} from "../projection-matching.ts";

// Video-only specialization. The frozen baseline multi-mode ranker in tests is
// the independent numerical oracle. Candidate admission order, stable ties, all detailed error
// fields and sequence math must remain identical to its .strict result.
const FAST_INDEXES = [...new Set([
  ...FACE_OVAL.filter((_, index) => index % 2 === 0),
  ...LEFT_EYE.filter((_, index) => index % 3 === 0),
  ...RIGHT_EYE.filter((_, index) => index % 3 === 0),
  ...OUTER_LIPS.filter((_, index) => index % 3 === 0),
  ...NOSE.filter((_, index) => index % 3 === 0),
  ...BROWS.filter((_, index) => index % 3 === 0),
])];
const FAST_ACTIONS = [
  "jawOpen", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthFunnel", "mouthPucker", "mouthStretchLeft", "mouthStretchRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeWideLeft", "eyeWideRight",
  "browInnerUp", "browDownLeft", "browDownRight",
] as const;
const FAST_ACTION_INDEXES = FAST_ACTIONS.map(key => FACE_ACTION_FEATURE_INDEX[key]);
const MOUTH_WEIGHTS = {
  jawOpen: 3.2, mouthClose: 1.1, mouthFunnel: 4.6, mouthPucker: 4.8,
  mouthSmileLeft: 1.3, mouthSmileRight: 1.3, mouthFrownLeft: 1, mouthFrownRight: 1,
  mouthStretchLeft: 3.2, mouthStretchRight: 3.2, mouthDimpleLeft: 1.1, mouthDimpleRight: 1.1,
  mouthLeft: 0.8, mouthRight: 0.8, mouthLowerDownLeft: 1.5, mouthLowerDownRight: 1.5,
  mouthPressLeft: 0.8, mouthPressRight: 0.8, mouthRollLower: 1.2, mouthRollUpper: 1.2,
  mouthShrugLower: 1, mouthShrugUpper: 1, mouthUpperUpLeft: 1.5, mouthUpperUpRight: 1.5,
};
// Compile the unchanged weight table once, preserving its accumulation order.
const MOUTH_TERMS = Object.entries(MOUTH_WEIGHTS).map(([key, weight]) =>
  [FACE_ACTION_FEATURE_INDEX[key as keyof typeof MOUTH_WEIGHTS], weight] as const);
const SHAPE_WEIGHTS = [2.2, 2.8, 4.2, 1.8, 4.4, 1.5, 2.2, 2.2];
function value(feature: number[], index: number) { return Math.max(0, Math.min(1, Number(feature[index] ?? 0))); }
function wink(feature: number[]) {
  return value(feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkLeft) - value(feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkRight);
}
function shapeDistance(a: readonly number[], b: readonly number[]) {
  let total = 0, weights = 0;
  for (let index = 0; index < a.length; index++) {
    total += (a[index] - b[index]) ** 2 * SHAPE_WEIGHTS[index];
    weights += SHAPE_WEIGHTS[index];
  }
  return Math.sqrt(total / weights);
}
function actionDistance(a: number[], b: number[]) {
  let total = 0;
  for (const index of FAST_ACTION_INDEXES) {
    const delta = Number(a[index] ?? 0) - Number(b[index] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total / FAST_ACTION_INDEXES.length);
}
function mouthDistance(a: number[], b: number[]) {
  let total = 0, weights = 0;
  for (const [index, weight] of MOUTH_TERMS) {
    const delta = Number(a[index] ?? 0) - Number(b[index] ?? 0);
    total += delta * delta * weight;
    weights += weight;
  }
  return weights ? Math.sqrt(total / weights) : 0;
}
function coarseRms(a: NumericVector, b: NumericVector) {
  let total = 0, count = 0;
  for (const index of FAST_INDEXES) {
    const offset = index * 2;
    if (offset + 1 >= a.length || offset + 1 >= b.length) continue;
    const dx = Number(a[offset] ?? 0) - Number(b[offset] ?? 0);
    const dy = Number(a[offset + 1] ?? 0) - Number(b[offset + 1] ?? 0);
    total += dx * dx + dy * dy;
    count++;
  }
  return count ? Math.sqrt(total / count) : Infinity;
}
export type ReviewRanked<T extends ProjectionCandidate> = { candidate: T; error: ProjectionError };

/** Preserve stable full-sort order, including specialist admission ties. Small
 * pools, full selections, and non-finite scores retain the native sort path.
 */
function selectTop<T>(items: T[], count: number, score: (item: T) => number): T[] {
  if (count >= items.length || items.length < 128) return [...items].sort((a, b) => score(a) - score(b)).slice(0, count);
  const heap = new TopK(count);
  for (let i = 0; i < items.length; i++) {
    const value = score(items[i]);
    if (!Number.isFinite(value)) return [...items].sort((a, b) => score(a) - score(b)).slice(0, count);
    heap.offer(i, value);
  }
  return heap.sorted().map(({ i }) => items[i]);
}

/** One instance per search worker. Parsed candidate geometry is immutable for
 * its lifetime; never reuse this instance across in-place geometry edits.
 * Keys are projection objects, NOT IDs: different records may share an ID.
 * Weak keys cannot keep discarded candidate geometry alive.
 */
export class ReviewStrictRanker {
  private mouthShapes = new WeakMap<NumericVector, number[]>();
  private detailedDescriptors = new ProjectionDescriptorCache();
  private counts = { queries: 0, coarseCandidates: 0, detailedCandidates: 0, descriptorBuilds: 0, descriptorHits: 0 };
  stats() { return { ...this.counts, detailedDescriptors: this.detailedDescriptors.stats() }; }
  clear() { this.mouthShapes = new WeakMap(); this.detailedDescriptors.clear(); }
  private candidateShape(projection: NumericVector) {
    const known = this.mouthShapes.get(projection);
    if (known) { this.counts.descriptorHits++; return known; }
    const shape = mouthShapeDescriptor(projection);
    this.mouthShapes.set(projection, shape);
    this.counts.descriptorBuilds++;
    return shape;
  }
  rank<T extends ProjectionCandidate>(frame: SequenceFrame, candidates: T[], limit = 64, detailedPoolLimit = 1024): ReviewRanked<T>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(detailedPoolLimit) || detailedPoolLimit < 0) throw new RangeError("Invalid review ranking limits");
    this.counts.queries++;
    // Query landmark buffers may be reused by a caller. Only catalog geometry
    // is immutable across queries; always prepare the current query afresh.
    this.detailedDescriptors.invalidate(frame.geometry.projection);
    let selected = candidates;
    if (candidates.length > detailedPoolLimit) {
      const sourceShape = mouthShapeDescriptor(frame.geometry.projection);
      const sourceWink = wink(frame.feature);
      const measured = candidates.map(candidate => {
        const projection = coarseRms(frame.geometry.projection, candidate.geometry.projection);
        const yaw = Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0));
        const pitch = Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0));
        const roll = frame.compensateRoll ? 0 : Math.abs(Number(frame.feature[2] ?? 0) - Number(candidate.feature[2] ?? 0));
        const pose = yaw * 0.8 + pitch * 1.15 + roll * 0.15;
        const action = actionDistance(frame.feature, candidate.feature);
        const mouth = shapeDistance(sourceShape, this.candidateShape(candidate.geometry.projection)) * 0.62 + mouthDistance(frame.feature, candidate.feature) * 0.38;
        const winkError = Math.abs(sourceWink - wink(candidate.feature));
        return { candidate, quick: {
          score: projection * 0.55 + pose * 0.12 + action * 0.15 + mouth * 0.18 + winkError * 0.12,
          pose, action: action + winkError * 0.75, mouth,
        } };
      });
      this.counts.coarseCandidates += candidates.length;
      const admitted = new Map<string, T>();
      const admit = (key: "score" | "pose" | "action" | "mouth", count: number) => {
        for (const item of selectTop(measured, count, item => item.quick[key])) admitted.set(item.candidate.id, item.candidate);
      };
      admit("score", Math.max(limit * 8, Math.floor(detailedPoolLimit * 0.66)));
      admit("pose", Math.max(limit * 2, Math.floor(detailedPoolLimit * 0.2)));
      admit("action", Math.max(limit * 2, Math.floor(detailedPoolLimit * 0.2)));
      admit("mouth", Math.max(limit * 3, Math.floor(detailedPoolLimit * 0.24)));
      selected = [...admitted.values()];
    }
    // Prepared descriptors reuse the same formulas and arithmetic order. All
    // diagnostic errors remain present, including the five unused mode totals.
    const measured = selected.map(candidate => ({ candidate, error: projectionError(frame, candidate, this.detailedDescriptors) }));
    this.counts.detailedCandidates += measured.length;
    const gateLimit = Math.max(limit, Math.min(selected.length, limit * 20));
    const shapePool = selectTop(measured, gateLimit, item => item.error.shapeGate);
    const specialistLimit = Math.min(selected.length, Math.max(limit * 4, 128));
    const specialists = [
      ...selectTop(measured, specialistLimit, item => Math.abs(item.error.pitchDegrees)),
      ...selectTop(measured, specialistLimit, item => item.error.mouthShape),
      ...(Math.abs(wink(frame.feature)) > 0.14 ? selectTop(measured, specialistLimit, item => item.error.wink) : []),
    ];
    const pool = [...new Map([...shapePool, ...specialists].map(item => [item.candidate.id, item])).values()];
    return selectTop(pool, limit, item => item.error.strictTotal)
      .map(({ candidate, error }) => ({ candidate, error: { ...error, total: error.strictTotal } }));
  }
}
