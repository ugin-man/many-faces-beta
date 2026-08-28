import assert from "node:assert/strict";
import test from "node:test";
import {
  canProcessFaithfulQueue,
  canStartFaithfulCapture,
} from "../app/live/faithful-startup.ts";

test("camera capture can start while the model and catalog are still preparing", () => {
  assert.equal(canStartFaithfulCapture(false, false), true);
  assert.equal(canStartFaithfulCapture(true, false), false);
  assert.equal(canStartFaithfulCapture(false, true), false);
});

test("queued frames wait until both the landmarker and catalog candidates exist", () => {
  assert.equal(canProcessFaithfulQueue(false, 70_000), false);
  assert.equal(canProcessFaithfulQueue(true, 0), false);
  assert.equal(canProcessFaithfulQueue(true, 3), false);
  assert.equal(canProcessFaithfulQueue(true, 4), true);
});
