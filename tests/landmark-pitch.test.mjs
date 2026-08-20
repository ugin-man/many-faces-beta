import assert from "node:assert/strict";
import test from "node:test";
import {
  createLandmarkPitchTracker,
  landmarkPitchDegrees,
} from "../app/landmark-pitch.ts";

function face({ noseY = 0.52, chinY = 0.76, lipY = 0.62 } = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  landmarks[10] = { x: 0.5, y: 0.23, z: 0 };
  for (const index of [33, 133, 362, 263]) {
    landmarks[index] = { x: index < 200 ? 0.41 : 0.59, y: 0.42, z: 0 };
  }
  landmarks[1] = { x: 0.5, y: noseY, z: -0.04 };
  landmarks[13] = { x: 0.5, y: lipY, z: -0.01 };
  landmarks[152] = { x: 0.5, y: chinY, z: 0.02 };
  return landmarks;
}

function calibrate(tracker) {
  for (let index = 0; index < 12; index += 1) {
    assert.equal(landmarkPitchDegrees(face(), tracker), 0);
  }
}

test("calibrated landmark pitch reacts strongly in both vertical directions", () => {
  const upward = createLandmarkPitchTracker();
  calibrate(upward);
  let upwardPitch = 0;
  for (let index = 0; index < 8; index += 1) {
    upwardPitch = landmarkPitchDegrees(face({ noseY: 0.49, chinY: 0.71 }), upward);
  }
  assert.ok(upwardPitch >= 12, `upward pitch was ${upwardPitch}`);

  const downward = createLandmarkPitchTracker();
  calibrate(downward);
  let downwardPitch = 0;
  for (let index = 0; index < 8; index += 1) {
    downwardPitch = landmarkPitchDegrees(face({ noseY: 0.55, chinY: 0.8 }), downward);
  }
  assert.ok(downwardPitch <= -12, `downward pitch was ${downwardPitch}`);
});

test("landmark pitch ignores whole-face translation and roll-axis projection", () => {
  const tracker = createLandmarkPitchTracker();
  calibrate(tracker);
  const angle = Math.PI / 7;
  const transformed = face().map((point) => {
    const x = point.x - 0.5;
    const y = point.y - 0.5;
    return {
      ...point,
      x: x * Math.cos(angle) - y * Math.sin(angle) + 0.57,
      y: x * Math.sin(angle) + y * Math.cos(angle) + 0.41,
    };
  });
  assert.equal(landmarkPitchDegrees(transformed, tracker), 0);
});

test("landmark pitch exposes fine 1.5 degree tracking steps", () => {
  const tracker = createLandmarkPitchTracker();
  calibrate(tracker);
  let pitch = 0;
  for (let index = 0; index < 5; index += 1) {
    pitch = landmarkPitchDegrees(face({ noseY: 0.515, chinY: 0.75 }), tracker);
  }
  assert.notEqual(pitch, 0);
  assert.equal(Math.abs(pitch * 2) % 3, 0);
});
