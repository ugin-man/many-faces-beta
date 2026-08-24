import assert from "node:assert/strict";
import test from "node:test";
import { optimizeDistinctProjectionSequence } from "../app/projection-matching.ts";
import { FaithfulStrictSequence } from "../app/live-faithful-sequence.ts";

function geometry(seed) {
  const projection = Float32Array.from({ length: 936 }, (_, index) =>
    Math.sin(index * 0.017 + seed) * 0.01 + seed * 0.001
  );
  return {
    structure: Float32Array.from({ length: 39 }, (_, index) => seed + index * 0.001),
    surface: Float32Array.from({ length: 300 }, (_, index) => seed + index * 0.0001),
    projection,
    layout: [0.5, 0.5, 1, 1],
  };
}

function frame(index) {
  return {
    time: index / 30,
    feature: Array(55).fill(0),
    geometry: geometry(index * 0.02),
  };
}

function candidate(id, seed) {
  return {
    id,
    feature: Array(55).fill(0),
    geometry: geometry(seed),
  };
}

function error(total) {
  return {
    total,
    balancedTotal: total,
    expressionTotal: total,
    strictTotal: total,
    semanticTotal: total,
    eyeBrowTotal: total,
    mouthTotal: total,
    contour: 0,
    features: 0,
    mouth: 0,
    eyes: 0,
    leftEye: 0,
    rightEye: 0,
    brows: 0,
    expression: 0,
    descriptor: 0,
    blendshape: 0,
    mouthDescriptor: 0,
    mouthShape: 0,
    mouthAction: 0,
    eyeDescriptor: 0,
    browDescriptor: 0,
    shapeGate: 0,
    worstLocal: 0,
    poseDegrees: 0,
    yawDegrees: 0,
    pitchDegrees: 0,
    rollDegrees: 0,
    wink: 0,
    blink: 0,
  };
}

test("faithful live strict stream matches the offline strict optimizer for the same prefix", () => {
  const frames = Array.from({ length: 18 }, (_, index) => frame(index));
  const candidates = [
    candidate("a", 0.01),
    candidate("b", 0.04),
    candidate("c", 0.07),
    candidate("d", 0.1),
  ];
  const beams = frames.map((_, frameIndex) =>
    candidates.map((item, candidateIndex) => ({
      candidate: item,
      error: error(0.02 + Math.abs((frameIndex + candidateIndex) % 4 - 1.5) * 0.004),
    }))
  );

  const offline = optimizeDistinctProjectionSequence(frames, beams, {
    cooldown: 12,
    beamWidth: 24,
    qualityThreshold: 0.055,
    residualCoherence: 0.46,
    expressionMotionWeight: 6.2,
    motionWeights: { mouth: 0.43, eyes: 0.39, brows: 0.18 },
  });
  const stream = new FaithfulStrictSequence();
  frames.forEach((item, index) => stream.push(item, beams[index]));

  assert.deepEqual(
    stream.sequence().map((choice) => choice.candidate.id),
    offline.map((choice) => choice.candidate.id),
  );
});
