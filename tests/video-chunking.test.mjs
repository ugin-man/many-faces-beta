import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisChunks } from "../app/video-chunking.ts";

test("a five second video stays in one analysis chunk", () => {
  const chunks = buildAnalysisChunks(5, 30);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].sampleCount, 151);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, 5);
});

test("long videos are covered once across consecutive five second chunks", () => {
  const chunks = buildAnalysisChunks(12.2, 30);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(({ start, end }) => [start, end]), [
    [0, 5],
    [5, 10],
    [10, 12.2],
  ]);
  assert.equal(chunks[0].lastSampleIndexExclusive, chunks[1].firstSampleIndex);
  assert.equal(chunks[1].lastSampleIndexExclusive, chunks[2].firstSampleIndex);
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.sampleCount, 0),
    Math.floor(12.2 * 30) + 1,
  );
});

test("invalid video metadata produces no chunks", () => {
  assert.deepEqual(buildAnalysisChunks(Number.NaN, 30), []);
  assert.deepEqual(buildAnalysisChunks(5, 0), []);
});
