import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_INDEX,
  analyzeCoverageEntries,
  classifyFaceConfigurations,
} from "../tools/coverage-200k-plan.mjs";

function feature({ yaw = 0, pitch = 0, actions = {} } = {}) {
  const values = Array(55).fill(0);
  values[0] = yaw / 90;
  values[1] = pitch / 90;
  for (const [key, value] of Object.entries(actions)) values[FEATURE_INDEX[key]] = value;
  return values;
}

function encodedProjection({ left = 0.08, right = 0.08 } = {}) {
  const values = new Int16Array(936);
  values[159 * 2 + 1] = Math.round(left * 4096);
  values[145 * 2 + 1] = 0;
  values[386 * 2 + 1] = Math.round(right * 4096);
  values[374 * 2 + 1] = 0;
  return Buffer.from(values.buffer).toString("base64");
}

test("coverage classifier keeps asymmetric eye and mouth configurations", () => {
  const values = feature({
    yaw: 27,
    pitch: 18,
    actions: {
      eyeBlinkLeft: 0.91,
      eyeBlinkRight: 0.06,
      mouthSmileLeft: 0.62,
      mouthSmileRight: 0.11,
      mouthStretchLeft: 0.44,
      mouthStretchRight: 0.31,
    },
  });
  const configurations = classifyFaceConfigurations(values, encodedProjection({ left: 0.08, right: 0.025 }));
  assert.ok(configurations.includes("winkLeft"));
  assert.ok(configurations.includes("smileAsymmetric"));
  assert.ok(configurations.includes("mouthWide"));
});

test("200k plan allocates exactly the missing accepted image count", () => {
  const entries = [
    { id: "neutral", feature: feature(), projection: encodedProjection() },
    { id: "smile", feature: feature({ actions: { mouthSmileLeft: 0.5, mouthSmileRight: 0.5 } }), projection: encodedProjection() },
    { id: "open", feature: feature({ pitch: 18, actions: { jawOpen: 0.7 } }), projection: encodedProjection() },
    { id: "blink", feature: feature({ yaw: -27, actions: { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7 } }), projection: encodedProjection({ left: 0.02, right: 0.02 }) },
  ];
  const plan = analyzeCoverageEntries(entries, { targetTotal: 200, poseStep: 9 });
  assert.equal(plan.neededImages, 196);
  assert.equal(
    plan.collectionQueue.reduce((sum, item) => sum + item.recommendedAdditions, 0),
    196,
  );
  assert.ok(plan.weakest.some((item) => item.configuration === "winkLeft"));
  assert.ok(plan.weakest.some((item) => Math.abs(item.yaw) >= 27));
});
