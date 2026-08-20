export type ExpressionTracker = {
  frames: number;
  totals: number[];
  baseline: number[] | null;
};

export type ExpressionSignature = {
  mouthOpen: number;
  smile: number;
  frown: number;
  squint: number;
  browUp: number;
  pucker: number;
  wink: number;
  blink: number;
  eyeWide: number;
  eyeLookUp: number;
  eyeLookDown: number;
  sneer: number;
};

const CALIBRATION_FRAMES = 12;

export function createExpressionTracker(): ExpressionTracker {
  return { frames: 0, totals: Array(FACE_ACTION_KEYS.length).fill(0), baseline: null };
}

export function calibrateExpressionFeature(
  feature: number[],
  tracker: ExpressionTracker,
) {
  const calibrated = [...feature];
  const expression = feature.slice(3);
  while (tracker.totals.length < expression.length) tracker.totals.push(0);
  if (tracker.frames < CALIBRATION_FRAMES) {
    expression.forEach((value, index) => {
      tracker.totals[index] += value;
      calibrated[index + 3] = 0;
    });
    tracker.frames += 1;
    if (tracker.frames === CALIBRATION_FRAMES) {
      tracker.baseline = tracker.totals.map((value) => value / CALIBRATION_FRAMES);
    }
    return calibrated;
  }
  const baseline = tracker.baseline ?? tracker.totals.map(() => 0);
  expression.forEach((value, index) => {
    calibrated[index + 3] = Math.max(0, value - (baseline[index] ?? 0));
  });
  return calibrated;
}

function valueAt(feature: number[], index: number) {
  return Math.max(0, Math.min(1, Number(feature[index] ?? 0)));
}

function actionAt(feature: number[], key: keyof typeof FACE_ACTION_FEATURE_INDEX) {
  return valueAt(feature, FACE_ACTION_FEATURE_INDEX[key]);
}

export function expressionSignature(feature: number[]): ExpressionSignature {
  const smile = (actionAt(feature, "mouthSmileLeft") + actionAt(feature, "mouthSmileRight")) / 2;
  const mouthFrown = (actionAt(feature, "mouthFrownLeft") + actionAt(feature, "mouthFrownRight")) / 2;
  const browDown = (actionAt(feature, "browDownLeft") + actionAt(feature, "browDownRight")) / 2;
  const leftBlink = actionAt(feature, "eyeBlinkLeft");
  const rightBlink = actionAt(feature, "eyeBlinkRight");
  return {
    mouthOpen: Math.max(actionAt(feature, "jawOpen"), actionAt(feature, "mouthFunnel") * 0.45),
    smile,
    frown: Math.max(mouthFrown, browDown),
    squint: (actionAt(feature, "eyeSquintLeft") + actionAt(feature, "eyeSquintRight")) / 2,
    browUp:
      (actionAt(feature, "browInnerUp") + actionAt(feature, "browOuterUpLeft") + actionAt(feature, "browOuterUpRight")) / 3,
    pucker: Math.max(actionAt(feature, "mouthPucker"), actionAt(feature, "mouthFunnel") * 0.7),
    wink: Math.abs(leftBlink - rightBlink),
    blink: Math.min(leftBlink, rightBlink),
    eyeWide: (actionAt(feature, "eyeWideLeft") + actionAt(feature, "eyeWideRight")) / 2,
    eyeLookUp: (actionAt(feature, "eyeLookUpLeft") + actionAt(feature, "eyeLookUpRight")) / 2,
    eyeLookDown: (actionAt(feature, "eyeLookDownLeft") + actionAt(feature, "eyeLookDownRight")) / 2,
    sneer: (actionAt(feature, "noseSneerLeft") + actionAt(feature, "noseSneerRight")) / 2,
  };
}

export function expressionDistance(left: number[], right: number[]) {
  const a = expressionSignature(left);
  const b = expressionSignature(right);
  const weighted = [
    [a.mouthOpen - b.mouthOpen, 3.2],
    [a.smile - b.smile, 3.4],
    [a.frown - b.frown, 2.1],
    [a.squint - b.squint, 0.7],
    [a.browUp - b.browUp, 1.5],
    [a.pucker - b.pucker, 0.8],
    [a.wink - b.wink, 4.2],
    [a.blink - b.blink, 2.2],
    [a.eyeWide - b.eyeWide, 1.8],
    [a.eyeLookUp - b.eyeLookUp, 1.5],
    [a.eyeLookDown - b.eyeLookDown, 1.5],
    [a.sneer - b.sneer, 0.9],
  ];
  return weighted.reduce((sum, [delta, weight]) => sum + delta * delta * weight, 0);
}

export function expressionLabel(feature: number[] | null) {
  if (!feature) return "—";
  const value = expressionSignature(feature);
  if (value.mouthOpen > 0.38 && value.browUp > 0.18) return "SURPRISE";
  if (value.wink > 0.3) return "WINK";
  if (value.blink > 0.42) return "BLINK";
  if (value.smile > 0.28 && value.mouthOpen > 0.32) return "LAUGH";
  if (value.smile > 0.24) return "SMILE";
  if (value.frown > 0.2) return "FROWN";
  if (value.pucker > 0.28) return "PUCKER";
  if (value.mouthOpen > 0.3) return "MOUTH OPEN";
  if (value.squint > 0.3) return "SQUINT";
  return "NEUTRAL";
}
import { FACE_ACTION_FEATURE_INDEX, FACE_ACTION_KEYS } from "./face-actions.ts";
