import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/live/review-client-lite.tsx", import.meta.url), "utf8");

test("decoded-frame barrier fails closed instead of silently accepting a timeout", () => {
  assert.match(source, /function waitForDecodedVideoFrame[\s\S]*new Promise<void>\(\(resolve, reject\) =>/);
  assert.match(source, /目的フレームの描画待ちがタイムアウトしました/);
  assert.doesNotMatch(source, /const timeout = window\.setTimeout\(finish, 2_500\)/);
});

test("fixed-video analysis keeps the presentation barrier before canvas sampling", () => {
  const seek = source.indexOf("await seekVideo(video, time);");
  const barrier = source.indexOf("await waitForDecodedVideoFrame(video, time);");
  const draw = source.indexOf("context.drawImage(video, 0, 0, sourceWidth, sourceHeight);");
  const detect = source.indexOf("const result = landmarker.detect(canvas);");
  assert.ok(seek >= 0 && barrier > seek && draw > barrier && detect > draw);
});
