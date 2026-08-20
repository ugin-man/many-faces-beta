import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFaceSearchQueries,
  roundRobinSearchPlan,
} from "../app/web-face-search.ts";

function frame({ yaw = 0, pitch = 0, smile = 0, mouthOpen = 0, browUp = 0 } = {}) {
  const feature = Array(22).fill(0);
  feature[0] = yaw / 90;
  feature[1] = pitch / 90;
  feature[3] = mouthOpen;
  feature[7] = smile;
  feature[8] = smile;
  feature[17] = browUp;
  feature[20] = browUp;
  feature[21] = browUp;
  return { feature };
}

test("web queries cover the video's observed pose and expression extremes", () => {
  const queries = buildFaceSearchQueries([
    frame(),
    frame({ yaw: -24, smile: 0.7 }),
    frame({ yaw: 25, pitch: 12, mouthOpen: 0.8, browUp: 0.7 }),
  ]);
  assert.ok(queries.some((query) => query.includes("left side profile")));
  assert.ok(queries.some((query) => query.includes("right side profile looking up")));
  assert.ok(queries.some((query) => query.includes("surprised")));
  assert.ok(queries.includes("close up face portrait person"));
});

test("search requests rotate across queries before increasing page depth", () => {
  assert.deepEqual(roundRobinSearchPlan(["a", "b"], 100, 20), [
    { query: "a", page: 1, limit: 20 },
    { query: "b", page: 1, limit: 20 },
    { query: "a", page: 2, limit: 20 },
    { query: "b", page: 2, limit: 20 },
    { query: "a", page: 3, limit: 20 },
  ]);
});
