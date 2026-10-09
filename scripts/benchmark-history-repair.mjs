// Same-input replay for the bounded local history repair experiment.
// Usage: node --experimental-strip-types scripts/benchmark-history-repair.mjs
//        ORIGINAL_SNAPSHOT.json.gz OUTPUT.json [FULL_CATALOG_FEASIBLE.json.gz]
// Full-catalog feasibility is offline exploration, not a free runtime input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { optimizeDistinctProjectionSequence } from '../app/projection-matching.ts';
import { repairHistoryAwareReviewSequence } from '../app/live/review-history-repair.ts';
import {
  compareReviewSequences, measureReviewSequence, REVIEW_SEQUENCE_OPTIONS,
  REVIEW_HISTORY_QUALITY_BUDGET,
} from '../app/live/review-history-selection.ts';

const [snapshotPath, outputPath, expandedPath] = process.argv.slice(2);
assert(snapshotPath && outputPath, 'Provide the original captured snapshot and output paths');
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const revive = (_key, value) => value?.__typed === 'Float32Array' ? new Float32Array(value.data)
  : value?.__typed === 'Float64Array' ? new Float64Array(value.data) : value;
const readSnapshot = file => {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(gunzipSync(bytes).toString(), revive);
  return { ...value, bytesSha256: sha(bytes), ranked: value.beams.map(beam => beam.map(item => ({ candidate: value.candidates[item.index], error: item.error }))) };
};
const decisions = choices => choices.map(c => ({ id: c.candidate.id, time: c.frame.time, error: c.error,
  emission: c.emission, accepted: c.accepted, expressionMotion: c.expressionMotion }));
const median = values => { const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; };
const snapshot = readSnapshot(snapshotPath);
const { frames, ranked: beams } = snapshot;
const videoSha = sha(fs.readFileSync('public/test-fixtures/reference-face-motion.mp4'));
const manifestBytes = fs.readFileSync('public/seed-catalog/manifest.json');
const manifest = JSON.parse(manifestBytes);
assert.equal(videoSha, 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b');
assert.equal(sha(manifestBytes), 'fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a');
assert.equal(manifest.totalFaces, 70000); assert.equal(manifest.searchableFaces, 70000); assert.equal(manifest.poseStep, 3);
const original = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
const capturedPath = path.join(path.dirname(snapshotPath), 'baseline-capture.json');
assert(fs.existsSync(capturedPath), 'Keep the original browser decision receipt beside the snapshot');
const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));
assert.deepEqual(decisions(original), captured.choices, 'Replay must exactly match the prior browser capture');
const originalBytes = JSON.stringify(decisions(original));
const sets = [{ name: 'original-ranked-beams', ranked: beams, candidateRecords: snapshot.candidates.length,
  uniqueCandidateIds: new Set(snapshot.candidates.map(candidate => candidate.id)).size,
  includesAdditionalCandidatePreparation: true, note: 'Complete sequence selection after capture and ranking. Repair uses the existing ranked beams and requires no additional candidate preparation. Video decoding and original candidate ranking are excluded from both timings.' }];
if (expandedPath) {
  const expanded = readSnapshot(expandedPath);
  assert.deepEqual(expanded.frames, frames, 'Full-catalog feasibility must use identical source frames');
  sets.push({ name: 'full-catalog-feasible-beams', ranked: expanded.ranked, candidateRecords: expanded.candidates.length,
    uniqueCandidateIds: new Set(expanded.candidates.map(candidate => candidate.id)).size,
    snapshotSha256: expanded.bytesSha256, includesAdditionalCandidatePreparation: false,
    note: 'Offline feasibility experiment. This selector timing excludes the full 70,000-photo decode and feasibility scan; it is not end-to-end video time.' });
}
const report = {
  schemaVersion: 1, experiment: 'baseline-preserving-local-history-repair', startedAt: new Date().toISOString(),
  baselineCommit: '04a41b80469980454758feba9a31ac48b92c11fd',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFilesSha256: Object.fromEntries(['app/live/review-history-repair.ts', 'app/live/review-history-selection.ts',
    'app/projection-matching.ts', 'scripts/benchmark-history-repair.mjs'].map(file => [file, sha(fs.readFileSync(file))])),
  node: process.version, platform: process.platform, architecture: process.arch,
  fixtureSha256: videoSha, catalogManifestSha256: sha(manifestBytes), catalogId: manifest.catalogId,
  totalFaces: manifest.totalFaces, poseStep: manifest.poseStep, snapshotSha256: snapshot.bytesSha256,
  samplingFps: 20, plannedFrames: captured.plannedFrames, includesVideoDecodeAndCandidateRanking: false,
  frames: frames.length, baselineChoicesSha256: sha(originalBytes), baseline: measureReviewSequence(original),
  qualityBudget: REVIEW_HISTORY_QUALITY_BUDGET, variants: [],
  freshVideoInference: false, browserVerifiedThisRun: false, physicalCameraVerified: false,
  adoptionAccepted: false, reason: 'pending-quality-comparison',
};

for (const set of sets) {
  const result = repairHistoryAwareReviewSequence(original, set.ranked);
  assert.equal(result.diagnostics.invalidReason, null, 'Benchmark must exercise valid repair input');
  assert.equal(result.diagnostics.capHit, false, 'The complete fixed-video repair must fit within its work caps');
  const comparison = compareReviewSequences(original, result.choices);
  const expected = decisions(result.choices);
  assert.deepEqual(decisions(repairHistoryAwareReviewSequence(original, set.ranked).choices), expected, 'Deterministic local repair');
  assert.equal(JSON.stringify(decisions(original)), originalBytes, 'Repair must not mutate the baseline');
  if (!comparison.accepted) assert.strictEqual(result.choices, original, 'Failed quality gate preserves the original array');
  const run = mode => {
    if (mode === 'repairOnly') return repairHistoryAwareReviewSequence(original, set.ranked).choices;
    const baseline = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
    return mode === 'baseline' ? baseline : repairHistoryAwareReviewSequence(baseline, set.ranked).choices;
  };
  for (const mode of ['baseline', 'candidate', 'repairOnly']) run(mode);
  const timings = [];
  // Interleave order on one idle process. No parsing, hashing or assertions
  // occur inside the timed selector call. Both complete modes include baseline.
  for (const [index, mode] of ['baseline', 'candidate', 'repairOnly', 'candidate', 'baseline', 'repairOnly',
    'candidate', 'baseline', 'repairOnly', 'baseline', 'candidate', 'repairOnly',
    'baseline', 'candidate', 'repairOnly', 'candidate', 'baseline', 'repairOnly'].entries()) {
    const start = performance.now(); const choices = run(mode); const elapsedMs = performance.now() - start;
    assert.deepEqual(decisions(choices), mode === 'baseline' ? decisions(original) : expected);
    timings.push({ index, mode, elapsedMs });
  }
  const medianMs = Object.fromEntries(['baseline', 'candidate', 'repairOnly'].map(mode => [mode, median(timings.filter(t => t.mode === mode).map(t => t.elapsedMs))]));
  const row = { name: set.name, candidateRecords: set.candidateRecords, uniqueCandidateIds: set.uniqueCandidateIds,
    snapshotSha256: set.snapshotSha256,
    includesAdditionalCandidatePreparation: set.includesAdditionalCandidatePreparation, timingScope: set.note,
    accepted: comparison.accepted, reasons: comparison.reasons,
    before: comparison.before, after: comparison.after, diagnostics: result.diagnostics,
    changedFrames: result.choices.flatMap((choice, index) => choice.candidate.id === original[index].candidate.id ? [] : [{ index, time: choice.frame.time, beforeId: original[index].candidate.id, afterId: choice.candidate.id }]),
    maximumFrameErrorIncrease: comparison.maximumFrameErrorIncrease,
    maximumLocalErrorIncrease: comparison.maximumLocalErrorIncrease,
    maximumPoseIncreaseDegrees: comparison.maximumPoseIncreaseDegrees,
    choicesSha256: sha(expected), timings, medianMs,
    selectorOverheadPercent: (medianMs.candidate / medianMs.baseline - 1) * 100 };
  report.variants.push(row);
  console.log(JSON.stringify({ variant: row.name, accepted: row.accepted, reasons: row.reasons,
    uniqueImages: row.after.uniqueImages, reappearances: row.after.reappearances,
    recentReappearances: row.after.recentReappearances, changedFrames: row.changedFrames.length, medianMs }));
}
report.reason = report.variants.some(row => row.accepted) ? 'quality-candidate-needs-full-video-verification' : 'no-quality-passing-reappearance-reduction';
report.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
