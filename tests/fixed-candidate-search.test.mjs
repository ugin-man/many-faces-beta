import assert from "node:assert/strict";
import test from "node:test";
import { FixedCandidateSearchIndex } from "../app/fixed-candidate-search.ts";
import { FACE_ACTION_FEATURE_INDEX } from "../app/face-actions.ts";

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function feature(overrides = {}) {
  const output = Array(55).fill(0);
  output[0] = (overrides.yaw ?? 0) / 90;
  output[1] = (overrides.pitch ?? 0) / 90;
  output[2] = (overrides.roll ?? 0) / 90;
  for (const [key, value] of Object.entries(overrides.actions ?? {})) {
    output[FACE_ACTION_FEATURE_INDEX[key]] = value;
  }
  return output;
}

function geometry(seed, structureOverride = null) {
  const next = random(seed);
  const structure = structureOverride ?? Array.from({ length: 180 }, () => next() * 1.8 - 0.9);
  const projection = Array.from({ length: 936 }, () => next() * 2 - 1);
  return { structure, projection };
}

function candidate(id, seed, options = {}) {
  return {
    id,
    feature: feature(options),
    geometry: geometry(seed, options.structure),
  };
}

test("fixed search keeps an exact structural and action match", () => {
  const candidates = Array.from({ length: 2_000 }, (_, index) => candidate(`face-${index}`, index + 1, {
    yaw: (index % 11 - 5) * 6,
    pitch: (index % 7 - 3) * 6,
    actions: { mouthSmileLeft: (index % 5) / 5, mouthSmileRight: (index % 7) / 7 },
  }));
  const exact = candidate("exact", 99_999, {
    yaw: 18,
    pitch: -9,
    actions: { mouthPucker: 0.83, mouthFunnel: 0.71, eyeWideLeft: 0.44, eyeWideRight: 0.46 },
  });
  candidates.push(exact);
  const index = new FixedCandidateSearchIndex(candidates);
  const result = index.query(exact, { budget: 64, maxInspected: 512 });
  assert.equal(result.candidates[0]?.id, "exact");
  assert.ok(result.inspected <= 512);
});

test("query work stays bounded when the catalog grows sixfold", () => {
  const base = Array.from({ length: 1_200 }, (_, index) => candidate(`base-${index}`, index + 10, {
    yaw: (index % 17 - 8) * 3,
    pitch: (index % 13 - 6) * 3,
    actions: { jawOpen: (index % 9) / 9, browInnerUp: (index % 11) / 11 },
  }));
  const expanded = Array.from({ length: 6 }, (_, replica) =>
    base.map((item) => ({ ...item, id: `${item.id}-r${replica}` })),
  ).flat();
  const frame = base[333];
  const one = new FixedCandidateSearchIndex(base).query(frame, { budget: 96, maxInspected: 640 });
  const six = new FixedCandidateSearchIndex(expanded).query(frame, { budget: 96, maxInspected: 640 });
  assert.ok(one.inspected <= 640);
  assert.ok(six.inspected <= 640);
  assert.equal(one.candidates.length, 96);
  assert.equal(six.candidates.length, 96);
});

test("side-pose wink specialist survives neutral structural distractors", () => {
  const sharedStructure = Array.from({ length: 180 }, (_, index) => Math.sin(index / 7) * 0.2);
  const distractors = Array.from({ length: 3_000 }, (_, index) => candidate(`neutral-${index}`, index + 300, {
    yaw: 30,
    pitch: 18,
    structure: sharedStructure.map((value, dimension) => value + ((index + dimension) % 13) * 0.0007),
    actions: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
  }));
  const wink = candidate("side-wink", 42_424, {
    yaw: 30,
    pitch: 18,
    structure: sharedStructure,
    actions: { eyeBlinkLeft: 0.92, eyeBlinkRight: 0.08, mouthSmileLeft: 0.41, mouthSmileRight: 0.12 },
  });
  const index = new FixedCandidateSearchIndex([...distractors, wink]);
  const result = index.query(wink, { budget: 32, maxInspected: 256 });
  assert.ok(result.candidates.some((item) => item.id === "side-wink"));
});

test("recent identity is reserved inside the fixed beam", () => {
  const candidates = Array.from({ length: 400 }, (_, index) => candidate(`face-${index}`, index + 700, {
    yaw: (index % 9 - 4) * 3,
  }));
  const frame = candidates[10];
  const previousId = candidates[399].id;
  const result = new FixedCandidateSearchIndex(candidates).query(frame, {
    budget: 24,
    maxInspected: 192,
    previousIds: [previousId],
  });
  assert.ok(result.candidates.some((item) => item.id === previousId));
});
