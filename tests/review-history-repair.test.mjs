import assert from "node:assert/strict";
import test from "node:test";
import { expressionResidualMotion, projectionError } from "../app/projection-matching.ts";
import { compareReviewSequences, measureReviewSequence } from "../app/live/review-history-selection.ts";
import { repairHistoryAwareReviewSequence } from "../app/live/review-history-repair.ts";

const projection = Array.from({ length: 468 }, (_, i) => [((i % 31) - 15) / 20, (Math.floor(i / 31) - 4) / 10]).flat();
const geometry = offset => ({ projection: projection.map((value, index) => value + (index % 2 ? 0 : offset)),
  layout: [0.5, 0.5, 0.6, 0.75], structure: Array(120).fill(0), surface: Array(600).fill(0) });
const feature = Array(55).fill(0);
const frame = time => ({ time, feature, geometry: geometry(0) });
const photo = (id, offset = 0) => ({ id, feature, geometry: geometry(offset) });
const a = photo("a"), b = photo("b"), c = photo("c");
const measured = (total = 0.02, changes = {}) => ({
  ...Object.fromEntries(Object.keys(projectionError(frame(0), a)).map(key => [key, 0])), total, ...changes,
});
const item = (candidate, total = 0.02, changes = {}) => ({ candidate, error: measured(total, changes) });
const choice = (candidate, time, total = 0.02) => ({ frame: frame(time), candidate,
  error: measured(total), emission: total, accepted: total <= 0.055, expressionMotion: 0 });
const sequence = candidates => candidates.map((candidate, index) => choice(candidate, index * 0.2));
const ids = choices => choices.map(choice => choice.candidate.id);
const pools = baseline => baseline.map(({ candidate, error }) => [{ candidate, error }]);
const freezeDeep = (value, seen = new WeakSet()) => {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(child => freezeDeep(child, seen)); Object.freeze(value);
  }
  return value;
};

test("continuous holding and expired returns preserve the exact baseline without exploring novelty", () => {
  for (const baseline of [sequence([a, a, a]), [choice(a, 0), choice(b, 5), choice(a, 7)]]) {
    const result = repairHistoryAwareReviewSequence(baseline, baseline.map(() => [item(c, 0)]));
    assert.strictEqual(result.choices, baseline);
    assert.equal(result.diagnostics.before.recentReappearances, 0);
    assert.equal(result.diagnostics.candidatesInspected, 0);
    assert.equal(result.diagnostics.triedPatches, 0);
  }
});

test("A-B-A may bridge its gap by continuing A without mutating the baseline", () => {
  const baseline = freezeDeep(sequence([a, b, a])), beams = pools(baseline);
  beams[1].push(item(a));
  const snapshot = structuredClone(baseline);
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.deepEqual(ids(result.choices), ["a", "a", "a"]);
  assert.equal(result.diagnostics.adoptedPatches, 1);
  assert.equal(result.diagnostics.patches[0].kind, "bridge-gap");
  assert.equal(result.diagnostics.before.recentReappearances, 1);
  assert.equal(result.diagnostics.after.recentReappearances, 0);
  assert.equal(result.diagnostics.after.switches, 0);
  assert.equal(result.diagnostics.comparison.accepted, true);
  assert.deepEqual(baseline, snapshot);
  assert.strictEqual(result.choices[0], baseline[0]);
  assert.strictEqual(result.choices[2], baseline[2]);
});

test("complete return and earlier runs can be repaired using their whole-run candidate intersection", () => {
  for (const replaceEarlier of [false, true]) {
    const baseline = sequence([a, a, b, b, a, a]), beams = pools(baseline);
    const start = replaceEarlier ? 0 : 4;
    beams[start].push(item(c)); beams[start + 1].push(item(c));
    const result = repairHistoryAwareReviewSequence(baseline, beams);
    assert.deepEqual(ids(result.choices), replaceEarlier ? ["c", "c", "b", "b", "a", "a"] : ["a", "a", "b", "b", "c", "c"]);
    assert.equal(result.diagnostics.patches[0].kind, replaceEarlier ? "replace-earlier" : "replace-return");
    assert.equal(result.diagnostics.after.recentReappearances, 0);
    assert.equal(compareReviewSequences(baseline, result.choices).accepted, true);
    for (let index = 0; index < baseline.length; index++) {
      if (index < start || index > start + 1) assert.strictEqual(result.choices[index], baseline[index]);
    }
  }
  const baseline = sequence([a, a, b, b, a, a]), beams = pools(baseline);
  beams[4].push(item(c)); // C is absent from the second frame of the returning run.
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.strictEqual(result.choices, baseline);
  assert.equal(result.diagnostics.scoredPatches, 0);
});

test("each original per-frame total, local, and absolute pose-axis limit holds on every interval sample", () => {
  const fields = ["total", "mouth", "mouthShape", "eyes", "leftEye", "rightEye", "brows", "wink", "blink", "worstLocal",
    "yawDegrees", "pitchDegrees", "rollDegrees"];
  for (const field of fields) {
    const baseline = sequence([a, a, b, b, a, a]), beams = pools(baseline);
    beams[4].push(item(c));
    const isAxis = field.endsWith("Degrees");
    const rejected = measured();
    rejected[field] = isAxis ? -0.500000001 : (field === "total" ? 0.02 : 0) + 0.003000001;
    beams[5].push({ candidate: c, error: rejected });
    const result = repairHistoryAwareReviewSequence(baseline, beams);
    assert.strictEqual(result.choices, baseline, field);
    assert.ok(result.diagnostics.fidelityRejected > 0, field);
    assert.equal(result.diagnostics.triedPatches, 0, field);
  }
});

test("aggregate fidelity gates can reject a candidate that passes each frame's absolute allowance", () => {
  const baseline = sequence([a, b, a]), beams = pools(baseline);
  beams[2].push(item(c, 0.022));
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.strictEqual(result.choices, baseline);
  assert.equal(result.diagnostics.fidelityRejected, 0);
  assert.ok(result.diagnostics.rejectedReasons["error-mean"] > 0);
  assert.ok(result.diagnostics.triedPatches > 0);
});

test("the exit transition rejects a repair even when its incoming transition improves", () => {
  const previous = photo("previous", 0.01), following = photo("following", -0.01), replacement = photo("replacement", 0.01);
  const baseline = sequence([a, previous, a, following]), beams = pools(baseline);
  beams[2].push(item(replacement));
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.strictEqual(result.choices, baseline);
  assert.equal(result.diagnostics.fidelityRejected, 0);
  assert.ok(result.diagnostics.rejectedReasons["continuity-max"] > 0);
  assert.ok(result.diagnostics.rejectedReasons["expressionMotion-max"] > 0);
});

test("accepted multi-sample repair recomputes entry and exit expression motion while preserving unrelated choices", () => {
  const previous = photo("previous", 0.01), following = photo("following", -0.01), replacement = photo("replacement", 0.00005);
  const baseline = sequence([a, previous, a, a, following]);
  for (let index = 1; index < baseline.length; index++) {
    baseline[index].expressionMotion = expressionResidualMotion(baseline[index - 1].frame, baseline[index - 1].candidate,
      baseline[index].frame, baseline[index].candidate, { mouth: 0.43, eyes: 0.39, brows: 0.18 });
  }
  const beams = pools(baseline); beams[2].push(item(replacement)); beams[3].push(item(replacement));
  const snapshot = structuredClone(baseline); freezeDeep(baseline);
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.deepEqual(ids(result.choices), ["a", "previous", "replacement", "replacement", "following"]);
  for (const index of [2, 3, 4]) {
    const expected = expressionResidualMotion(result.choices[index - 1].frame, result.choices[index - 1].candidate,
      result.choices[index].frame, result.choices[index].candidate, { mouth: 0.43, eyes: 0.39, brows: 0.18 });
    assert.equal(result.choices[index].expressionMotion, expected);
  }
  assert.notEqual(result.choices[2].expressionMotion, baseline[2].expressionMotion);
  assert.notEqual(result.choices[4].expressionMotion, baseline[4].expressionMotion);
  assert.strictEqual(result.choices[0], baseline[0]); assert.strictEqual(result.choices[1], baseline[1]);
  assert.strictEqual(result.choices[4].candidate, baseline[4].candidate);
  assert.strictEqual(result.choices[4].frame, baseline[4].frame);
  assert.deepEqual(baseline, snapshot);
});

test("cumulative repairs remain inside the original budget instead of spending fresh slack after each patch", () => {
  const d = photo("d"), x = photo("x"), y = photo("y");
  const baseline = sequence([a, b, a, c, d, c]); baseline[1] = choice(b, 0.2, 0.04);
  const beams = pools(baseline); beams[2].push(item(x, 0.0202)); beams[5].push(item(y, 0.0202));
  const result = repairHistoryAwareReviewSequence(baseline, beams);
  assert.equal(result.diagnostics.adoptedPatches, 1);
  assert.equal(result.diagnostics.before.recentReappearances, 2);
  assert.equal(result.diagnostics.after.recentReappearances, 1);
  assert.ok(result.diagnostics.rejectedReasons["error-mean"] > 0);
  assert.equal(compareReviewSequences(baseline, result.choices).accepted, true);
  assert.deepEqual(ids(result.choices), ["a", "b", "x", "c", "d", "c"]);
});

test("the existing objective wins before stable photo IDs, and input ordering cannot break exact ties", () => {
  const lowId = photo("c-low"), highId = photo("z-high");
  for (const reversed of [false, true]) {
    const baseline = sequence([a, b, a]), beams = pools(baseline);
    const alternatives = [item(highId), item(lowId)];
    beams[2].push(...(reversed ? alternatives.reverse() : alternatives));
    const result = repairHistoryAwareReviewSequence(baseline, beams);
    assert.deepEqual(ids(result.choices), ["a", "b", "c-low"]);
    assert.deepEqual(repairHistoryAwareReviewSequence(baseline, beams), result);
    beams[2] = [item(a), item(lowId), item(highId, 0.01999)];
    assert.deepEqual(ids(repairHistoryAwareReviewSequence(baseline, beams).choices), ["a", "b", "z-high"]);
  }
});

test("disabled or invalid input returns the exact original array, including conflicting data for a photo ID", () => {
  const baseline = sequence([a, b, a]), beams = pools(baseline); beams[2].push(item(c));
  assert.strictEqual(repairHistoryAwareReviewSequence(baseline, null, { enabled: false }).choices, baseline);
  for (const options of [{ maxTrials: NaN }, { maxPatches: -1 }, { maxTrials: 1000000 }, { enabled: "yes" }]) {
    const result = repairHistoryAwareReviewSequence(baseline, beams, options);
    assert.strictEqual(result.choices, baseline); assert.equal(result.diagnostics.reason, "invalid-input");
  }
  assert.strictEqual(repairHistoryAwareReviewSequence(baseline, beams.slice(1)).choices, baseline);
  const discontinuous = [choice(a, 0), choice(b, 0.2), choice(a, 0.1)];
  assert.strictEqual(repairHistoryAwareReviewSequence(discontinuous, pools(discontinuous)).choices, discontinuous);
  const malformed = pools(baseline); malformed[2].push({ candidate: c, error: measured(NaN) });
  assert.equal(repairHistoryAwareReviewSequence(baseline, malformed).diagnostics.reason, "invalid-input");
  const conflict = pools(baseline); conflict[2].push(item(photo("b", 0.1)));
  const result = repairHistoryAwareReviewSequence(baseline, conflict);
  assert.strictEqual(result.choices, baseline); assert.equal(result.diagnostics.reason, "invalid-input");
});

test("explicit work caps report incomplete exploration and cannot adopt unverified patches", () => {
  const baseline = sequence([a, b, a]), beams = pools(baseline); beams[2].push(item(c));
  for (const options of [{ maxFrames: 2 }, { maxCandidatesInspected: 0 }, { maxScoredPatches: 0 }, { maxTrials: 0 }, { maxPatches: 0 }, { maxEvents: 0 }]) {
    const result = repairHistoryAwareReviewSequence(baseline, beams, options);
    assert.strictEqual(result.choices, baseline, JSON.stringify(options));
    assert.equal(result.diagnostics.capHit, true, JSON.stringify(options));
    assert.equal(result.diagnostics.adoptedPatches, 0);
    assert.ok(result.diagnostics.candidatesInspected <= (options.maxCandidatesInspected ?? 750000));
    assert.ok(result.diagnostics.triedPatches <= (options.maxTrials ?? 128));
  }
  const longRuns = sequence([a, a, b, b, a, a]), longPools = pools(longRuns);
  longPools[4].push(item(c)); longPools[5].push(item(c));
  const result = repairHistoryAwareReviewSequence(longRuns, longPools, { maxIntervalFrames: 1 });
  assert.strictEqual(result.choices, longRuns);
  assert.ok(result.diagnostics.capReasons.includes("maxIntervalFrames"));
  assert.equal(measureReviewSequence(result.choices).recentReappearances, 1);
});
