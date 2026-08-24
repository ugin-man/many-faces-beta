import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveSearchCadence } from "../app/live-search-cadence.ts";

test("cheap searches remain close to a twenty-fps cadence", () => {
  const cadence = new AdaptiveSearchCadence({ targetFps: 20 });
  let searches = 0;
  for (let now = 0; now < 1_000; now += 10) {
    if (cadence.shouldSearch(now)) {
      cadence.record(2);
      searches += 1;
    }
  }
  assert.ok(searches >= 18 && searches <= 21, `searches=${searches}`);
});

test("expensive searches back off without dropping below about twelve fps", () => {
  const cadence = new AdaptiveSearchCadence({ targetFps: 20 });
  cadence.record(12);
  cadence.record(12);
  cadence.record(12);
  let searches = 0;
  for (let now = 0; now < 1_000; now += 10) {
    if (cadence.shouldSearch(now)) {
      cadence.record(12);
      searches += 1;
    }
  }
  assert.ok(searches >= 11 && searches <= 16, `searches=${searches}`);
});

test("urgent search uses the minimum interval and reset removes stale timing", () => {
  const cadence = new AdaptiveSearchCadence({ targetFps: 20, minimumIntervalMs: 30 });
  assert.equal(cadence.shouldSearch(0), true);
  assert.equal(cadence.shouldSearch(20, true), false);
  assert.equal(cadence.shouldSearch(30, true), true);
  cadence.reset();
  assert.equal(cadence.shouldSearch(31), true);
});
