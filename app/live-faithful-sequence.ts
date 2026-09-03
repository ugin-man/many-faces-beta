import { FACE_ACTION_FEATURE_INDEX } from "./face-actions.ts";
import type { FaceGeometry, SequenceFrame } from "./offline-matching.ts";
import {
  BROWS,
  FACE_OVAL,
  INNER_LIPS,
  LEFT_EYE,
  NOSE,
  OUTER_LIPS,
  RIGHT_EYE,
  type ProjectionError,
} from "./projection-matching.ts";

export type FaithfulCandidate = {
  id: string;
  feature: number[];
  geometry: FaceGeometry;
};

export type FaithfulRanked<T extends FaithfulCandidate> = {
  candidate: T;
  error: ProjectionError;
};

export type FaithfulChoice<T extends FaithfulCandidate> = {
  frame: SequenceFrame;
  candidate: T;
  emission: number;
  error: ProjectionError;
  accepted: boolean;
  expressionMotion: number;
};

type PathState<T extends FaithfulCandidate> = {
  cost: number;
  history: string[];
  choice: FaithfulChoice<T>;
  previous: PathState<T> | null;
};

const COARSE_INDEXES = [...new Set([
  ...FACE_OVAL,
  ...LEFT_EYE.filter((_, index) => index % 2 === 0),
  ...RIGHT_EYE.filter((_, index) => index % 2 === 0),
  ...OUTER_LIPS.filter((_, index) => index % 2 === 0),
  ...NOSE,
  ...BROWS.filter((_, index) => index % 2 === 0),
])] as number[];
const MOUTH_INDEXES = [...new Set([...OUTER_LIPS, ...INNER_LIPS])] as number[];
const EYE_INDEXES = [...new Set([...LEFT_EYE, ...RIGHT_EYE])] as number[];
const EXPRESSION_INDEXES = [...new Set([...MOUTH_INDEXES, ...EYE_INDEXES, ...BROWS])] as number[];

const STRICT_OPTIONS = {
  cooldown: 12,
  beamWidth: 24,
  qualityThreshold: 0.055,
  residualCoherence: 0.46,
  expressionMotionWeight: 6.2,
  motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
} as const;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function featureValue(feature: ArrayLike<number>, index: number) {
  const value = Number(feature[index] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function rmsAtIndexes(left: ArrayLike<number>, right: ArrayLike<number>, indexes: readonly number[]) {
  let total = 0;
  let count = 0;
  for (const index of indexes) {
    const offset = index * 2;
    if (offset + 1 >= left.length || offset + 1 >= right.length) continue;
    const dx = Number(left[offset] ?? 0) - Number(right[offset] ?? 0);
    const dy = Number(left[offset + 1] ?? 0) - Number(right[offset + 1] ?? 0);
    total += dx * dx + dy * dy;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : 0;
}

function residualMotionAtIndexes(
  previousFrame: SequenceFrame,
  previousCandidate: FaithfulCandidate,
  currentFrame: SequenceFrame,
  currentCandidate: FaithfulCandidate,
  indexes: readonly number[],
) {
  const previousTarget = previousFrame.geometry.projection;
  const previousMatch = previousCandidate.geometry.projection;
  const currentTarget = currentFrame.geometry.projection;
  const currentMatch = currentCandidate.geometry.projection;
  let total = 0;
  let count = 0;
  for (const index of indexes) {
    const offset = index * 2;
    if (
      offset + 1 >= previousTarget.length ||
      offset + 1 >= previousMatch.length ||
      offset + 1 >= currentTarget.length ||
      offset + 1 >= currentMatch.length
    ) continue;
    const previousResidualX = Number(previousMatch[offset]) - Number(previousTarget[offset]);
    const previousResidualY = Number(previousMatch[offset + 1]) - Number(previousTarget[offset + 1]);
    const currentResidualX = Number(currentMatch[offset]) - Number(currentTarget[offset]);
    const currentResidualY = Number(currentMatch[offset + 1]) - Number(currentTarget[offset + 1]);
    total += (previousResidualX - currentResidualX) ** 2 +
      (previousResidualY - currentResidualY) ** 2;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : 0;
}

function expressionResidualMotion(
  previousFrame: SequenceFrame,
  previousCandidate: FaithfulCandidate,
  currentFrame: SequenceFrame,
  currentCandidate: FaithfulCandidate,
) {
  return residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, MOUTH_INDEXES,
  ) * STRICT_OPTIONS.motionWeights.mouth + residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, EYE_INDEXES,
  ) * STRICT_OPTIONS.motionWeights.eyes + residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, BROWS,
  ) * STRICT_OPTIONS.motionWeights.brows;
}

function sourceExpressionActivity(previousFrame: SequenceFrame, currentFrame: SequenceFrame) {
  return rmsAtIndexes(previousFrame.geometry.projection, currentFrame.geometry.projection, EXPRESSION_INDEXES);
}

function rareActionPenalty(frame: SequenceFrame, error: ProjectionError) {
  const targetPitch = Math.abs(Number(frame.feature[1] ?? 0) * 90);
  const pitchActivity = clamp01(targetPitch / 24);
  const targetWink = Math.abs(
    featureValue(frame.feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkLeft) -
    featureValue(frame.feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkRight),
  );
  const winkActivity = clamp01((targetWink - 0.14) / 0.42);
  return Math.abs(error.pitchDegrees) / 90 * (0.18 + pitchActivity * 0.72) +
    error.wink * winkActivity * 0.9;
}

export class FaithfulStrictSequence<T extends FaithfulCandidate> {
  private frames: SequenceFrame[] = [];
  private paths: PathState<T>[] = [];

  reset() {
    this.frames = [];
    this.paths = [];
  }

  push(frame: SequenceFrame, rankedBeam: FaithfulRanked<T>[]) {
    if (!rankedBeam.length) return null;
    const frameIndex = this.frames.length;
    this.frames.push(frame);

    if (frameIndex === 0) {
      this.paths = rankedBeam.slice(0, STRICT_OPTIONS.beamWidth).map(({ candidate, error }) => ({
        cost: error.total + rareActionPenalty(frame, error),
        history: [candidate.id],
        choice: {
          frame,
          candidate,
          emission: error.total,
          error,
          accepted: error.total <= STRICT_OPTIONS.qualityThreshold,
          expressionMotion: 0,
        },
        previous: null,
      }));
      return this.latestChoice();
    }

    const previousFrame = this.frames[frameIndex - 1];
    const next: PathState<T>[] = [];
    for (const path of this.paths) {
      for (const { candidate, error } of rankedBeam) {
        if (path.history.includes(candidate.id)) continue;
        const continuity = residualMotionAtIndexes(
          previousFrame,
          path.choice.candidate,
          frame,
          candidate,
          COARSE_INDEXES,
        );
        const expressionMotion = expressionResidualMotion(
          previousFrame,
          path.choice.candidate,
          frame,
          candidate,
        );
        const activity = sourceExpressionActivity(previousFrame, frame);
        const activityBoost = Math.min(1.8, activity / 0.012);
        next.push({
          cost: path.cost + error.total + rareActionPenalty(frame, error) +
            continuity * STRICT_OPTIONS.residualCoherence * 0.35 +
            expressionMotion * STRICT_OPTIONS.expressionMotionWeight * (0.45 + activityBoost),
          history: [...path.history, candidate.id].slice(-STRICT_OPTIONS.cooldown),
          choice: {
            frame,
            candidate,
            emission: error.total,
            error,
            accepted: error.total <= STRICT_OPTIONS.qualityThreshold,
            expressionMotion,
          },
          previous: path,
        });
      }
    }

    if (!next.length) {
      for (const path of this.paths) {
        for (const { candidate, error } of rankedBeam) {
          if (path.choice.candidate.id === candidate.id) continue;
          next.push({
            cost: path.cost + error.total,
            history: [candidate.id],
            choice: {
              frame,
              candidate,
              emission: error.total,
              error,
              accepted: error.total <= STRICT_OPTIONS.qualityThreshold,
              expressionMotion: 0,
            },
            previous: path,
          });
        }
      }
    }

    this.paths = next
      .sort((left, right) => left.cost - right.cost)
      .slice(0, STRICT_OPTIONS.beamWidth);
    return this.latestChoice();
  }

  latestChoice() {
    return this.paths[0]?.choice ?? null;
  }

  sequence() {
    const choices: FaithfulChoice<T>[] = [];
    let cursor: PathState<T> | null = this.paths[0] ?? null;
    while (cursor) {
      choices.push(cursor.choice);
      cursor = cursor.previous;
    }
    return choices.reverse();
  }
}
