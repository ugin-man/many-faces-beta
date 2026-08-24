import assert from "node:assert/strict";
import test from "node:test";
import { choosePreloadCandidates } from "../app/live-packed-image-buffer.ts";

function candidate(id, pack) {
  return {
    id,
    name: id,
    url: `/api/catalog/image?id=${id}`,
    pack,
    offset: 0,
    length: 10,
    feature: Array(55).fill(0),
    geometry: {
      structure: Array(13).fill(0),
      surface: Array(300).fill(0),
      projection: Array(936).fill(0),
      layout: [0.5, 0.5, 1, 1],
    },
  };
}

test("preload selection bounds new pack fan-out", () => {
  const candidates = [
    candidate("a1", "a.bin"),
    candidate("b1", "b.bin"),
    candidate("c1", "c.bin"),
    candidate("a2", "a.bin"),
    candidate("b2", "b.bin"),
    candidate("c2", "c.bin"),
  ];
  const selected = choosePreloadCandidates(candidates, new Set(), 10, 2);
  assert.deepEqual(selected.map((item) => item.id), ["a1", "b1", "a2", "b2"]);
});

test("already loaded packs do not consume the new-pack budget", () => {
  const candidates = [
    candidate("loaded", "loaded.bin"),
    candidate("a", "a.bin"),
    candidate("b", "b.bin"),
  ];
  const selected = choosePreloadCandidates(
    candidates,
    new Set(["loaded.bin"]),
    10,
    1,
  );
  assert.deepEqual(selected.map((item) => item.id), ["loaded", "a"]);
});
