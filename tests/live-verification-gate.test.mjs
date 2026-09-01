import assert from "node:assert/strict";
import test from "node:test";
import { evaluateVerificationGate } from "../app/live/verification-gate.ts";

test("a complete nonblank video review passes", () => {
  const result = evaluateVerificationGate({
    plannedFrames: 60,
    faceFrames: 58,
    sequenceFrames: 58,
    selectedImages: 18,
    imageFailures: 0,
    outputChanges: 45,
    canvasNonBlank: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.faceCoverage > 0.9);
});

test("blank output and a broken sequence fail visibly", () => {
  const result = evaluateVerificationGate({
    plannedFrames: 60,
    faceFrames: 20,
    sequenceFrames: 18,
    selectedImages: 0,
    imageFailures: 8,
    outputChanges: 0,
    canvasNonBlank: false,
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((reason) => reason.includes("顔検出率")));
  assert.ok(result.reasons.some((reason) => reason.includes("経路フレーム数")));
  assert.ok(result.reasons.some((reason) => reason.includes("空白")));
});
