import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLiveCandidateIndex,
  decodeCatalogVector,
  rankLiveCandidates,
} from "../app/live-matching.ts";
import { FACE_ACTION_FEATURE_INDEX } from "../app/face-actions.ts";

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

function geometry(value = 0) {
  return {
    structure: Array(180).fill(value),
    surface: Array(600).fill(value),
    projection: Array(936).fill(value),
    layout: [0.5, 0.5, 0.8, 0.9],
  };
}

function candidate(id, value, options = {}) {
  return {
    id,
    name: id,
    url: `/api/catalog/image?id=${id}.webp`,
    feature: feature(options),
    geometry: geometry(value),
  };
}

test("catalog vector decoder restores signed fixed-point values", () => {
  const encoded = Buffer.from(Int16Array.from([4096, -2048, 1024]).buffer).toString("base64");
  const decoded = decodeCatalogVector(encoded);
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded), [1, -0.5, 0.25]);
});

test("realtime ranking keeps an exact mouth and wink match", () => {
  const exact = candidate("exact", 0, {
    yaw: 12,
    pitch: -6,
    actions: {
      mouthPucker: 0.84,
      mouthFunnel: 0.73,
      eyeBlinkLeft: 0.91,
      eyeBlinkRight: 0.08,
    },
  });
  const distractors = Array.from({ length: 1_000 }, (_, index) => candidate(
    `distractor-${index}`,
    0.08 + index * 0.0001,
    {
      yaw: 12 + (index % 5 - 2) * 3,
      pitch: -6 + (index % 3 - 1) * 3,
      actions: {
        mouthSmileLeft: (index % 7) / 8,
        mouthSmileRight: (index % 5) / 7,
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
      },
    },
  ));
  const index = buildLiveCandidateIndex([...distractors, exact]);
  const result = rankLiveCandidates(index, exact, {
    mode: "strict",
    budget: 64,
    detailedLimit: 32,
  });
  assert.equal(result.winner?.candidate.id, "exact");
  assert.ok(result.inspected <= 256);
});

test("current identity is held across a near-tie", () => {
  const current = candidate("current", 0.001, { yaw: 3 });
  const challenger = candidate("challenger", 0, { yaw: 3 });
  const index = buildLiveCandidateIndex([current, challenger]);
  const result = rankLiveCandidates(index, challenger, {
    currentId: current.id,
    recentIds: [current.id],
    holdBias: 0.02,
    hysteresis: 0.02,
    budget: 16,
    detailedLimit: 8,
  });
  assert.equal(result.winner?.candidate.id, "current");
});
