import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { filterVideoProfileIslands, uncertainProfileAtTime } from "../app/live/video-pose-continuity.ts";

const frames = pairs => pairs.map(([time, yaw]) => ({ time, feature: [yaw / 90, 0, 0], geometry: { marker: time } }));

test("the current full-resolution browser detector's collapsed profile is rejected without changing other frames", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/fixed-video-profile-20261015.json", import.meta.url)));
  const result = filterVideoProfileIslands(fixture.frames, fixture.sampleRate);
  assert.deepEqual(result.intervals, [{ start: 4.55, end: 5.4, anchorTime: 4.5, rejectedTimes: [4.95] }]);
  assert.deepEqual(result.frames, fixture.frames.filter(frame => frame.time !== 4.95));
});

test("the fixed video's false right-facing island never enters photo selection", () => {
  const fixture = JSON.parse(readFileSync(new URL("../public/test-fixtures/reference-face-motion-analysis.json", import.meta.url)));
  const source = fixture.frames;
  const result = filterVideoProfileIslands(source, fixture.sampleRate);
  const interval = uncertainProfileAtTime(result.intervals, 5);
  assert.ok(interval);
  assert.equal(interval.anchorTime, 4.466666666666667);
  assert.equal(interval.end, 5.4);
  assert.deepEqual(interval.rejectedTimes, [5, 5.1, 5.133333333333334, 5.166666666666667]);
  assert.equal(result.frames.length, source.length - 4);
  assert.ok(result.frames.every(frame => frame.time < 5 || frame.time >= 5.4));
  assert.equal(source.length, 612, "leave the source detections and meshes unchanged");
});

test("reject either direction, preserve original trusted frames, and bound hold time", () => {
  for (const sign of [-1, 1]) {
    const source = frames([[4.4, 55*sign], [5, -60*sign], [5.1, -38*sign], [5.4, 50*sign]]);
    const result = filterVideoProfileIslands(source, 20);
    assert.deepEqual(result.frames, [source[0], source[3]]);
    assert.equal(result.frames[0], source[0]);
    assert.ok(uncertainProfileAtTime(result.intervals, 4.45));
    assert.ok(uncertainProfileAtTime(result.intervals, 5.35));
    assert.equal(uncertainProfileAtTime(result.intervals, 4.4), undefined);
    assert.equal(uncertainProfileAtTime(result.intervals, 5.4), undefined);
  }
});

test("real head turns through the front and sustained opposite profiles remain intact", () => {
  for (const pairs of [
    [[0,-50],[.05,-20],[.1,0],[.15,20],[.2,50],[.25,10],[.3,-50]],
    [[0,-50],[.5,60],[1,60],[1.6,-50]],
    [[0,-50],[.5,60],[.55,15],[.6,-50]],
    [[0,-50],[.5,60],[.55,60]],
  ]) {
    const source=frames(pairs), result=filterVideoProfileIslands(source,20);
    assert.deepEqual(result.frames,source);
    assert.deepEqual(result.intervals,[]);
  }
  const nod = frames([[0,-50],[.05,0],[.1,-50]]);
  nod[1].feature[2] = 10 / 90;
  assert.deepEqual(filterVideoProfileIslands(nod,20).frames, nod);
});
