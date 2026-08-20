import type {
  FaceGeometry,
  NumericVector,
  SequenceChoice,
  SequenceFrame,
} from "./offline-matching";
import { FACE_ACTION_FEATURE_INDEX, FACE_ACTION_KEYS } from "./face-actions.ts";

export type ProjectionCandidate = {
  id: string;
  feature: number[];
  geometry: FaceGeometry;
};

export type ProjectionError = {
  total: number;
  balancedTotal: number;
  expressionTotal: number;
  strictTotal: number;
  semanticTotal: number;
  eyeBrowTotal: number;
  mouthTotal: number;
  contour: number;
  features: number;
  mouth: number;
  eyes: number;
  leftEye: number;
  rightEye: number;
  brows: number;
  expression: number;
  descriptor: number;
  blendshape: number;
  mouthDescriptor: number;
  mouthShape: number;
  mouthAction: number;
  eyeDescriptor: number;
  browDescriptor: number;
  shapeGate: number;
  worstLocal: number;
  poseDegrees: number;
  yawDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
  wink: number;
  blink: number;
};

export type ProjectionChoice<T extends ProjectionCandidate> = SequenceChoice<T> & {
  error: ProjectionError;
  accepted: boolean;
  expressionMotion: number;
};

export type ProjectionSequenceOptions = {
  cooldown?: number;
  beamWidth?: number;
  qualityThreshold?: number;
  residualCoherence?: number;
  expressionMotionWeight?: number;
  motionWeights?: {
    mouth: number;
    eyes: number;
    brows: number;
  };
};

export const PROJECTION_RANK_MODES = [
  "strict",
  "semantic",
  "expression",
  "eyes",
  "mouth",
  "balanced",
] as const;

export type ProjectionRankMode = typeof PROJECTION_RANK_MODES[number];

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;

export const LEFT_EYE = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
] as const;

export const RIGHT_EYE = [
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
] as const;

export const OUTER_LIPS = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308,
  324, 318, 402, 317, 14, 87, 178, 88, 95, 78,
] as const;

export const INNER_LIPS = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324,
  318, 402, 317, 14, 87, 178, 88, 95,
] as const;

export const NOSE = [
  168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 97, 99, 126, 327, 326, 328, 355,
] as const;

export const BROWS = [
  46, 53, 52, 65, 55, 70, 63, 105, 66, 107,
  276, 283, 282, 295, 285, 300, 293, 334, 296, 336,
] as const;

const FEATURE_INDEXES = [...new Set([
  ...LEFT_EYE, ...RIGHT_EYE, ...OUTER_LIPS, ...INNER_LIPS, ...NOSE, ...BROWS,
])] as number[];

const MOUTH_INDEXES = [...new Set([...OUTER_LIPS, ...INNER_LIPS])] as number[];
const EYE_INDEXES = [...new Set([...LEFT_EYE, ...RIGHT_EYE])] as number[];
const EXPRESSION_INDEXES = [...new Set([
  ...MOUTH_INDEXES, ...EYE_INDEXES, ...BROWS,
])] as number[];

const COARSE_INDEXES = [...new Set([
  ...FACE_OVAL,
  ...LEFT_EYE.filter((_, index) => index % 2 === 0),
  ...RIGHT_EYE.filter((_, index) => index % 2 === 0),
  ...OUTER_LIPS.filter((_, index) => index % 2 === 0),
  ...NOSE,
  ...BROWS.filter((_, index) => index % 2 === 0),
])] as number[];

const FAST_COARSE_INDEXES = [...new Set([
  ...FACE_OVAL.filter((_, index) => index % 2 === 0),
  ...LEFT_EYE.filter((_, index) => index % 3 === 0),
  ...RIGHT_EYE.filter((_, index) => index % 3 === 0),
  ...OUTER_LIPS.filter((_, index) => index % 3 === 0),
  ...NOSE.filter((_, index) => index % 3 === 0),
  ...BROWS.filter((_, index) => index % 3 === 0),
])] as number[];

function pointDistanceSquared(left: NumericVector, right: NumericVector, index: number) {
  const offset = index * 2;
  const dx = Number(left[offset] ?? 0) - Number(right[offset] ?? 0);
  const dy = Number(left[offset + 1] ?? 0) - Number(right[offset + 1] ?? 0);
  return dx * dx + dy * dy;
}

function rmsAtIndexes(left: NumericVector, right: NumericVector, indexes: readonly number[]) {
  if (!indexes.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  let count = 0;
  for (const index of indexes) {
    if (index * 2 + 1 >= left.length || index * 2 + 1 >= right.length) continue;
    total += pointDistanceSquared(left, right, index);
    count += 1;
  }
  return count ? Math.sqrt(total / count) : Number.POSITIVE_INFINITY;
}

function landmarkDistance(vector: NumericVector, left: number, right: number) {
  const leftOffset = left * 2;
  const rightOffset = right * 2;
  return Math.hypot(
    Number(vector[leftOffset] ?? 0) - Number(vector[rightOffset] ?? 0),
    Number(vector[leftOffset + 1] ?? 0) - Number(vector[rightOffset + 1] ?? 0),
  );
}

function yAt(vector: NumericVector, index: number) {
  return Number(vector[index * 2 + 1] ?? 0);
}

function expressionDescriptor(vector: NumericVector) {
  const mouthWidth = Math.max(0.05, landmarkDistance(vector, 61, 291));
  const leftEyeWidth = Math.max(0.05, landmarkDistance(vector, 33, 133));
  const rightEyeWidth = Math.max(0.05, landmarkDistance(vector, 362, 263));
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  return [
    landmarkDistance(vector, 13, 14) / mouthWidth,
    landmarkDistance(vector, 82, 87) / mouthWidth,
    mouthWidth,
    (mouthCenterY - mouthCornerY) / mouthWidth,
    landmarkDistance(vector, 159, 145) / leftEyeWidth,
    landmarkDistance(vector, 386, 374) / rightEyeWidth,
    landmarkDistance(vector, 105, 159) / leftEyeWidth,
    landmarkDistance(vector, 334, 386) / rightEyeWidth,
  ];
}

/**
 * A phoneme-sensitive description of the lips. Raw mouth RMS is useful, but it
 * averages away the differences between a wide /i,e/, an open /a/, and a
 * rounded /u,o/. These ratios keep those differences visible after eye-based
 * face normalization.
 */
export function mouthShapeDescriptor(vector: NumericVector) {
  const outerWidth = Math.max(0.04, landmarkDistance(vector, 61, 291));
  const innerWidth = Math.max(0.025, landmarkDistance(vector, 78, 308));
  const outerHeight = landmarkDistance(vector, 0, 17);
  const innerHeight = landmarkDistance(vector, 13, 14);
  const leftInnerHeight = landmarkDistance(vector, 82, 87);
  const rightInnerHeight = landmarkDistance(vector, 312, 317);
  const mouthCenterY = (yAt(vector, 13) + yAt(vector, 14)) / 2;
  const mouthCornerY = (yAt(vector, 61) + yAt(vector, 291)) / 2;
  return [
    outerWidth,
    outerHeight / outerWidth,
    innerHeight / outerWidth,
    innerWidth / outerWidth,
    innerHeight / innerWidth,
    (mouthCenterY - mouthCornerY) / outerWidth,
    leftInnerHeight / outerWidth,
    rightInnerHeight / outerWidth,
  ];
}

function mouthShapeGeometryDistance(left: NumericVector, right: NumericVector) {
  const a = mouthShapeDescriptor(left);
  const b = mouthShapeDescriptor(right);
  // Aperture and roundness carry the vowel; absolute width and corner height
  // keep a naturally narrow mouth from masquerading as a puckered one.
  const weights = [2.2, 2.8, 4.2, 1.8, 4.4, 1.5, 2.2, 2.2];
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] - b[index]) ** 2 * weights[index];
    weightTotal += weights[index];
  }
  return Math.sqrt(total / weightTotal);
}

function descriptorDistance(left: NumericVector, right: NumericVector) {
  const a = expressionDescriptor(left);
  const b = expressionDescriptor(right);
  const weights = [2.6, 1.8, 0.7, 2.4, 1.5, 1.5, 0.7, 0.7];
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] - b[index]) ** 2 * weights[index];
    weightTotal += weights[index];
  }
  return Math.sqrt(total / weightTotal);
}

function descriptorSliceDistance(
  left: NumericVector,
  right: NumericVector,
  indexes: readonly number[],
  weights: readonly number[],
) {
  const a = expressionDescriptor(left);
  const b = expressionDescriptor(right);
  let total = 0;
  let weightTotal = 0;
  indexes.forEach((descriptorIndex, index) => {
    const weight = weights[index] ?? 1;
    total += (a[descriptorIndex] - b[descriptorIndex]) ** 2 * weight;
    weightTotal += weight;
  });
  return weightTotal ? Math.sqrt(total / weightTotal) : 0;
}

function blendshapeExpressionDistance(left: number[], right: number[]) {
  const importantWeights: Partial<Record<typeof FACE_ACTION_KEYS[number], number>> = {
    jawOpen: 2.8,
    mouthClose: 0.5,
    mouthFunnel: 0.9,
    mouthPucker: 1,
    mouthSmileLeft: 3.1,
    mouthSmileRight: 3.1,
    mouthFrownLeft: 1.4,
    mouthFrownRight: 1.4,
    mouthStretchLeft: 0.8,
    mouthStretchRight: 0.8,
    eyeBlinkLeft: 2.7,
    eyeBlinkRight: 2.7,
    eyeSquintLeft: 1.1,
    eyeSquintRight: 1.1,
    eyeWideLeft: 2.2,
    eyeWideRight: 2.2,
    eyeLookUpLeft: 1.35,
    eyeLookUpRight: 1.35,
    eyeLookDownLeft: 1.35,
    eyeLookDownRight: 1.35,
    browInnerUp: 1.35,
    browDownLeft: 1,
    browDownRight: 1,
    browOuterUpLeft: 1,
    browOuterUpRight: 1,
    noseSneerLeft: 0.85,
    noseSneerRight: 0.85,
  };
  let total = 0;
  let weightTotal = 0;
  for (const key of FACE_ACTION_KEYS) {
    if (key === "_neutral") continue;
    const weight = importantWeights[key] ?? 0.35;
    const index = FACE_ACTION_FEATURE_INDEX[key];
    const delta = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    total += delta * delta * weight;
    weightTotal += weight;
  }
  return Math.sqrt(total / weightTotal);
}

const MOUTH_ACTION_WEIGHTS: Partial<Record<typeof FACE_ACTION_KEYS[number], number>> = {
  jawOpen: 3.2,
  mouthClose: 1.1,
  mouthFunnel: 4.6,
  mouthPucker: 4.8,
  mouthSmileLeft: 1.3,
  mouthSmileRight: 1.3,
  mouthFrownLeft: 1,
  mouthFrownRight: 1,
  mouthStretchLeft: 3.2,
  mouthStretchRight: 3.2,
  mouthDimpleLeft: 1.1,
  mouthDimpleRight: 1.1,
  mouthLeft: 0.8,
  mouthRight: 0.8,
  mouthLowerDownLeft: 1.5,
  mouthLowerDownRight: 1.5,
  mouthPressLeft: 0.8,
  mouthPressRight: 0.8,
  mouthRollLower: 1.2,
  mouthRollUpper: 1.2,
  mouthShrugLower: 1,
  mouthShrugUpper: 1,
  mouthUpperUpLeft: 1.5,
  mouthUpperUpRight: 1.5,
};

function mouthActionDistance(left: number[], right: number[]) {
  let total = 0;
  let weightTotal = 0;
  for (const [key, weight] of Object.entries(MOUTH_ACTION_WEIGHTS)) {
    const index = FACE_ACTION_FEATURE_INDEX[key as keyof typeof FACE_ACTION_FEATURE_INDEX];
    const delta = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    total += delta * delta * Number(weight);
    weightTotal += Number(weight);
  }
  return weightTotal ? Math.sqrt(total / weightTotal) : 0;
}

function featureValue(feature: number[], index: number) {
  return Math.max(0, Math.min(1, Number(feature[index] ?? 0)));
}

function eyeActionDistance(left: number[], right: number[]) {
  const leftBlinkIndex = FACE_ACTION_FEATURE_INDEX.eyeBlinkLeft;
  const rightBlinkIndex = FACE_ACTION_FEATURE_INDEX.eyeBlinkRight;
  const leftBlinkDelta = Math.abs(featureValue(left, leftBlinkIndex) - featureValue(right, leftBlinkIndex));
  const rightBlinkDelta = Math.abs(featureValue(left, rightBlinkIndex) - featureValue(right, rightBlinkIndex));
  const targetWink = featureValue(left, leftBlinkIndex) - featureValue(left, rightBlinkIndex);
  const candidateWink = featureValue(right, leftBlinkIndex) - featureValue(right, rightBlinkIndex);
  return {
    blink: Math.max(leftBlinkDelta, rightBlinkDelta),
    wink: Math.abs(targetWink - candidateWink),
    winkActivity: clamp01((Math.abs(targetWink) - 0.14) / 0.42),
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function projectionError(
  frame: SequenceFrame,
  candidate: ProjectionCandidate,
): ProjectionError {
  const left = frame.geometry.projection;
  const right = candidate.geometry.projection;
  const contour = rmsAtIndexes(left, right, FACE_OVAL);
  const balancedFeatures = rmsAtIndexes(left, right, FEATURE_INDEXES);
  const mouth = rmsAtIndexes(left, right, MOUTH_INDEXES);
  const leftEye = rmsAtIndexes(left, right, LEFT_EYE);
  const rightEye = rmsAtIndexes(left, right, RIGHT_EYE);
  // A mean over both eyes hides a wink. Preserve the worse side as a visible error.
  const eyes = Math.max(leftEye, rightEye);
  const brows = rmsAtIndexes(left, right, BROWS);
  const nose = rmsAtIndexes(left, right, NOSE);
  const features = mouth * 0.56 + eyes * 0.27 + brows * 0.17;
  const descriptor = descriptorDistance(left, right);
  const mouthDescriptor = descriptorSliceDistance(left, right, [0, 1, 2, 3], [2.6, 1.8, 0.7, 2.4]);
  const mouthAction = mouthActionDistance(frame.feature, candidate.feature);
  const mouthShape = mouthShapeGeometryDistance(left, right) * 0.62 + mouthAction * 0.38;
  const eyeDescriptor = descriptorSliceDistance(left, right, [4, 5], [1.5, 1.5]);
  const browDescriptor = descriptorSliceDistance(left, right, [6, 7], [1, 1]);
  const blendshape = blendshapeExpressionDistance(frame.feature, candidate.feature);
  const eyeAction = eyeActionDistance(frame.feature, candidate.feature);
  const expression = descriptor * 0.78 + blendshape * 0.22;
  const surface = rmsAtIndexes(left, right, COARSE_INDEXES);
  const yaw = (Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90;
  const pitch = (Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90;
  const roll = (Number(frame.feature[2] ?? 0) - Number(candidate.feature[2] ?? 0)) * 90;
  const poseDegrees = Math.hypot(yaw, pitch, roll * 0.35);
  const poseUnit = poseDegrees / 90;
  const pitchUnit = Math.abs(pitch) / 90;
  const shapeGate = contour * 0.62 + nose * 0.2 + poseUnit * 0.08 + pitchUnit * 0.1;
  const balancedTotal = contour * 0.46 + balancedFeatures * 0.42 + surface * 0.12 +
    poseUnit * 0.025 + pitchUnit * 0.035;
  const expressionTotal = contour * 0.2 + nose * 0.07 + mouth * 0.21 +
    mouthShape * 0.25 + eyes * 0.08 + brows * 0.05 + expression * 0.08 +
    poseUnit * 0.02 + pitchUnit * 0.04 +
    eyeAction.wink * (0.08 + eyeAction.winkActivity * 0.22);
  const worstLocal = Math.max(
    mouth * 1.15,
    leftEye * 1.6,
    rightEye * 1.6,
    brows * 1.2,
    mouthDescriptor * 0.48,
    mouthShape * 0.95,
    eyeDescriptor * 0.52,
    browDescriptor * 0.4,
    blendshape * 0.16,
    eyeAction.blink * 0.42,
    eyeAction.wink * (0.42 + eyeAction.winkActivity * 0.58),
  );
  // Minimax prevents an excellent contour from hiding one visibly wrong feature.
  const strictTotal = shapeGate * 0.23 + worstLocal * 0.54 +
    (mouth + eyes + brows) / 3 * 0.08 + pitchUnit * 0.15 +
    eyeAction.wink * (0.12 + eyeAction.winkActivity * 0.48);
  // Blendshapes help separate naturally narrow eyes/upturned mouths from an action.
  const semanticTotal = shapeGate * 0.31 + blendshape * 0.25 +
    descriptor * 0.14 + (mouth + eyes + brows) / 3 * 0.08 + pitchUnit * 0.06 +
    eyeAction.wink * (0.08 + eyeAction.winkActivity * 0.24);
  const eyeBrowTotal = shapeGate * 0.26 + eyes * 0.13 + brows * 0.1 +
    eyeDescriptor * 0.09 + browDescriptor * 0.05 + blendshape * 0.02 +
    pitchUnit * 0.05 + eyeAction.blink * 0.08 +
    eyeAction.wink * (0.12 + eyeAction.winkActivity * 0.36);
  const mouthTotal = shapeGate * 0.28 + mouth * 0.2 + mouthDescriptor * 0.18 +
    mouthShape * 0.28 + blendshape * 0.03 + eyes * 0.03;
  return {
    contour,
    features,
    mouth,
    eyes,
    leftEye,
    rightEye,
    brows,
    expression,
    descriptor,
    blendshape,
    mouthDescriptor,
    mouthShape,
    mouthAction,
    eyeDescriptor,
    browDescriptor,
    shapeGate,
    worstLocal,
    poseDegrees,
    yawDegrees: yaw,
    pitchDegrees: pitch,
    rollDegrees: roll,
    wink: eyeAction.wink,
    blink: eyeAction.blink,
    balancedTotal,
    expressionTotal,
    strictTotal,
    semanticTotal,
    eyeBrowTotal,
    mouthTotal,
    total: strictTotal,
  };
}

export function coarseProjectionDistance(
  frame: SequenceFrame,
  candidate: ProjectionCandidate,
) {
  return rmsAtIndexes(frame.geometry.projection, candidate.geometry.projection, COARSE_INDEXES);
}

function fastActionDistance(left: number[], right: number[]) {
  const keys = [
    "jawOpen",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "mouthFunnel",
    "mouthPucker",
    "mouthStretchLeft",
    "mouthStretchRight",
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "eyeWideLeft",
    "eyeWideRight",
    "browInnerUp",
    "browDownLeft",
    "browDownRight",
  ] as const;
  let total = 0;
  for (const key of keys) {
    const index = FACE_ACTION_FEATURE_INDEX[key];
    const delta = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total / keys.length);
}

function quickProjectionMeasures(frame: SequenceFrame, candidate: ProjectionCandidate) {
  const projection = rmsAtIndexes(
    frame.geometry.projection,
    candidate.geometry.projection,
    FAST_COARSE_INDEXES,
  );
  const yaw = Math.abs(Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0));
  const pitch = Math.abs(Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0));
  const roll = Math.abs(Number(frame.feature[2] ?? 0) - Number(candidate.feature[2] ?? 0));
  const pose = yaw * 0.8 + pitch * 1.15 + roll * 0.15;
  const action = fastActionDistance(frame.feature, candidate.feature);
  const mouthShape = mouthShapeGeometryDistance(
    frame.geometry.projection,
    candidate.geometry.projection,
  ) * 0.62 + mouthActionDistance(frame.feature, candidate.feature) * 0.38;
  const eyeAction = eyeActionDistance(frame.feature, candidate.feature);
  return {
    score: projection * 0.55 + pose * 0.12 + action * 0.15 +
      mouthShape * 0.18 + eyeAction.wink * 0.12,
    pose,
    action: action + eyeAction.wink * 0.75,
    mouth: mouthShape,
  };
}

function scoreForMode(error: ProjectionError, mode: ProjectionRankMode) {
  switch (mode) {
    case "strict": return error.strictTotal;
    case "semantic": return error.semanticTotal;
    case "expression": return error.expressionTotal;
    case "eyes": return error.eyeBrowTotal;
    case "mouth": return error.mouthTotal;
    case "balanced": return error.balancedTotal;
  }
}

type RankedProjectionCandidate<T extends ProjectionCandidate> = {
  candidate: T;
  error: ProjectionError;
};

export function rankProjectionCandidateModes<T extends ProjectionCandidate>(
  frame: SequenceFrame,
  candidates: T[],
  limit = 48,
) {
  const measured = candidates.map((candidate) => ({
    candidate,
    error: projectionError(frame, candidate),
  }));
  const gateLimit = Math.max(limit, Math.min(candidates.length, limit * 20));
  const shapePool = [...measured]
    .sort((left, right) => left.error.shapeGate - right.error.shapeGate)
    .slice(0, gateLimit);
  // Extreme vertical poses and one-eye actions are rare. Always admit their best
  // global matches into the detailed pool instead of letting the contour gate hide them.
  const sourceWink = Math.abs(
    featureValue(frame.feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkLeft) -
    featureValue(frame.feature, FACE_ACTION_FEATURE_INDEX.eyeBlinkRight),
  );
  const specialistLimit = Math.min(candidates.length, Math.max(limit * 4, 128));
  const specialists = [
    ...[...measured]
      .sort((left, right) => Math.abs(left.error.pitchDegrees) - Math.abs(right.error.pitchDegrees))
      .slice(0, specialistLimit),
    ...[...measured]
      .sort((left, right) => left.error.mouthShape - right.error.mouthShape)
      .slice(0, specialistLimit),
    ...(sourceWink > 0.14
      ? [...measured].sort((left, right) => left.error.wink - right.error.wink).slice(0, specialistLimit)
      : []),
  ];
  const detailedPool = [...new Map(
    [...shapePool, ...specialists].map((item) => [item.candidate.id, item]),
  ).values()];
  const output = {} as Record<ProjectionRankMode, RankedProjectionCandidate<T>[]>;
  for (const mode of PROJECTION_RANK_MODES) {
    const pool = mode === "balanced" ? measured : detailedPool;
    output[mode] = [...pool]
      .sort((left, right) => scoreForMode(left.error, mode) - scoreForMode(right.error, mode))
      .slice(0, limit)
      .map(({ candidate, error }) => ({
        candidate,
        error: { ...error, total: scoreForMode(error, mode) },
      }));
  }
  return output;
}

export function rankProjectionCandidateModesTwoStage<T extends ProjectionCandidate>(
  frame: SequenceFrame,
  candidates: T[],
  limit = 48,
  detailedPoolLimit = 1_024,
) {
  if (candidates.length <= detailedPoolLimit) {
    return rankProjectionCandidateModes(frame, candidates, limit);
  }
  const measured = candidates.map((candidate) => ({
    candidate,
    quick: quickProjectionMeasures(frame, candidate),
  }));
  const coarseLimit = Math.max(limit * 8, Math.floor(detailedPoolLimit * 0.66));
  const specialistLimit = Math.max(limit * 2, Math.floor(detailedPoolLimit * 0.2));
  const mouthSpecialistLimit = Math.max(limit * 3, Math.floor(detailedPoolLimit * 0.24));
  const selected = new Map<string, T>();
  const admit = (items: typeof measured, count: number) => {
    for (const item of items.slice(0, count)) selected.set(item.candidate.id, item.candidate);
  };
  admit([...measured].sort((a, b) => a.quick.score - b.quick.score), coarseLimit);
  admit([...measured].sort((a, b) => a.quick.pose - b.quick.pose), specialistLimit);
  admit([...measured].sort((a, b) => a.quick.action - b.quick.action), specialistLimit);
  // Do not let an identity/contour-heavy coarse score discard the few faces
  // whose mouth actually forms the source vowel.
  admit([...measured].sort((a, b) => a.quick.mouth - b.quick.mouth), mouthSpecialistLimit);
  return rankProjectionCandidateModes(frame, [...selected.values()], limit);
}

export function rankProjectionCandidates<T extends ProjectionCandidate>(
  frame: SequenceFrame,
  candidates: T[],
  limit = 48,
  mode: ProjectionRankMode = "expression",
) {
  return rankProjectionCandidateModes(frame, candidates, limit)[mode];
}

function residualMotionAtIndexes(
  previousFrame: SequenceFrame,
  previousCandidate: ProjectionCandidate,
  currentFrame: SequenceFrame,
  currentCandidate: ProjectionCandidate,
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
      offset + 1 >= previousTarget.length || offset + 1 >= previousMatch.length ||
      offset + 1 >= currentTarget.length || offset + 1 >= currentMatch.length
    ) continue;
    const previousResidualX = previousMatch[offset] - previousTarget[offset];
    const previousResidualY = previousMatch[offset + 1] - previousTarget[offset + 1];
    const currentResidualX = currentMatch[offset] - currentTarget[offset];
    const currentResidualY = currentMatch[offset + 1] - currentTarget[offset + 1];
    total += (previousResidualX - currentResidualX) ** 2 +
      (previousResidualY - currentResidualY) ** 2;
    count += 1;
  }
  return count ? Math.sqrt(total / count) : 0;
}

function expressionResidualMotion(
  previousFrame: SequenceFrame,
  previousCandidate: ProjectionCandidate,
  currentFrame: SequenceFrame,
  currentCandidate: ProjectionCandidate,
  weights: { mouth: number; eyes: number; brows: number },
) {
  return residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, MOUTH_INDEXES,
  ) * weights.mouth + residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, EYE_INDEXES,
  ) * weights.eyes + residualMotionAtIndexes(
    previousFrame, previousCandidate, currentFrame, currentCandidate, BROWS,
  ) * weights.brows;
}

function sourceExpressionActivity(previousFrame: SequenceFrame, currentFrame: SequenceFrame) {
  const previous = previousFrame.geometry.projection;
  const current = currentFrame.geometry.projection;
  return rmsAtIndexes(previous, current, EXPRESSION_INDEXES);
}

function rareActionPenalty(frame: SequenceFrame, error: ProjectionError) {
  const targetPitch = Math.abs(Number(frame.feature[1] ?? 0) * 90);
  const pitchActivity = clamp01(targetPitch / 24);
  const targetWink = Math.abs(
    featureValue(frame.feature, 13) - featureValue(frame.feature, 14),
  );
  const winkActivity = clamp01((targetWink - 0.14) / 0.42);
  return Math.abs(error.pitchDegrees) / 90 * (0.18 + pitchActivity * 0.72) +
    error.wink * winkActivity * 0.9;
}

type PathState<T extends ProjectionCandidate> = {
  cost: number;
  history: string[];
  choice: ProjectionChoice<T>;
  previous: PathState<T> | null;
};

/** Selects a different identity every frame; shape continuity is the only continuity signal. */
export function optimizeDistinctProjectionSequence<T extends ProjectionCandidate>(
  frames: SequenceFrame[],
  rankedBeams: Array<Array<{ candidate: T; error: ProjectionError }>>,
  options: ProjectionSequenceOptions = {},
): ProjectionChoice<T>[] {
  if (!frames.length || frames.length !== rankedBeams.length || rankedBeams.some((beam) => !beam.length)) {
    return [];
  }
  const cooldown = Math.max(1, Math.min(30, options.cooldown ?? 12));
  const beamWidth = Math.max(2, Math.min(48, options.beamWidth ?? 20));
  const qualityThreshold = Math.max(0.005, options.qualityThreshold ?? 0.055);
  const residualCoherence = Math.max(0, Math.min(3, options.residualCoherence ?? 0.65));
  const expressionMotionWeight = Math.max(
    0,
    Math.min(12, options.expressionMotionWeight ?? 4.2),
  );
  const motionWeights = options.motionWeights ?? { mouth: 0.5, eyes: 0.3, brows: 0.2 };
  const motionWeightTotal = Math.max(
    0.001,
    motionWeights.mouth + motionWeights.eyes + motionWeights.brows,
  );
  const normalizedMotionWeights = {
    mouth: motionWeights.mouth / motionWeightTotal,
    eyes: motionWeights.eyes / motionWeightTotal,
    brows: motionWeights.brows / motionWeightTotal,
  };

  let paths: PathState<T>[] = rankedBeams[0].slice(0, beamWidth).map(({ candidate, error }) => ({
    cost: error.total + rareActionPenalty(frames[0], error),
    history: [candidate.id],
    choice: {
      frame: frames[0], candidate, emission: error.total, error,
      accepted: error.total <= qualityThreshold,
      expressionMotion: 0,
    },
    previous: null,
  }));

  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const next: PathState<T>[] = [];
    for (const path of paths) {
      for (const { candidate, error } of rankedBeams[frameIndex]) {
        if (path.history.includes(candidate.id)) continue;
        const continuity = residualMotionAtIndexes(
          frames[frameIndex - 1], path.choice.candidate,
          frames[frameIndex], candidate,
          COARSE_INDEXES,
        );
        const expressionMotion = expressionResidualMotion(
          frames[frameIndex - 1], path.choice.candidate,
          frames[frameIndex], candidate,
          normalizedMotionWeights,
        );
        const activity = sourceExpressionActivity(
          frames[frameIndex - 1], frames[frameIndex],
        );
        const activityBoost = Math.min(1.8, activity / 0.012);
        next.push({
          cost: path.cost + error.total + rareActionPenalty(frames[frameIndex], error) +
            continuity * residualCoherence * 0.35 +
            expressionMotion * expressionMotionWeight * (0.45 + activityBoost),
          history: [...path.history, candidate.id].slice(-cooldown),
          choice: {
            frame: frames[frameIndex], candidate, emission: error.total, error,
            accepted: error.total <= qualityThreshold,
            expressionMotion,
          },
          previous: path,
        });
      }
    }
    if (!next.length) {
      for (const path of paths) {
        for (const { candidate, error } of rankedBeams[frameIndex]) {
          if (path.choice.candidate.id === candidate.id) continue;
          next.push({
            cost: path.cost + error.total,
            history: [candidate.id],
            choice: {
              frame: frames[frameIndex], candidate, emission: error.total, error,
              accepted: error.total <= qualityThreshold,
              expressionMotion: 0,
            },
            previous: path,
          });
        }
      }
    }
    paths = next.sort((left, right) => left.cost - right.cost).slice(0, beamWidth);
    if (!paths.length) return [];
  }
  const choices: ProjectionChoice<T>[] = [];
  let cursor: PathState<T> | null = paths[0];
  while (cursor) {
    choices.push(cursor.choice);
    cursor = cursor.previous;
  }
  return choices.reverse();
}
