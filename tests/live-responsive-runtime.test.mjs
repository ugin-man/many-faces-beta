import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponsiveSwitchController,
  predictedPoseDegrees,
  selectReadyRankedCandidate,
} from "../app/live-responsive-runtime.ts";

function feature({ yaw = 0, pitch = 0, mouth = 0 } = {}) {
  const output = Array(55).fill(0);
  output[0] = yaw / 90;
  output[1] = pitch / 90;
  output[3] = mouth;
  return output;
}

test("static jitter is held instead of forcing periodic face changes", () => {
  const controller = new ResponsiveSwitchController();
  controller.reset(0);
  let switches = 0;
  for (let index = 0; index < 120; index += 1) {
    const now = index * 16.67;
    const decision = controller.observe(now, feature({ yaw: index % 2 ? 0.03 : -0.03 }));
    if (decision.shouldSwitch) {
      switches += 1;
      controller.commitSwitch(now);
    }
  }
  assert.equal(switches, 0);
});

test("continuous head motion produces at least twelve updates per second", () => {
  const controller = new ResponsiveSwitchController();
  controller.reset(0);
  let switches = 0;
  for (let index = 0; index <= 60; index += 1) {
    const now = index * (1000 / 60);
    const decision = controller.observe(
      now,
      feature({ yaw: index * 0.42, mouth: Math.min(0.8, index * 0.012) }),
      20,
    );
    if (decision.shouldSwitch) {
      switches += 1;
      controller.commitSwitch(now);
    }
  }
  assert.ok(switches >= 12, `expected >=12 switches, got ${switches}`);
  assert.ok(switches <= 21, `expected <=21 switches, got ${switches}`);
});

test("small meaningful movement accumulates instead of being lost", () => {
  const controller = new ResponsiveSwitchController();
  controller.reset(0);
  let switched = false;
  for (let index = 0; index < 30; index += 1) {
    const now = index * 33;
    const decision = controller.observe(now, feature({ yaw: index * 0.16 }), 16);
    if (decision.shouldSwitch) {
      switched = true;
      break;
    }
  }
  assert.equal(switched, true);
});

test("ready candidate selection never waits for the unavailable top result", () => {
  const ranked = [
    { candidate: { id: "best" }, score: 0 },
    { candidate: { id: "second" }, score: 0.01 },
    { candidate: { id: "third" }, score: 0.02 },
  ];
  const ready = new Set(["second", "third"]);
  const selected = selectReadyRankedCandidate(
    ranked,
    (candidate) => ready.has(candidate.id),
    null,
  );
  assert.equal(selected?.candidate.id, "second");
});

test("pose prediction leads the current motion without exploding", () => {
  const predicted = predictedPoseDegrees(feature({ yaw: 0 }), feature({ yaw: 4 }), 40, 120);
  assert.ok(predicted.yaw > 4);
  assert.ok(predicted.yaw <= 30.4);
});
