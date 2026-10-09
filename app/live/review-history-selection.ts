import type { SequenceFrame } from "../offline-matching";
import {
  COARSE_INDEXES, expressionResidualMotion, optimizeDistinctProjectionSequence,
  rareActionPenalty, residualMotionAtIndexes, sourceExpressionActivity,
  type ProjectionCandidate, type ProjectionChoice, type ProjectionError,
  type ProjectionSequenceOptions,
} from "../projection-matching.ts";

/** The existing video policy. Camera and realtime callers do not use this module. */
export const REVIEW_SEQUENCE_OPTIONS: ProjectionSequenceOptions = {
  allowRepeats: true, cooldown: 12, beamWidth: 24, qualityThreshold: 0.055,
  residualCoherence: 0.46, expressionMotionWeight: 6.2,
  motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
};

export type HistorySelectionOptions = {
  weight: number;
  windowSeconds: number;
  halfLifeSeconds: number;
  historiesPerCandidate: number;
};

/** Fixed before evaluating the reference; all times refer to the input video. */
export const REVIEW_HISTORY_OPTIONS: Readonly<HistorySelectionOptions> = Object.freeze({
  weight: 0.003, windowSeconds: 2, halfLifeSeconds: 0.75, historiesPerCandidate: 2,
});

type Ranked<T extends ProjectionCandidate> = { candidate: T; error: ProjectionError };
type Departures = ReadonlyMap<string, number>;
type HistoryPath<T extends ProjectionCandidate> = {
  cost: number;
  departures: Departures;
  choice: ProjectionChoice<T>;
  previous: HistoryPath<T> | null;
};
type Proposal<T extends ProjectionCandidate> = {
  cost: number; previous: HistoryPath<T>; item: Ranked<T>; expressionMotion: number;
};

/** Continuing the current photo and first use have no history cost. */
export function reappearancePenalty(
  currentId: string, nextId: string, time: number,
  departures: Departures, options: HistorySelectionOptions,
) {
  if (currentId === nextId || !(options.weight > 0)) return 0;
  const departed = departures.get(nextId);
  if (departed === undefined) return 0;
  const elapsed = time - departed;
  if (elapsed < 0 || time >= departed + options.windowSeconds) return 0;
  return options.weight * 2 ** (-elapsed / options.halfLifeSeconds);
}

function nextDepartures(
  previous: Departures, previousId: string, currentId: string,
  time: number, windowSeconds: number,
): Departures {
  const result = new Map<string, number>();
  for (const [id, departed] of previous) {
    if (id !== currentId && time < departed + windowSeconds) result.set(id, departed);
  }
  // The old photo remains displayed until the first sample of the new run.
  if (previousId !== currentId) result.set(previousId, time);
  return result;
}

function historySignature(departures: Departures) {
  return JSON.stringify([...departures].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function validHistoryInput(frames: SequenceFrame[], options: HistorySelectionOptions) {
  return Number.isFinite(options.weight) && options.weight > 0 &&
    Number.isFinite(options.windowSeconds) && options.windowSeconds > 0 && options.windowSeconds <= 10 &&
    Number.isFinite(options.halfLifeSeconds) && options.halfLifeSeconds > 0 &&
    Number.isInteger(options.historiesPerCandidate) && options.historiesPerCandidate >= 1 && options.historiesPerCandidate <= 2 &&
    frames.every((frame, index) => Number.isFinite(frame.time) && frame.time >= 0 &&
      (index === 0 || frame.time > frames[index - 1].time));
}

/**
 * Finite beam search with stateful, bounded re-entry costs. Keeps the existing
 * 24 distinct endings before admitting one extra history for each ending.
 * This is approximate search, not a claim of a globally optimal sequence.
 */
export function optimizeHistoryAwareProjectionSequence<T extends ProjectionCandidate>(
  frames: SequenceFrame[], beams: Ranked<T>[][],
  history: HistorySelectionOptions = REVIEW_HISTORY_OPTIONS,
  policy: ProjectionSequenceOptions = REVIEW_SEQUENCE_OPTIONS,
): ProjectionChoice<T>[] {
  // Preserve every tie and floating-point operation of the original zero-cost path.
  if (!policy.allowRepeats || !validHistoryInput(frames, history)) {
    return optimizeDistinctProjectionSequence(frames, beams, policy);
  }
  if (!frames.length || frames.length !== beams.length || beams.some(beam => !beam.length)) return [];
  const beamWidth = Math.max(2, Math.min(48, policy.beamWidth ?? 20));
  const threshold = Math.max(0.005, policy.qualityThreshold ?? 0.055);
  const coherence = Math.max(0, Math.min(3, policy.residualCoherence ?? 0.65));
  const motionWeight = Math.max(0, Math.min(12, policy.expressionMotionWeight ?? 4.2));
  const weights = policy.motionWeights ?? { mouth: 0.5, eyes: 0.3, brows: 0.2 };
  const weightTotal = Math.max(0.001, weights.mouth + weights.eyes + weights.brows);
  const normalized = { mouth: weights.mouth / weightTotal, eyes: weights.eyes / weightTotal, brows: weights.brows / weightTotal };
  let paths: HistoryPath<T>[] = beams[0].slice(0, beamWidth).map(({ candidate, error }) => ({
    cost: error.total + rareActionPenalty(frames[0], error), departures: new Map(), previous: null,
    choice: { frame: frames[0], candidate, emission: error.total, error, accepted: error.total <= threshold, expressionMotion: 0 },
  }));

  for (let frameIndex = 1; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex], previousFrame = frames[frameIndex - 1];
    const activityBoost = Math.min(1.8, sourceExpressionActivity(previousFrame, frame) / 0.012);
    const transitions = new Map<T, Map<T, { continuity: number; expressionMotion: number }>>();
    const proposals: Proposal<T>[] = [];
    const rarePenalties = beams[frameIndex].map(item => rareActionPenalty(frame, item.error));
    for (const path of paths) {
      let from = transitions.get(path.choice.candidate);
      if (!from) { from = new Map(); transitions.set(path.choice.candidate, from); }
      for (let index = 0; index < beams[frameIndex].length; index++) {
        const item = beams[frameIndex][index];
        let transition = from.get(item.candidate);
        if (!transition) {
          transition = {
            continuity: residualMotionAtIndexes(previousFrame, path.choice.candidate, frame, item.candidate, COARSE_INDEXES),
            expressionMotion: expressionResidualMotion(previousFrame, path.choice.candidate, frame, item.candidate, normalized),
          };
          from.set(item.candidate, transition);
        }
        const penalty = reappearancePenalty(path.choice.candidate.id, item.candidate.id, frame.time, path.departures, history);
        proposals.push({
          cost: path.cost + item.error.total + rarePenalties[index] +
            transition.continuity * coherence * 0.35 +
            transition.expressionMotion * motionWeight * (0.45 + activityBoost) + penalty,
          previous: path, item, expressionMotion: transition.expressionMotion,
        });
      }
    }
    proposals.sort((left, right) => left.cost - right.cost);
    const endings = new Map<string, Proposal<T>[]>();
    for (const proposal of proposals) {
      const id = proposal.item.candidate.id;
      if (!endings.has(id) && endings.size < beamWidth) endings.set(id, []);
      endings.get(id)?.push(proposal);
    }
    const selected: HistoryPath<T>[] = [];
    for (const sameEnding of endings.values()) {
      const signatures = new Set<string>();
      for (const proposal of sameEnding) {
        const { candidate, error } = proposal.item;
        const departures = nextDepartures(proposal.previous.departures, proposal.previous.choice.candidate.id, candidate.id, frame.time, history.windowSeconds);
        const signature = historySignature(departures);
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        selected.push({
          cost: proposal.cost, departures, previous: proposal.previous,
          choice: { frame, candidate, error, emission: error.total, accepted: error.total <= threshold, expressionMotion: proposal.expressionMotion },
        });
        if (signatures.size >= history.historiesPerCandidate) break;
      }
    }
    paths = selected.sort((left, right) => left.cost - right.cost);
    if (!paths.length) return [];
  }
  const choices: ProjectionChoice<T>[] = [];
  let path: HistoryPath<T> | null = paths[0] ?? null;
  while (path) { choices.push(path.choice); path = path.previous; }
  return choices.reverse();
}

export function distribution(values: number[]) {
  if (!values.length) return { mean: 0, p95: 0, max: 0 };
  const ordered = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)], max: ordered[ordered.length - 1] };
}

export function measureReviewSequence<T extends ProjectionCandidate>(choices: ProjectionChoice<T>[], windowSeconds = 2) {
  const seen = new Set<string>(), departed = new Map<string, number>();
  let switches = 0, reappearances = 0, recentReappearances = 0, shortCompletedRuns = 0;
  let singleSampleRuns = 0, runSamples = 0, runStart = choices[0]?.frame.time ?? 0;
  const reentryEvents: { index: number; time: number; id: string; gapSeconds: number | null }[] = [];
  const continuity: number[] = [], expressionMotion: number[] = [], poseMotionResidual: number[] = [];
  const oldObjective: number[] = [];
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index], previous = choices[index - 1];
    let residual = 0, expression = 0, activityBoost = 0;
    if (previous) {
      residual = residualMotionAtIndexes(previous.frame, previous.candidate, choice.frame, choice.candidate, COARSE_INDEXES);
      expression = expressionResidualMotion(previous.frame, previous.candidate, choice.frame, choice.candidate, { mouth: 0.43, eyes: 0.39, brows: 0.18 });
      activityBoost = Math.min(1.8, sourceExpressionActivity(previous.frame, choice.frame) / 0.012);
      continuity.push(residual); expressionMotion.push(expression);
      poseMotionResidual.push(Math.hypot(...[0, 1, 2].map(axis =>
        ((choice.candidate.feature[axis] - previous.candidate.feature[axis]) -
        (choice.frame.feature[axis] - previous.frame.feature[axis])) * 90)));
    }
    oldObjective.push(choice.error.total + rareActionPenalty(choice.frame, choice.error) +
      residual * 0.46 * 0.35 + expression * 6.2 * (0.45 + activityBoost));
    if (!previous || previous.candidate.id !== choice.candidate.id) {
      if (previous) {
        switches++; departed.set(previous.candidate.id, choice.frame.time);
        if (choice.frame.time - runStart < 0.1 - 1e-9) shortCompletedRuns++;
        if (runSamples === 1) singleSampleRuns++;
      }
      runStart = choice.frame.time;
      runSamples = 0;
      if (seen.has(choice.candidate.id)) {
        reappearances++;
        const ended = departed.get(choice.candidate.id);
        const gap = ended === undefined ? null : choice.frame.time - ended;
        if (gap !== null && gap >= 0 && choice.frame.time < ended! + windowSeconds) recentReappearances++;
        reentryEvents.push({ index, time: choice.frame.time, id: choice.candidate.id, gapSeconds: gap });
      }
      seen.add(choice.candidate.id);
    }
    runSamples++;
  }
  if (runSamples === 1) singleSampleRuns++;
  const error = (key: keyof ProjectionError) => distribution(choices.map(choice => Math.abs(choice.error[key])));
  return {
    frames: choices.length, uniqueImages: seen.size, runs: choices.length ? switches + 1 : 0,
    switches, reappearances, recentReappearances, shortCompletedRuns, singleSampleRuns, reentryEvents,
    error: error("total"), worstLocal: error("worstLocal"), mouth: error("mouth"), eyes: error("eyes"),
    brows: error("brows"), wink: error("wink"), poseDegrees: error("poseDegrees"),
    yawDegrees: error("yawDegrees"), pitchDegrees: error("pitchDegrees"),
    accepted: choices.filter(choice => choice.accepted).length,
    continuity: distribution(continuity), expressionMotion: distribution(expressionMotion),
    poseMotionResidual: distribution(poseMotionResidual), objectiveWithoutHistory: distribution(oldObjective),
  };
}

/**
 * Small explicit experimental budgets, shared by offline adoption and per-video
 * fallback. Novelty never overrides a failed fidelity/continuity guard.
 */
export const REVIEW_HISTORY_QUALITY_BUDGET = Object.freeze({
  meanRelative: 0.0025, p95Relative: 0.005, maximumFrameErrorIncrease: 0.003,
  maximumLocalErrorIncrease: 0.003, maximumPoseIncreaseDegrees: 0.5,
  motionMeanRelative: 0.005, motionP95Relative: 0.01,
});

export function compareReviewSequences<T extends ProjectionCandidate>(
  baseline: ProjectionChoice<T>[], candidate: ProjectionChoice<T>[], windowSeconds = 2,
) {
  const before = measureReviewSequence(baseline, windowSeconds), after = measureReviewSequence(candidate, windowSeconds);
  const budget = REVIEW_HISTORY_QUALITY_BUDGET, reasons: string[] = [];
  const check = (condition: boolean, reason: string) => { if (!condition) reasons.push(reason); };
  const within = (value: number, reference: number, relative: number) => Number.isFinite(value) && value <= reference * (1 + relative) + 1e-10;
  check(candidate.length === baseline.length && candidate.every((choice, index) => choice.frame.time === baseline[index]?.frame.time), "frame-coverage");
  check(after.recentReappearances < before.recentReappearances, "recent-reappearances");
  check(after.reappearances <= before.reappearances, "all-reappearances");
  check(after.switches <= before.switches, "switch-count");
  check(after.shortCompletedRuns <= before.shortCompletedRuns, "short-completed-runs");
  check(after.singleSampleRuns <= before.singleSampleRuns, "single-sample-runs");
  check(after.accepted >= before.accepted, "accepted-frames");
  for (const key of ["error", "worstLocal", "mouth", "eyes", "brows", "wink", "poseDegrees", "objectiveWithoutHistory"] as const) {
    check(within(after[key].mean, before[key].mean, budget.meanRelative), `${key}-mean`);
    check(within(after[key].p95, before[key].p95, budget.p95Relative), `${key}-p95`);
    check(within(after[key].max, before[key].max, budget.p95Relative), `${key}-max`);
  }
  for (const key of ["continuity", "expressionMotion", "poseMotionResidual"] as const) {
    check(within(after[key].mean, before[key].mean, budget.motionMeanRelative), `${key}-mean`);
    check(within(after[key].p95, before[key].p95, budget.motionP95Relative), `${key}-p95`);
    check(within(after[key].max, before[key].max, budget.motionP95Relative), `${key}-max`);
  }
  let maximumFrameErrorIncrease = 0, maximumLocalErrorIncrease = 0, maximumPoseIncreaseDegrees = 0;
  if (candidate.length === baseline.length) {
    candidate.forEach((choice, index) => {
      maximumFrameErrorIncrease = Math.max(maximumFrameErrorIncrease, choice.error.total - baseline[index].error.total);
      maximumLocalErrorIncrease = Math.max(maximumLocalErrorIncrease, ...(["mouth", "mouthShape", "eyes", "leftEye", "rightEye", "brows", "wink", "blink", "worstLocal"] as const).map(key => choice.error[key] - baseline[index].error[key]));
      maximumPoseIncreaseDegrees = Math.max(maximumPoseIncreaseDegrees, ...(["yawDegrees", "pitchDegrees", "rollDegrees"] as const).map(key => Math.abs(choice.error[key]) - Math.abs(baseline[index].error[key])));
    });
  }
  check(maximumFrameErrorIncrease <= budget.maximumFrameErrorIncrease, "per-frame-error");
  check(maximumLocalErrorIncrease <= budget.maximumLocalErrorIncrease, "per-frame-local-error");
  check(maximumPoseIncreaseDegrees <= budget.maximumPoseIncreaseDegrees, "per-frame-pose");
  return { accepted: reasons.length === 0, reasons, before, after,
    maximumFrameErrorIncrease, maximumLocalErrorIncrease, maximumPoseIncreaseDegrees, budget };
}

/** Each video starts with empty history; a rejected trial returns the exact original array. */
export function selectHistoryAwareReviewSequence<T extends ProjectionCandidate>(
  frames: SequenceFrame[], beams: Ranked<T>[][], history: HistorySelectionOptions = REVIEW_HISTORY_OPTIONS,
) {
  const started = performance.now();
  const baseline = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
  const baselineMs = performance.now() - started;
  if (!validHistoryInput(frames, history)) return { choices: baseline, diagnostics: { adopted: false, reason: "disabled-or-invalid-input", baselineMs, historyMs: 0, comparison: null } };
  const historyStarted = performance.now();
  const trial = optimizeHistoryAwareProjectionSequence(frames, beams, history);
  const historyMs = performance.now() - historyStarted;
  const comparison = compareReviewSequences(baseline, trial, history.windowSeconds);
  return { choices: comparison.accepted ? trial : baseline, diagnostics: {
    adopted: comparison.accepted, reason: comparison.accepted ? "quality-gates-passed" : "baseline-preserved",
    baselineMs, historyMs, comparison,
  } };
}
