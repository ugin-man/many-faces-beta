import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../public/test-fixtures/reference-face-motion.mp4",
  import.meta.url,
);
const analysisUrl = new URL(
  "../public/test-fixtures/reference-face-motion-analysis.json",
  import.meta.url,
);
const rankingsUrl = new URL(
  "../public/test-fixtures/reference-face-motion-rankings.json",
  import.meta.url,
);
const manifestUrl = new URL("../public/seed-catalog/manifest.json", import.meta.url);

test("bundles the reusable face-motion verification video", async () => {
  const [metadata, analysisMetadata, rankingsMetadata, header, source, analysis, rankings, manifest] = await Promise.all([
    stat(fixtureUrl),
    stat(analysisUrl),
    stat(rankingsUrl),
    readFile(fixtureUrl).then((bytes) => bytes.subarray(0, 12)),
    readFile(new URL("../app/offline-video-lab.tsx", import.meta.url), "utf8"),
    readFile(analysisUrl, "utf8").then(JSON.parse),
    readFile(rankingsUrl, "utf8").then(JSON.parse),
    readFile(manifestUrl, "utf8").then(JSON.parse),
  ]);
  assert.ok(metadata.size > 1_000_000);
  assert.ok(analysisMetadata.size > 1_000_000);
  assert.ok(rankingsMetadata.size > 100_000);
  assert.equal(header.subarray(4, 8).toString("ascii"), "ftyp");
  assert.match(source, /\/test-fixtures\/reference-face-motion\.mp4/);
  assert.match(source, /固定検証動画を開く（解析済み）/);
  assert.ok(analysis.frames.length >= 600);
  assert.ok(analysis.frames.every((frame) => frame.feature.length === 55));
  assert.equal(rankings.frameTimes.length, analysis.frames.length);
  assert.ok(
    rankings.catalogId === manifest.catalogId || manifest.totalFaces >= 70_000,
    "ranking cache must match the bundled catalog or trigger the full-catalog fallback",
  );
  assert.equal(rankings.schemaVersion, 2);
  assert.equal(rankings.indexBytes, 4);
  assert.ok(Object.values(rankings.beams).every((frames) => frames.length === analysis.frames.length));
  assert.equal(
    Buffer.from(rankings.sequences.strict, "base64").byteLength / rankings.indexBytes,
    analysis.frames.length,
  );
});
