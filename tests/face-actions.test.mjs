import assert from "node:assert/strict";
import test from "node:test";
import {
  FACE_ACTION_FEATURE_INDEX,
  FACE_ACTION_KEYS,
  FACE_FEATURE_LENGTH,
  classifyFaceCoverage,
  faceFeatureFromScores,
} from "../app/face-actions.ts";

test("uses every MediaPipe face action while preserving the legacy positions", () => {
  assert.equal(FACE_ACTION_KEYS.length, 52);
  assert.equal(FACE_FEATURE_LENGTH, 55);
  assert.equal(FACE_ACTION_FEATURE_INDEX.jawOpen, 3);
  assert.equal(FACE_ACTION_FEATURE_INDEX.eyeBlinkLeft, 13);
  assert.equal(FACE_ACTION_FEATURE_INDEX.eyeBlinkRight, 14);
  assert.ok(FACE_ACTION_FEATURE_INDEX.eyeWideLeft > 21);
  const feature = faceFeatureFromScores([0.1, -0.2, 0.05], new Map([
    ["eyeBlinkLeft", 0.9],
    ["eyeBlinkRight", 0.08],
    ["eyeLookUpLeft", 0.5],
    ["eyeLookUpRight", 0.48],
  ]));
  assert.equal(feature.length, FACE_FEATURE_LENGTH);
  assert.deepEqual(feature.slice(0, 3), [0.1, -0.2, 0.05]);
  assert.ok(classifyFaceCoverage(feature).includes("winkLeft"));
  assert.ok(classifyFaceCoverage(feature).includes("lookUp"));
});
