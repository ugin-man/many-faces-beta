import assert from "node:assert/strict";
import test from "node:test";
import {
  optimizeDistinctProjectionSequence,
  projectionError,
  rankProjectionCandidateModes,
  rankProjectionCandidateModesTwoStage,
  rankProjectionCandidates,
} from "../app/projection-matching.ts";

function geometry(projection, layout = [0.5, 0.5, 0.6, 0.75]) {
  return { structure: Array(120).fill(0), surface: Array(600).fill(0), projection, layout };
}

function baseProjection() {
  return Array.from({ length: 468 }, (_, index) => [
    ((index % 31) - 15) / 20,
    (Math.floor(index / 31) - 4) / 10,
  ]).flat();
}

function candidate(id, projection, pose = 0) {
  const feature = Array(22).fill(0);
  feature[0] = pose;
  return { id, feature, geometry: geometry(projection) };
}

function measuredError(total) {
  return {
    total,
    balancedTotal: total,
    expressionTotal: total,
    strictTotal: total,
    semanticTotal: total,
    eyeBrowTotal: total,
    mouthTotal: total,
    contour: total,
    features: total,
    mouth: total,
    eyes: total,
    leftEye: total,
    rightEye: total,
    brows: total,
    expression: total,
    descriptor: total,
    blendshape: total,
    mouthDescriptor: total,
    mouthShape: total,
    mouthAction: total,
    eyeDescriptor: total,
    browDescriptor: total,
    shapeGate: total,
    worstLocal: total,
    poseDegrees: 0,
    yawDegrees: 0,
    pitchDegrees: 0,
    rollDegrees: 0,
    wink: total,
    blink: total,
  };
}

function moveIndexes(projection, indexes, dx, dy) {
  const result = [...projection];
  for (const index of indexes) {
    result[index * 2] += dx;
    result[index * 2 + 1] += dy;
  }
  return result;
}

test("full projected shape outranks a pose-only coincidence", () => {
  const projection = baseProjection();
  const frame = { time: 0, feature: Array(22).fill(0), geometry: geometry(projection) };
  const mismatch = projection.map((value, index) => index % 2 ? value * 1.12 : value * 0.82);
  const exactShape = candidate("exact-shape", projection, 0.2);
  const exactPose = candidate("exact-pose", mismatch, 0);
  const ranked = rankProjectionCandidates(frame, [exactPose, exactShape], 2);
  assert.equal(ranked[0].candidate.id, "exact-shape");
  assert.ok(projectionError(frame, exactShape).total < projectionError(frame, exactPose).total);
});

test("distinct sequence forbids recent identities and exposes quality misses", () => {
  const projection = baseProjection();
  const frames = Array.from({ length: 4 }, (_, index) => ({
    time: index / 30,
    feature: Array(22).fill(0),
    geometry: geometry(projection),
  }));
  const identities = ["a", "b", "c", "d"].map((id) => candidate(id, projection));
  const beams = frames.map(() => identities.map((item, index) => ({
    candidate: item,
    error: measuredError(0.04 + index * 0.001),
  })));
  const choices = optimizeDistinctProjectionSequence(frames, beams, {
    cooldown: 3,
    qualityThreshold: 0.039,
  });
  assert.equal(choices.length, frames.length);
  assert.equal(new Set(choices.map((choice) => choice.candidate.id)).size, 4);
  assert.ok(choices.every((choice) => !choice.accepted));
});

test("expression rerank prefers matching lips inside a plausible shape gate", () => {
  const projection = baseProjection();
  const lipIndexes = [13, 14, 61, 82, 87, 291];
  const faceIndexes = [10, 152, 234, 454];
  const target = moveIndexes(projection, lipIndexes, 0, -0.08);
  const frame = { time: 0, feature: Array(22).fill(0), geometry: geometry(target) };
  const matchingExpression = candidate(
    "matching-expression",
    moveIndexes(target, faceIndexes, 0.018, 0),
  );
  const wrongExpression = candidate("wrong-expression", projection);
  const ranked = rankProjectionCandidates(
    frame,
    [wrongExpression, matchingExpression],
    2,
    "expression",
  );
  assert.equal(ranked[0].candidate.id, "matching-expression");
  assert.ok(ranked[0].error.mouth < ranked[1].error.mouth);
});

test("expression motion selects the candidate moving with the source", () => {
  const projection = baseProjection();
  const lipIndexes = [13, 14, 61, 82, 87, 291];
  const movingProjection = moveIndexes(projection, lipIndexes, 0, -0.08);
  const frames = [projection, movingProjection].map((item, index) => ({
    time: index / 30,
    feature: Array(22).fill(0),
    geometry: geometry(item),
  }));
  const neutral = candidate("neutral-a", projection);
  const movesWithSource = candidate("moving-b", movingProjection);
  const staysStill = candidate("still-c", projection);
  const choices = optimizeDistinctProjectionSequence(
    frames,
    [
      [{ candidate: neutral, error: measuredError(0.01) }],
      [
        { candidate: staysStill, error: measuredError(0.009) },
        { candidate: movesWithSource, error: measuredError(0.012) },
      ],
    ],
    { expressionMotionWeight: 6, residualCoherence: 0 },
  );
  assert.equal(choices[1].candidate.id, "moving-b");
  assert.ok(choices[1].expressionMotion < 1e-9);
});

test("strict minimax rejects a candidate with one conspicuously wrong eye region", () => {
  const projection = baseProjection();
  const eyeIndexes = [33, 133, 159, 145, 362, 263, 386, 374];
  const target = moveIndexes(projection, eyeIndexes, 0, -0.06);
  const frame = { time: 0, feature: Array(22).fill(0), geometry: geometry(target) };
  const wrongEyes = candidate("wrong-eyes", projection);
  const mildEverywhere = candidate(
    "mild-everywhere",
    target.map((value, index) => value + (index % 2 ? 0.012 : -0.008)),
  );
  const ranked = rankProjectionCandidates(frame, [wrongEyes, mildEverywhere], 2, "strict");
  assert.equal(ranked[0].candidate.id, "mild-everywhere");
  assert.ok(ranked[0].error.worstLocal < ranked[1].error.worstLocal);
});

test("semantic ranking uses facial action values when geometry is identical", () => {
  const projection = baseProjection();
  const feature = Array(22).fill(0);
  feature[7] = 0.82;
  feature[8] = 0.79;
  const frame = { time: 0, feature, geometry: geometry(projection) };
  const actionMatch = candidate("action-match", projection);
  actionMatch.feature = [...feature];
  const actionMiss = candidate("action-miss", projection);
  const ranked = rankProjectionCandidates(frame, [actionMiss, actionMatch], 2, "semantic");
  assert.equal(ranked[0].candidate.id, "action-match");
  assert.ok(ranked[0].error.blendshape < ranked[1].error.blendshape);
});

test("strict and eye rankings preserve a one-eye wink instead of averaging both eyes", () => {
  const projection = baseProjection();
  const feature = Array(22).fill(0);
  feature[13] = 0.82;
  feature[14] = 0.1;
  const frame = { time: 0, feature, geometry: geometry(projection) };
  const winkMatch = candidate("wink-match", projection);
  winkMatch.feature = [...feature];
  const bothOpen = candidate("both-open", projection);
  for (const mode of ["strict", "eyes"]) {
    const ranked = rankProjectionCandidates(frame, [bothOpen, winkMatch], 2, mode);
    assert.equal(ranked[0].candidate.id, "wink-match");
    assert.ok(ranked[0].error.wink < ranked[1].error.wink);
  }
});

test("strict ranking preserves vertical head pose when projected geometry ties", () => {
  const projection = baseProjection();
  const feature = Array(22).fill(0);
  feature[1] = 36 / 90;
  const frame = { time: 0, feature, geometry: geometry(projection) };
  const pitchMatch = candidate("pitch-match", projection);
  pitchMatch.feature[1] = 36 / 90;
  const level = candidate("level", projection);
  const ranked = rankProjectionCandidates(frame, [level, pitchMatch], 2, "strict");
  assert.equal(ranked[0].candidate.id, "pitch-match");
  assert.ok(ranked[0].error.pitchDegrees < ranked[1].error.pitchDegrees);
});

test("one measurement pass produces every experimental ranking", () => {
  const projection = baseProjection();
  const frame = { time: 0, feature: Array(22).fill(0), geometry: geometry(projection) };
  const modes = rankProjectionCandidateModes(
    frame,
    [candidate("a", projection), candidate("b", moveIndexes(projection, [13, 14], 0, 0.04))],
    2,
  );
  assert.deepEqual(Object.keys(modes).sort(), ["balanced", "expression", "eyes", "mouth", "semantic", "strict"]);
  assert.ok(Object.values(modes).every((ranking) => ranking.length === 2));
});

test("two-stage search keeps an exact local match inside a large distractor set", () => {
  const projection = baseProjection();
  const frame = { time: 0, feature: Array(55).fill(0), geometry: geometry(projection) };
  const distractors = Array.from({ length: 1_400 }, (_, index) => candidate(
    `d-${index}`,
    projection.map((value, point) => value + ((index + point) % 17 - 8) * 0.0025),
    ((index % 31) - 15) / 90,
  ));
  const exact = candidate("exact", projection);
  const modes = rankProjectionCandidateModesTwoStage(frame, [...distractors, exact], 8, 256);
  assert.equal(modes.strict[0].candidate.id, "exact");
  assert.equal(modes.eyes[0].candidate.id, "exact");
});

test("strict ranking distinguishes vowel mouth shapes when the rest of the face ties", () => {
  const projection = baseProjection();
  const wideMouth = moveIndexes(projection, [61, 78], -0.08, 0);
  const wideOpenMouth = moveIndexes(wideMouth, [291, 308], 0.08, 0);
  const target = moveIndexes(wideOpenMouth, [14, 17, 87, 317], 0, 0.055);
  const frame = { time: 0, feature: Array(55).fill(0), geometry: geometry(target) };
  frame.feature[3] = 0.38;
  frame.feature[11] = 0.72;
  frame.feature[12] = 0.69;

  const vowelMatch = candidate("vowel-match", target);
  vowelMatch.feature = [...frame.feature];
  const openButRounded = candidate(
    "open-but-rounded",
    moveIndexes(projection, [14, 17, 87, 317], 0, 0.055),
  );
  openButRounded.feature = [...frame.feature];
  openButRounded.feature[11] = 0.04;
  openButRounded.feature[12] = 0.03;
  openButRounded.feature[5] = 0.75;
  openButRounded.feature[6] = 0.72;

  const ranked = rankProjectionCandidates(frame, [openButRounded, vowelMatch], 2, "strict");
  assert.equal(ranked[0].candidate.id, "vowel-match");
  assert.ok(ranked[0].error.mouthShape < ranked[1].error.mouthShape);
});

test("two-stage search admits a vowel specialist that contour-first candidates would hide", () => {
  const projection = baseProjection();
  const target = moveIndexes(
    moveIndexes(projection, [61, 78], -0.1, 0),
    [291, 308],
    0.1,
    0,
  );
  const frame = { time: 0, feature: Array(55).fill(0), geometry: geometry(target) };
  frame.feature[11] = 0.86;
  frame.feature[12] = 0.82;
  const distractors = Array.from({ length: 1_400 }, (_, index) => {
    const item = candidate(`neutral-${index}`, projection.map(
      (value, point) => value + ((index + point) % 13 - 6) * 0.0004,
    ));
    item.feature = Array(55).fill(0);
    return item;
  });
  const vowelMatch = candidate("vowel-specialist", target);
  vowelMatch.feature = [...frame.feature];
  const modes = rankProjectionCandidateModesTwoStage(
    frame,
    [...distractors, vowelMatch],
    8,
    256,
  );
  assert.equal(modes.strict[0].candidate.id, "vowel-specialist");
  assert.equal(modes.mouth[0].candidate.id, "vowel-specialist");
});
