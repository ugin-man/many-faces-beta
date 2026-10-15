import assert from "node:assert/strict";
import test from "node:test";
import { filterVideoProfileIslands, uncertainProfileAtTime } from "../app/live/video-pose-continuity.ts";

const frames = pairs => pairs.map(([time, yaw]) => ({ time, feature: [yaw / 90, 0, 0], geometry: { marker: time } }));

test("collapsed profile with an abrupt roll is held across a detection gap", () => {
  const source = frames([[1,-55],[1.45,6],[1.9,-57],[2,-58]]);
  source[1].feature[2] = 60 / 90;
  const result = filterVideoProfileIslands(source,20);
  assert.deepEqual(result.frames,[source[0],source[2],source[3]]);
  assert.deepEqual(result.intervals,[{start:1.05,end:1.9,anchorTime:1,rejectedTimes:[1.45]}]);
  assert.equal(uncertainProfileAtTime(result.intervals,1.5)?.anchorTime,1);
});

test("several false opposite-profile detections form one protected interval", () => {
  const source = frames([[1,-55],[1.5,45],[1.6,37],[1.65,35],[1.7,33],[1.95,-57]]);
  const result = filterVideoProfileIslands(source,30);
  assert.deepEqual(result.frames,[source[0],source[5]]);
  assert.deepEqual(result.intervals,[{start:1+1/30,end:1.95,anchorTime:1,rejectedTimes:[1.5,1.6,1.65,1.7]}]);
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
