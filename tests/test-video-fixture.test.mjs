import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { isRetiredAsset, retiredAssetResponse } from "../worker/retired-assets.ts";

test("the distributed sample is the reviewed 1061-frame composite", async () => {
  const base = new URL("../public/demo/", import.meta.url);
  const bytes = await readFile(new URL("many-faces-sample-30fps.mp4", base));
  const meta = JSON.parse(await readFile(new URL("sample.json", base), "utf8"));
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.sha256);
  assert.equal(bytes.length, meta.bytes);
  assert.equal(meta.fps,30); assert.equal(meta.frames,1061);
  assert.equal(meta.durationSeconds,meta.frames/meta.fps);
  assert.equal(meta.fullFrameHolds,0);
  assert.equal(meta.consecutiveIdenticalFrames,0);
  assert.equal(meta.renderMethod,"sequential-decoded-frames-v1");
  assert.equal(meta.sourceVideoIncluded,false); assert.equal(meta.audio,false);
  const fixtures = await readdir(new URL("../public/test-fixtures/",import.meta.url)).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e));
  assert.deepEqual(fixtures,[],"private fixture directory must stay empty");
});

test("retired video and geometry URLs cannot be fetched directly or through image optimization", () => {
  for (const path of ["/test-fixtures/reference-face-motion.mp4", "/test-fixtures/reference-face-motion-analysis.json", "/test-fixtures/reference-face-motion-rankings.json", "/%74est-fixtures/reference-face-motion.mp4", "/IMG_3665.mp4"]) assert.equal(isRetiredAsset(path),true);
  for (const path of ["/demo/many-faces-sample-30fps.mp4", "/demo/poster.webp", "/seed-catalog/manifest.json"]) assert.equal(isRetiredAsset(path),false);
  assert.equal(retiredAssetResponse().status,410);
  assert.equal(retiredAssetResponse().headers.get("cache-control"),"no-store");
});
