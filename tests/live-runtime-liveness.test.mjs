import assert from "node:assert/strict";
import test from "node:test";
import {
  operationIsStalled,
  preparationFailureReason,
  progressSignature,
} from "../app/live/runtime-liveness.ts";

test("readiness failures are observed immediately instead of waiting forever", () => {
  assert.match(
    preparationFailureReason("loading", "failed", 100) ?? "",
    /カタログ/,
  );
  assert.match(
    preparationFailureReason("failed", "loading", 100) ?? "",
    /モデル/,
  );
});

test("readiness has a hard deadline", () => {
  assert.equal(preparationFailureReason("loading", "loading", 44_999), null);
  assert.match(
    preparationFailureReason("loading", "loading", 45_000) ?? "",
    /45秒/,
  );
});

test("a busy operation with no heartbeat is declared stalled", () => {
  assert.equal(operationIsStalled(false, 100_000, 0), false);
  assert.equal(operationIsStalled(true, 89_999, 0), false);
  assert.equal(operationIsStalled(true, 90_000, 0), true);
});

test("progress signatures change when either phase or counters move", () => {
  const first = progressSignature("searching", {
    done: 1,
    total: 10,
    label: "3D照合",
  });
  const second = progressSignature("searching", {
    done: 2,
    total: 10,
    label: "3D照合",
  });
  assert.notEqual(first, second);
  assert.notEqual(second, progressSignature("optimizing", null));
});
