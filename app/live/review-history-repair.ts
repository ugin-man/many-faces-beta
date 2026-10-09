import type { NumericVector, SequenceFrame } from "../offline-matching";
import {
  COARSE_INDEXES, expressionResidualMotion, rareActionPenalty,
  residualMotionAtIndexes, sourceExpressionActivity,
  type ProjectionCandidate, type ProjectionChoice, type ProjectionError,
} from "../projection-matching.ts";
import {
  compareReviewSequences, measureReviewSequence, REVIEW_HISTORY_OPTIONS,
  REVIEW_HISTORY_QUALITY_BUDGET, REVIEW_SEQUENCE_OPTIONS,
} from "./review-history-selection.ts";

export type ReviewHistoryRepairOptions = {
  enabled: boolean;
  maxFrames: number;
  maxIntervalFrames: number;
  maxEvents: number;
  maxCandidatesInspected: number;
  maxScoredPatches: number;
  maxTrials: number;
  maxPatches: number;
};

/** Work limits, not quality allowances. Callers may lower these limits. */
export const REVIEW_HISTORY_REPAIR_OPTIONS: Readonly<ReviewHistoryRepairOptions> = Object.freeze({
  enabled: true, maxFrames: 12000, maxIntervalFrames: 240, maxEvents: 64,
  maxCandidatesInspected: 750000, maxScoredPatches: 512, maxTrials: 128, maxPatches: 16,
});

type Ranked<T extends ProjectionCandidate> = { candidate: T; error: ProjectionError };
type Metrics = ReturnType<typeof measureReviewSequence>;
type Comparison = ReturnType<typeof compareReviewSequences>;
type PatchKind = "bridge-gap" | "replace-return" | "replace-earlier";
type Run = { id: string; start: number; end: number };
type RecentEvent = { previous: Run; returning: Run };
type Interval = { kind: PatchKind; start: number; end: number; onlyId?: string; excludeId?: string };
type Intersection<T extends ProjectionCandidate> = { id: string; items: Ranked<T>[] };
type Proposal<T extends ProjectionCandidate> = {
  interval: Interval; id: string; replacement: ProjectionChoice<T>[];
  following?: ProjectionChoice<T>; objectiveDelta: number;
};

const LOCAL_KEYS = ["mouth", "mouthShape", "eyes", "leftEye", "rightEye", "brows", "wink", "blink", "worstLocal"] as const;
const AXIS_KEYS = ["yawDegrees", "pitchDegrees", "rollDegrees"] as const;
const ERROR_KEYS: readonly (keyof ProjectionError)[] = [
  "total", "balancedTotal", "expressionTotal", "strictTotal", "semanticTotal", "eyeBrowTotal", "mouthTotal",
  "contour", "features", "mouth", "eyes", "leftEye", "rightEye", "brows", "expression", "descriptor",
  "blendshape", "mouthDescriptor", "mouthShape", "mouthAction", "eyeDescriptor", "browDescriptor",
  "shapeGate", "worstLocal", "poseDegrees", ...AXIS_KEYS, "wink", "blink",
];
const WINDOW_SECONDS = REVIEW_HISTORY_OPTIONS.windowSeconds;
const policy = REVIEW_SEQUENCE_OPTIONS;
const QUALITY_THRESHOLD = Math.max(0.005, policy.qualityThreshold ?? 0.055);
const COHERENCE = Math.max(0, Math.min(3, policy.residualCoherence ?? 0.65));
const MOTION_WEIGHT = Math.max(0, Math.min(12, policy.expressionMotionWeight ?? 4.2));
const weights = policy.motionWeights ?? { mouth: 0.5, eyes: 0.3, brows: 0.2 };
const weightTotal = Math.max(0.001, weights.mouth + weights.eyes + weights.brows);
const MOTION_WEIGHTS = { mouth: weights.mouth / weightTotal, eyes: weights.eyes / weightTotal, brows: weights.brows / weightTotal };
const compareId = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** The exact existing per-frame tests, always relative to the original baseline. */
function fitsFrameBudget(error: ProjectionError, original: ProjectionError) {
  const budget = REVIEW_HISTORY_QUALITY_BUDGET;
  return error.total - original.total <= budget.maximumFrameErrorIncrease &&
    LOCAL_KEYS.every(key => error[key] - original[key] <= budget.maximumLocalErrorIncrease) &&
    AXIS_KEYS.every(key => Math.abs(error[key]) - Math.abs(original[key]) <= budget.maximumPoseIncreaseDegrees);
}

function validError(error: ProjectionError) {
  return error !== null && typeof error === "object" && ERROR_KEYS.every(key =>
    Number.isFinite(error[key]) && (key === "yawDegrees" || key === "pitchDegrees" || key === "rollDegrees" || error[key] >= 0));
}

function validVector(vector: NumericVector | undefined, requiredLength: number, maximumLength: number) {
  return (Array.isArray(vector) || vector instanceof Float32Array) &&
    vector.length >= requiredLength && vector.length <= maximumLength && vector.every(Number.isFinite);
}

function validFace(face: SequenceFrame | ProjectionCandidate) {
  return !!face && Array.isArray(face.feature) && validVector(face.feature, 3, 512) &&
    !!face.geometry && validVector(face.geometry.projection, 468 * 2, 468 * 2);
}

function sameVector(left: NumericVector, right: NumericVector) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recentEvents<T extends ProjectionCandidate>(choices: ProjectionChoice<T>[]) {
  const runs: Run[] = [];
  for (let index = 0; index < choices.length; index++) {
    const id = choices[index].candidate.id, last = runs[runs.length - 1];
    if (last?.id === id) last.end = index;
    else runs.push({ id, start: index, end: index });
  }
  const latest = new Map<string, Run>(), events: RecentEvent[] = [];
  for (const returning of runs) {
    const previous = latest.get(returning.id);
    // Departure is the first sample of the next run, not the last held sample.
    if (previous && choices[returning.start].frame.time < choices[previous.end + 1].frame.time + WINDOW_SECONDS) {
      events.push({ previous, returning });
    }
    latest.set(returning.id, returning);
  }
  return events;
}

/**
 * Experimental local repair of an already computed baseline. It never reranks
 * the catalog or changes a decision outside an implicated run or its gap.
 * Each proposal holds one supplied photo throughout its complete interval.
 * This bounded greedy search makes no claim of a globally optimal sequence.
 *
 * Baseline geometry is validated before measurement. Explored ranked records
 * are validated as read; geometry is checked only after cheap fidelity tests.
 * A malformed explored record rolls back all tentative repairs. Reaching a
 * work cap keeps only fully verified repairs and reports the incomplete search.
 */
export function repairHistoryAwareReviewSequence<T extends ProjectionCandidate>(
  baseline: ProjectionChoice<T>[], beams: Ranked<T>[][],
  suppliedOptions: Partial<ReviewHistoryRepairOptions> = {},
) {
  const limits = { ...REVIEW_HISTORY_REPAIR_OPTIONS, ...suppliedOptions };
  const capReasons = new Set<string>(), rejectedReasons: Record<string, number> = {};
  const patches: { kind: PatchKind; start: number; end: number; candidateId: string;
    recentBefore: number; recentAfter: number; objectiveDelta: number }[] = [];
  let candidatesInspected = 0, fidelityRejected = 0, scoredPatches = 0, triedPatches = 0, eventsInspected = 0;
  let invalidReason: string | null = null, before: Metrics | null = null, after: Metrics | null = null;
  let comparison: Comparison | null = null;
  let current = baseline;
  const finish = (reason: string, rollback = false) => ({
    choices: rollback ? baseline : current,
    diagnostics: {
      adopted: !rollback && patches.length > 0, reason, invalidReason,
      before, after: rollback ? before : after, comparison: rollback ? null : comparison,
      candidatesInspected, fidelityRejected, scoredPatches, triedPatches, eventsInspected,
      adoptedPatches: rollback ? 0 : patches.length, rolledBackPatches: rollback ? patches.length : 0,
      patches: rollback ? [] : patches, rejectedReasons,
      capHit: capReasons.size > 0, capReasons: [...capReasons], limits, windowSeconds: WINDOW_SECONDS,
    },
  });
  if (suppliedOptions?.enabled === false) return finish("disabled");
  if (!suppliedOptions || typeof suppliedOptions !== "object" || typeof limits.enabled !== "boolean" ||
    Object.keys(REVIEW_HISTORY_REPAIR_OPTIONS).some(key => {
      if (key === "enabled") return false;
      const name = key as Exclude<keyof ReviewHistoryRepairOptions, "enabled">;
      return !Number.isInteger(limits[name]) || limits[name] < 0 || limits[name] > REVIEW_HISTORY_REPAIR_OPTIONS[name];
    })) {
    invalidReason = "repair-options"; return finish("invalid-input", true);
  }
  if (!Array.isArray(baseline) || !Array.isArray(beams) || baseline.length !== beams.length) {
    invalidReason = "frame-coverage"; return finish("invalid-input", true);
  }
  if (baseline.length > limits.maxFrames) { capReasons.add("maxFrames"); return finish("input-frame-cap"); }

  const knownPhotos = new Map<string, T>(), checkedPhotos = new WeakSet<T>();
  const validatePhoto = (candidate: T) => {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id) return false;
    if (checkedPhotos.has(candidate)) return true;
    if (!validFace(candidate)) return false;
    const known = knownPhotos.get(candidate.id);
    if (known && (!sameVector(known.feature, candidate.feature) ||
      !sameVector(known.geometry.projection, candidate.geometry.projection))) return false;
    knownPhotos.set(candidate.id, candidate); checkedPhotos.add(candidate);
    return true;
  };
  for (let index = 0; index < baseline.length; index++) {
    const choice = baseline[index];
    if (!Array.isArray(beams[index]) || !choice || !validFace(choice.frame) || !validatePhoto(choice.candidate) ||
      !validError(choice.error) || !Number.isFinite(choice.emission) || typeof choice.accepted !== "boolean" ||
      !Number.isFinite(choice.expressionMotion) || choice.expressionMotion < 0 ||
      !Number.isFinite(choice.frame.time) || choice.frame.time < 0 ||
      (index > 0 && choice.frame.time <= baseline[index - 1].frame.time)) {
      invalidReason = "baseline-or-beam-shape"; return finish("invalid-input", true);
    }
  }
  before = measureReviewSequence(baseline, WINDOW_SECONDS); after = before;
  if (!before.recentReappearances) return finish("no-recent-reappearances");

  const read = (item: Ranked<T>) => {
    if (candidatesInspected >= limits.maxCandidatesInspected) { capReasons.add("maxCandidatesInspected"); return false; }
    candidatesInspected++;
    if (!item || !item.candidate || typeof item.candidate.id !== "string" || !item.candidate.id || !validError(item.error)) {
      invalidReason = "ranked-record"; return false;
    }
    return true;
  };

  // Start with the smallest supplied pool, then intersect complete runs. Only
  // surviving IDs accumulate records, so memory is bounded by inspected entries.
  const intersect = (interval: Interval) => {
    const length = interval.end - interval.start + 1;
    if (length > limits.maxIntervalFrames) { capReasons.add("maxIntervalFrames"); return null; }
    const order = Array.from({ length }, (_, index) => interval.start + index)
      .sort((left, right) => beams[left].length - beams[right].length || left - right);
    let found = new Map<string, Intersection<T>>();
    for (let step = 0; step < order.length; step++) {
      const frameIndex = order[step], next = new Map<string, Intersection<T>>();
      for (const item of beams[frameIndex]) {
        if (!read(item)) return null;
        const id = item.candidate.id;
        if ((interval.onlyId && id !== interval.onlyId) || id === interval.excludeId || (step > 0 && !found.has(id))) continue;
        if (!fitsFrameBudget(item.error, baseline[frameIndex].error)) { fidelityRejected++; continue; }
        if (next.has(id)) { invalidReason = "duplicate-ranked-id"; return null; }
        const entry = step === 0 ? { id, items: [] as Ranked<T>[] } : found.get(id)!;
        entry.items.push(item); next.set(id, entry);
      }
      found = next;
      if (!found.size) break;
    }
    return { order, matches: [...found.values()] };
  };

  const activity = new Map<number, number>();
  const objective = (index: number, choice: ProjectionChoice<T>, previous?: ProjectionChoice<T>) => {
    let expression = 0, residual = 0, boost = 0;
    if (previous) {
      if (!activity.has(index)) activity.set(index, Math.min(1.8, sourceExpressionActivity(previous.frame, choice.frame) / 0.012));
      boost = activity.get(index)!;
      residual = residualMotionAtIndexes(previous.frame, previous.candidate, choice.frame, choice.candidate, COARSE_INDEXES);
      expression = expressionResidualMotion(previous.frame, previous.candidate, choice.frame, choice.candidate, MOTION_WEIGHTS);
    }
    return { expression, cost: choice.error.total + rareActionPenalty(choice.frame, choice.error) +
      residual * COHERENCE * 0.35 + expression * MOTION_WEIGHT * (0.45 + boost) };
  };
  let currentCosts: (number | undefined)[] = [];
  const score = (interval: Interval, match: Intersection<T>, order: number[]): Proposal<T> | null => {
    if (scoredPatches >= limits.maxScoredPatches) { capReasons.add("maxScoredPatches"); return null; }
    scoredPatches++;
    const replacement: ProjectionChoice<T>[] = Array(interval.end - interval.start + 1);
    for (let slot = 0; slot < order.length; slot++) {
      const index = order[slot], item = match.items[slot];
      if (!validatePhoto(item.candidate)) { invalidReason = "candidate-geometry-or-id-conflict"; return null; }
      replacement[index - interval.start] = { ...current[index], candidate: item.candidate,
        error: item.error, emission: item.error.total, accepted: item.error.total <= QUALITY_THRESHOLD, expressionMotion: 0 };
    }
    let objectiveDelta = 0, following: ProjectionChoice<T> | undefined;
    // Include the outgoing edge. Its candidate is unchanged, but its stored
    // expressionMotion must describe the newly selected previous photo.
    for (let index = interval.start; index <= Math.min(interval.end + 1, current.length - 1); index++) {
      const choice = replacement[index - interval.start] ?? current[index];
      const previous = replacement[index - 1 - interval.start] ?? current[index - 1];
      const measured = objective(index, choice, previous);
      currentCosts[index] ??= objective(index, current[index], current[index - 1]).cost;
      objectiveDelta += measured.cost - currentCosts[index]!;
      if (index <= interval.end) choice.expressionMotion = measured.expression;
      else if (measured.expression !== choice.expressionMotion) following = { ...choice, expressionMotion: measured.expression };
    }
    return { interval, id: match.id, replacement, following, objectiveDelta };
  };

  while (after.recentReappearances > 0) {
    if (patches.length >= limits.maxPatches) { capReasons.add("maxPatches"); break; }
    let adopted = false;
    for (const event of recentEvents(current)) {
      if (eventsInspected >= limits.maxEvents) { capReasons.add("maxEvents"); break; }
      eventsInspected++;
      const { previous, returning } = event;
      const intervals: Interval[] = [
        { kind: "bridge-gap", start: previous.end + 1, end: returning.start - 1, onlyId: returning.id },
        { kind: "replace-return", start: returning.start, end: returning.end, excludeId: returning.id },
        { kind: "replace-earlier", start: previous.start, end: previous.end, excludeId: returning.id },
      ];
      const proposals: Proposal<T>[] = [];
      for (const interval of intervals) {
        const intersection = intersect(interval);
        if (invalidReason) return finish("invalid-input", true);
        if (!intersection) continue;
        // This inexpensive emission bound orders work when the scoring cap is
        // reached. Actual proposals are compared using the complete old objective.
        const ordered = intersection.matches.map(match => ({ match,
          emission: match.items.reduce((sum, item, slot) => sum + item.error.total +
            rareActionPenalty(baseline[intersection.order[slot]].frame, item.error), 0),
        })).sort((left, right) => left.emission - right.emission || compareId(left.match.id, right.match.id));
        for (const { match } of ordered) {
          const proposal = score(interval, match, intersection.order);
          if (invalidReason) return finish("invalid-input", true);
          if (!proposal) break;
          proposals.push(proposal);
        }
      }
      proposals.sort((left, right) => left.objectiveDelta - right.objectiveDelta || compareId(left.id, right.id) ||
        left.interval.start - right.interval.start || left.interval.end - right.interval.end || compareId(left.interval.kind, right.interval.kind));
      for (const proposal of proposals) {
        if (triedPatches >= limits.maxTrials) { capReasons.add("maxTrials"); break; }
        triedPatches++;
        const trial = current.slice();
        for (let offset = 0; offset < proposal.replacement.length; offset++) trial[proposal.interval.start + offset] = proposal.replacement[offset];
        if (proposal.following) trial[proposal.interval.end + 1] = proposal.following;
        const checked = compareReviewSequences(baseline, trial, WINDOW_SECONDS);
        const lowersCurrent = checked.after.recentReappearances < after.recentReappearances;
        if (!checked.accepted || !lowersCurrent) {
          for (const reason of [...checked.reasons, ...(!lowersCurrent ? ["current-recent-reappearances"] : [])]) {
            rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
          }
          continue;
        }
        patches.push({ kind: proposal.interval.kind, start: proposal.interval.start, end: proposal.interval.end,
          candidateId: proposal.id, recentBefore: after.recentReappearances,
          recentAfter: checked.after.recentReappearances, objectiveDelta: proposal.objectiveDelta });
        current = trial; comparison = checked; after = checked.after; currentCosts = [];
        adopted = true;
        break;
      }
      if (adopted || capReasons.has("maxTrials") || capReasons.has("maxCandidatesInspected") || capReasons.has("maxScoredPatches")) break;
    }
    if (!adopted) break;
  }
  return finish(patches.length ? "quality-gates-passed" : "baseline-preserved");
}
