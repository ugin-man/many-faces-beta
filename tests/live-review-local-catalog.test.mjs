import assert from "node:assert/strict";
import test from "node:test";
import {
  poseWindowCellKeys,
  shardFilesForCells,
  shouldExpandPoseWindow,
} from "../app/live/review-local-catalog.ts";

function manifest() {
  const cells = {};
  for (let yaw = -45; yaw <= 45; yaw += 3) {
    for (let pitch = -36; pitch <= 36; pitch += 3) {
      const key = `${yaw}:${pitch}`;
      cells[key] = { count: 10, shards: [`${key}.json`] };
    }
  }
  return {
    poseStep: 3,
    bounds: { yawMin: -45, yawMax: 45, pitchMin: -36, pitchMax: 36 },
    cells,
  };
}

test("review planning loads only the local pose window instead of every catalog cell", () => {
  const catalog = manifest();
  const feature = [0, 0, 0];
  const keys = poseWindowCellKeys(catalog, feature, 12, 15);
  assert.equal(keys.length, 9 * 11);
  assert.ok(keys.includes("0:0"));
  assert.ok(keys.includes("12:15"));
  assert.ok(!keys.includes("45:36"));
  assert.ok(keys.length < Object.keys(catalog.cells).length / 4);
});

test("pose windows clamp to catalog bounds and return stable shard names", () => {
  const catalog = manifest();
  const keys = poseWindowCellKeys(catalog, [1, 1, 0], 12, 15);
  assert.ok(keys.every((key) => catalog.cells[key]));
  assert.equal(keys[0], "45:36");
  const files = shardFilesForCells(catalog, keys.slice(0, 4));
  assert.equal(files.length, 4);
  assert.equal(new Set(files).size, files.length);
});

test("the wider pose window is requested only when local supply is sparse", () => {
  assert.equal(shouldExpandPoseWindow(383, 384), true);
  assert.equal(shouldExpandPoseWindow(384, 384), false);
  assert.equal(shouldExpandPoseWindow(800, 384), false);
});
