export const LEGACY_FACE_ACTION_KEYS = [
  "jawOpen",
  "mouthClose",
  "mouthFunnel",
  "mouthPucker",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "browInnerUp",
  "browDownLeft",
  "browDownRight",
  "browOuterUpLeft",
  "browOuterUpRight",
] as const;

// Keep the original 19 channels first so old 22-value catalogs remain readable.
// The remaining MediaPipe actions add eye direction, eye width, cheeks, nose,
// jaw translation and the smaller asymmetric mouth movements that were missing.
export const FACE_ACTION_KEYS = [
  ...LEGACY_FACE_ACTION_KEYS,
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawRight",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
  "_neutral",
] as const;

export type FaceActionKey = typeof FACE_ACTION_KEYS[number];
export const FACE_FEATURE_LENGTH = 3 + FACE_ACTION_KEYS.length;

export const FACE_ACTION_FEATURE_INDEX = Object.fromEntries(
  FACE_ACTION_KEYS.map((key, index) => [key, index + 3]),
) as Record<FaceActionKey, number>;

type ScoreSource = ReadonlyMap<string, number> | Record<string, number | undefined>;

function scoreAt(scores: ScoreSource, key: string) {
  const value = typeof (scores as ReadonlyMap<string, number>).get === "function"
    ? (scores as ReadonlyMap<string, number>).get(key)
    : (scores as Record<string, number | undefined>)[key];
  return Number.isFinite(value) ? Number(value) : 0;
}

export function faceFeatureFromScores(
  pose: readonly number[],
  scores: ScoreSource,
  precision: number | null = null,
) {
  const actions = FACE_ACTION_KEYS.map((key) => scoreAt(scores, key));
  const feature = [Number(pose[0] ?? 0), Number(pose[1] ?? 0), Number(pose[2] ?? 0), ...actions];
  if (precision === null) return feature;
  const factor = 10 ** precision;
  return feature.map((value) => Math.round(value * factor) / factor);
}

export const FACE_COVERAGE_ACTIONS = [
  "winkLeft",
  "winkRight",
  "blink",
  "eyesWide",
  "lookUp",
  "lookDown",
  "browsUp",
  "smile",
  "mouthOpen",
  "pucker",
  "sneer",
  "neutral",
] as const;

export type FaceCoverageAction = typeof FACE_COVERAGE_ACTIONS[number];

function actionValue(feature: readonly number[], key: FaceActionKey) {
  return Math.max(0, Math.min(1, Number(feature[FACE_ACTION_FEATURE_INDEX[key]] ?? 0)));
}

export function classifyFaceCoverage(feature: readonly number[]): FaceCoverageAction[] {
  const leftBlink = actionValue(feature, "eyeBlinkLeft");
  const rightBlink = actionValue(feature, "eyeBlinkRight");
  const actions: FaceCoverageAction[] = [];
  if (leftBlink - rightBlink > 0.28) actions.push("winkLeft");
  if (rightBlink - leftBlink > 0.28) actions.push("winkRight");
  if (Math.min(leftBlink, rightBlink) > 0.42) actions.push("blink");
  if ((actionValue(feature, "eyeWideLeft") + actionValue(feature, "eyeWideRight")) / 2 > 0.24) actions.push("eyesWide");
  if ((actionValue(feature, "eyeLookUpLeft") + actionValue(feature, "eyeLookUpRight")) / 2 > 0.22) actions.push("lookUp");
  if ((actionValue(feature, "eyeLookDownLeft") + actionValue(feature, "eyeLookDownRight")) / 2 > 0.22) actions.push("lookDown");
  if (Math.max(
    actionValue(feature, "browInnerUp"),
    actionValue(feature, "browOuterUpLeft"),
    actionValue(feature, "browOuterUpRight"),
  ) > 0.26) actions.push("browsUp");
  if ((actionValue(feature, "mouthSmileLeft") + actionValue(feature, "mouthSmileRight")) / 2 > 0.28) actions.push("smile");
  if (actionValue(feature, "jawOpen") > 0.32) actions.push("mouthOpen");
  if (Math.max(actionValue(feature, "mouthPucker"), actionValue(feature, "mouthFunnel")) > 0.28) actions.push("pucker");
  if ((actionValue(feature, "noseSneerLeft") + actionValue(feature, "noseSneerRight")) / 2 > 0.2) actions.push("sneer");
  return actions.length ? actions : ["neutral"];
}
