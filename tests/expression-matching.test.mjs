import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateExpressionFeature,
  createExpressionTracker,
  expressionDistance,
  expressionLabel,
} from "../app/expression-matching.ts";

function feature(overrides = {}) {
  const value = Array(22).fill(0);
  for (const [index, score] of Object.entries(overrides)) value[Number(index)] = score;
  return value;
}

test("classifies the expression channels used by the catalog matcher", () => {
  assert.equal(expressionLabel(feature()), "NEUTRAL");
  assert.equal(expressionLabel(feature({ 7: 0.8, 8: 0.8 })), "SMILE");
  assert.equal(expressionLabel(feature({ 3: 0.8, 17: 0.7, 20: 0.7, 21: 0.7 })), "SURPRISE");
  assert.equal(expressionLabel(feature({ 9: 0.7, 10: 0.7 })), "FROWN");
});

test("neutral calibration removes resting-face bias but keeps a later smile", () => {
  const tracker = createExpressionTracker();
  const resting = feature({ 7: 0.18, 8: 0.18 });
  for (let index = 0; index < 12; index += 1) {
    assert.equal(expressionLabel(calibrateExpressionFeature(resting, tracker)), "NEUTRAL");
  }
  const smile = calibrateExpressionFeature(feature({ 7: 0.78, 8: 0.78 }), tracker);
  assert.equal(expressionLabel(smile), "SMILE");
  assert.ok(expressionDistance(smile, feature({ 7: 0.65, 8: 0.65 })) < expressionDistance(smile, feature()));
});
