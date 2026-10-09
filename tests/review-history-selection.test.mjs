import assert from "node:assert/strict";
import test from "node:test";
import { optimizeDistinctProjectionSequence, projectionError } from "../app/projection-matching.ts";
import {
  reappearancePenalty, optimizeHistoryAwareProjectionSequence, measureReviewSequence,
  compareReviewSequences, selectHistoryAwareReviewSequence, REVIEW_SEQUENCE_OPTIONS,
  REVIEW_HISTORY_OPTIONS,
} from "../app/live/review-history-selection.ts";

const projection = Array.from({ length: 468 }, (_, i) => [((i % 31) - 15) / 20, (Math.floor(i / 31) - 4) / 10]).flat();
const geometry = { projection, layout: [0.5, 0.5, 0.6, 0.75], structure: Array(120).fill(0), surface: Array(600).fill(0) };
const feature = Array(55).fill(0);
const frame = time => ({ time, feature, geometry });
const photo = id => ({ id, feature, geometry });
const a = photo("a"), b = photo("b"), c = photo("c");
const measured = total => ({ ...Object.fromEntries(Object.keys(projectionError(frame(0), a)).map(key => [key, 0])), total });
const item = (candidate, total = 0) => ({ candidate, error: measured(total) });
const ids = choices => choices.map(choice => choice.candidate.id);
const history = { ...REVIEW_HISTORY_OPTIONS, weight: 0.05 };
const choice = (candidate, time, total = 0) => ({ frame: frame(time), candidate, error: measured(total), emission: total, accepted: true, expressionMotion: 0 });

test("history cost distinguishes continuous holding, first use and recent re-entry in video seconds", () => {
  const departed = new Map([["a", 0.3], ["b", 0.2]]);
  assert.equal(reappearancePenalty("a", "a", 0.4, departed, history), 0);
  assert.equal(reappearancePenalty("b", "c", 0.4, departed, history), 0);
  const initial = reappearancePenalty("b", "a", 0.3, departed, history);
  assert.equal(initial, history.weight);
  assert.ok(Math.abs(reappearancePenalty("b", "a", 1.05, departed, history) - initial / 2) < 1e-12);
  assert.equal(reappearancePenalty("b", "a", 2.3, departed, history), 0);
  assert.equal(reappearancePenalty("b", "a", 0.1, departed, history), 0);
});

test("zero weight is exactly the original selection including every numeric output", () => {
  const frames = [0, 0.05, 0.1, 0.9, 1.3].map(frame);
  const beams = frames.map((_, i) => [item(a, i % 2 ? 0.002 : 0), item(b, i % 2 ? 0 : 0.001), item(c, 0.004)]);
  const expected = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
  assert.deepEqual(optimizeHistoryAwareProjectionSequence(frames, beams, { ...history, weight: 0 }), expected);
  assert.deepEqual(selectHistoryAwareReviewSequence(frames, beams, { ...history, weight: 0 }).choices, expected);
});

test("a static best photo remains held without novelty-driven cycling", () => {
  const frames = Array.from({ length: 100 }, (_, i) => frame(i / 20));
  const beams = frames.map(() => [item(a), item(b, 0.001), item(c, 0.001)]);
  const result = optimizeHistoryAwareProjectionSequence(frames, beams, history);
  assert.deepEqual(ids(result), Array(100).fill("a"));
  assert.equal(measureReviewSequence(result).switches, 0);
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, history)), ids(result));
});

test("different histories with the same ending are not incorrectly merged", () => {
  const frames = [0, 0.1, 0.2].map(frame);
  const beams = [[item(a), item(b, 0.005)], [item(c)], [item(a)]];
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, history)), ["b", "c", "a"]);
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, { ...history, historiesPerCandidate: 1 })), ["a", "c", "a"]);
});

test("a long hold remains recent when it ends, and real timestamp gaps expire history", () => {
  const frames = [0, 0.05, 1.9, 1.95, 2].map(frame);
  const beams = [[item(a)], [item(a)], [item(a)], [item(b)], [item(a), item(c, 0.003)]];
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, history)), ["a", "a", "a", "b", "c"]);
  frames[4] = frame(4.1);
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, history)), ["a", "a", "a", "b", "a"]);
});

test("history is a soft cost and never bans the sole accurate returning photo", () => {
  const frames = [0, 0.1, 0.2].map(frame), beams = [[item(a)], [item(b)], [item(a), item(c, 0.2)]];
  assert.deepEqual(ids(optimizeHistoryAwareProjectionSequence(frames, beams, history)), ["a", "b", "a"]);
});

test("reappearance metrics compress continuous runs and include the last single-sample run", () => {
  const result = [choice(a, 0), choice(a, 0.05), choice(b, 0.1), choice(a, 0.15)];
  const m = measureReviewSequence(result);
  assert.equal(m.uniqueImages, 2); assert.equal(m.runs, 3); assert.equal(m.switches, 2);
  assert.equal(m.reappearances, 1); assert.equal(m.recentReappearances, 1);
  assert.equal(m.reappearances, m.runs - m.uniqueImages);
  assert.equal(m.singleSampleRuns, 2); assert.equal(m.reentryEvents[0].gapSeconds, 0.15 - 0.1);
});

test("quality fallback returns the exact baseline decisions when a new photo is worse", () => {
  const frames = [0, 0.1, 0.2].map(frame), beams = [[item(a)], [item(b)], [item(a), item(c, 0.004)]];
  const expected = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
  const result = selectHistoryAwareReviewSequence(frames, beams, history);
  assert.equal(result.diagnostics.adopted, false);
  assert.deepEqual(result.choices, expected);
  assert.ok(result.diagnostics.comparison.reasons.includes("per-frame-error"));
});

test("a valid near-equivalent alternative may reduce re-entry without adding switches", () => {
  const before = [choice(a, 0, 0.1), choice(b, 0.1, 0.1), choice(a, 0.2, 0.1)];
  const after = [choice(a, 0, 0.1), choice(b, 0.1, 0.1), choice(c, 0.2, 0.1001)];
  const compared = compareReviewSequences(before, after);
  assert.equal(compared.accepted, true, compared.reasons.join(","));
  assert.equal(compared.after.recentReappearances, 0);
});

test("invalid history settings or discontinuous sample times fall back deterministically", () => {
  const frames = [0, 0.1, 0.05].map(frame), beams = frames.map(() => [item(a), item(b)]);
  const expected = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
  for (const settings of [history, { ...history, halfLifeSeconds: 0 }, { ...history, weight: NaN }]) {
    assert.deepEqual(optimizeHistoryAwareProjectionSequence(frames, beams, settings), expected);
  }
});
