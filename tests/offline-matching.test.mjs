import assert from "node:assert/strict";
import test from "node:test";
import {
  alignmentTransform,
  faceGeometryFromLandmarks,
  identityGeometryDistance,
  DETAIL_LANDMARKS,
  objectFitCoverLayout,
  optimizeFaceSequence,
  optimizeFaceSequenceBeams,
} from "../app/offline-matching.ts";

test("portrait cover layout matches the face shown inside a square stage", () => {
  const layout = [0.44, 0.46, 0.45, 0.32];
  const covered = objectFitCoverLayout(layout, 512 / 910);
  assert.ok(Math.abs(covered[0] - 0.44) < 1e-12);
  assert.ok(Math.abs(covered[1] - (0.5 + (0.46 - 0.5) * 910 / 512)) < 1e-12);
  assert.ok(Math.abs(covered[2] - 0.45) < 1e-12);
  assert.ok(Math.abs(covered[3] - 0.32 * 910 / 512) < 1e-12);
});

test("alignment accounts for scaling around the image center", () => {
  const geometry = {
    structure: [],
    surface: [],
    projection: [],
    layout: [0.4, 0.45, 0.5, 0.6],
  };
  const target = [0.55, 0.52, 0.6, 0.72];
  const transform = alignmentTransform(geometry, target);
  const renderedCenterX = 0.5 + (geometry.layout[0] - 0.5) * transform.scale + transform.xPercent / 100;
  const renderedCenterY = 0.5 + (geometry.layout[1] - 0.5) * transform.scale + transform.yPercent / 100;
  assert.ok(Math.abs(transform.scale - 1.2) < 1e-12);
  assert.ok(Math.abs(renderedCenterX - target[0]) < 1e-12);
  assert.ok(Math.abs(renderedCenterY - target[1]) < 1e-12);
});

function landmarks(scale = 1, offsetX = 0, offsetY = 0) {
  const points = Array.from({ length: 478 }, (_, index) => ({
    x: offsetX + scale * (0.25 + (index % 19) / 40),
    y: offsetY + scale * (0.18 + (index % 23) / 44),
    z: 0,
  }));
  const set = (index, x, y) => { points[index] = { x: offsetX + x * scale, y: offsetY + y * scale, z: 0 }; };
  set(33, 0.36, 0.42); set(133, 0.45, 0.42);
  set(362, 0.55, 0.42); set(263, 0.64, 0.42);
  set(10, 0.5, 0.2); set(152, 0.5, 0.82);
  set(234, 0.24, 0.52); set(454, 0.76, 0.52);
  set(172, 0.31, 0.7); set(397, 0.69, 0.7);
  set(127, 0.28, 0.35); set(356, 0.72, 0.35);
  set(98, 0.45, 0.56); set(327, 0.55, 0.56);
  set(2, 0.5, 0.58); set(61, 0.4, 0.66); set(291, 0.6, 0.66);
  set(159, 0.405, 0.405); set(145, 0.405, 0.435);
  set(386, 0.595, 0.405); set(374, 0.595, 0.435);
  return points;
}

function feature(yaw = 0) {
  const value = Array(22).fill(0);
  value[0] = yaw;
  return value;
}

test("face identity proportions are stable across image scale and translation", () => {
  const a = faceGeometryFromLandmarks(landmarks());
  const b = faceGeometryFromLandmarks(landmarks(0.72, 0.09, 0.05));
  assert.ok(a && b);
  assert.equal(a.surface.length, DETAIL_LANDMARKS.length * 3, "the surface should retain the compact detail mesh");
  assert.equal(a.projection.length, 468 * 2, "all projected landmarks should be retained");
  assert.ok(a.structure.length > 100, "the descriptor should retain stable face proportions");
  assert.ok(identityGeometryDistance(a, b) < 1e-20);
  assert.notDeepEqual(a.layout, b.layout);
});

test("per-frame beams optimize without comparing every catalog face globally", () => {
  const geometry = faceGeometryFromLandmarks(landmarks());
  assert.ok(geometry);
  const frames = [0, 0.5].map((yaw, index) => ({
    time: index,
    feature: feature(yaw),
    geometry,
  }));
  const front = { id: "front", feature: feature(0), geometry };
  const side = { id: "side", feature: feature(0.5), geometry };
  const choices = optimizeFaceSequenceBeams(frames, [[front], [side]], { coherence: 1 });
  assert.deepEqual(choices.map((choice) => choice.candidate.id), ["front", "side"]);
});

test("sequence optimization holds a structurally continuous face through micro motion", () => {
  const base = faceGeometryFromLandmarks(landmarks());
  assert.ok(base);
  const shifted = {
    ...base,
    structure: base.structure.map((value, index) => value + (index < 4 ? 0.35 : 0)),
    surface: base.surface.map((value, index) => value + (index < 24 ? 0.12 : 0)),
  };
  const frames = [0, 0.012, 0.018].map((yaw, index) => ({
    time: index / 6,
    feature: feature(yaw),
    geometry: base,
  }));
  const candidates = [
    { id: "stable", feature: feature(0), geometry: base },
    { id: "greedy", feature: feature(0.018), geometry: shifted },
  ];
  const choices = optimizeFaceSequence(frames, candidates, { coherence: 1 });
  assert.deepEqual(choices.map((choice) => choice.candidate.id), ["stable", "stable", "stable"]);
});

test("a large head movement still overcomes the continuity penalty", () => {
  const geometry = faceGeometryFromLandmarks(landmarks());
  assert.ok(geometry);
  const frames = [0, 0.5].map((yaw, index) => ({
    time: index,
    feature: feature(yaw),
    geometry,
  }));
  const candidates = [
    { id: "front", feature: feature(0), geometry },
    { id: "side", feature: feature(0.5), geometry },
  ];
  const choices = optimizeFaceSequence(frames, candidates, { coherence: 1 });
  assert.deepEqual(choices.map((choice) => choice.candidate.id), ["front", "side"]);
});
