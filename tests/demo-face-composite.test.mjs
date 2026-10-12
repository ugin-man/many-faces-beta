import assert from "node:assert/strict";
import test from "node:test";
import { demoFrameIsSafe, demoMaskGeometry } from "../app/demo-face-composite.ts";

test("demo never reveals input without a fresh matching face frame", () => {
  assert.equal(demoFrameIsSafe(false, 1, 1, 1, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, Number.NaN, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, .7, 20), false);
  assert.equal(demoFrameIsSafe(true, .8, 1, 1, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, 1, 20), true);
  assert.equal(demoFrameIsSafe(true, 1.04, 1.04, 1, 20), true);
});

test("opaque backing is always larger than feathered replacement mask", () => {
  for (const layout of [[.5,.5,.3,.4],[.15,.2,.15,.2],[.9,.8,.7,.9]]) {
    const mask = demoMaskGeometry(layout);
    assert.ok(mask.coverRx > mask.imageRx);
    assert.ok(mask.coverRy > mask.imageRy);
  }
});
