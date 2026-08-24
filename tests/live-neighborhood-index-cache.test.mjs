import assert from "node:assert/strict";
import test from "node:test";
import {
  LiveNeighborhoodIndexCache,
  liveNeighborhoodKey,
} from "../app/live-neighborhood-index-cache.ts";

test("recent pose neighborhoods are reused", () => {
  const cache = new LiveNeighborhoodIndexCache({ maxEntries: 3 });
  const snapshot = { candidates: [{ id: "face" }], index: { size: 1 } };
  cache.set("left", snapshot);
  assert.equal(cache.get("left"), snapshot);
  assert.equal(cache.size(), 1);
});

test("least recently used neighborhoods are evicted", () => {
  const cache = new LiveNeighborhoodIndexCache({ maxEntries: 2 });
  cache.set("left", { candidates: [], index: null });
  cache.set("center", { candidates: [], index: null });
  assert.ok(cache.get("left"));
  cache.set("right", { candidates: [], index: null });
  assert.equal(cache.has("center"), false);
  assert.equal(cache.has("left"), true);
  assert.equal(cache.has("right"), true);
});

test("neighborhood key preserves preferred shard order", () => {
  assert.equal(
    liveNeighborhoodKey(["center.json", "left.json", "right.json"]),
    "center.json|left.json|right.json",
  );
});
