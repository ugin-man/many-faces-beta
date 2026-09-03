import assert from "node:assert/strict";
import test from "node:test";
import {
  processingSecondsPerOutputSecond,
  quantizeReviewTime,
  reviewIndexAtTime,
  reviewItemAtTime,
  sourceGapEstimate,
} from "../app/live/review-timeline.ts";

const timeline = [
  { time: 0, id: "a" },
  { time: 0.1, id: "b" },
  { time: 0.2, id: "c" },
  { time: 0.3, id: "d" },
];

test("review playback holds the latest processed choice at or before the source time", () => {
  assert.equal(reviewIndexAtTime(timeline, 0), 0);
  assert.equal(reviewIndexAtTime(timeline, 0.199), 1);
  assert.equal(reviewIndexAtTime(timeline, 0.3), 3);
  assert.equal(reviewItemAtTime(timeline, 0.249)?.id, "c");
});

test("review cadence quantizes wall-clock playback without changing processing order", () => {
  assert.equal(quantizeReviewTime(0.099, 12, 5), 1 / 12);
  assert.equal(quantizeReviewTime(6, 20, 5), 5);
  assert.equal(quantizeReviewTime(-1, 30, 5), 0);
});

test("processing ratio answers how long one output second costs", () => {
  assert.equal(processingSecondsPerOutputSecond(20_000, 5), 4);
  assert.equal(processingSecondsPerOutputSecond(0, 5), 0);
  assert.equal(processingSecondsPerOutputSecond(20_000, 0), 0);
});

test("camera timestamp gaps report probable missing source frames", () => {
  assert.equal(sourceGapEstimate(null, 0, 30), 0);
  assert.equal(sourceGapEstimate(0, 1 / 30, 30), 0);
  assert.equal(sourceGapEstimate(0, 4 / 30, 30), 3);
});
