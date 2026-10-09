// Exploratory follow-up after the four predeclared weights failed quality gates.
// Usage: node --experimental-strip-types scripts/analyze-history-feasibility.mjs SNAPSHOT.json.gz OUTPUT.json
// Reuses captured inputs; never edits catalog data, app code or acceptance budgets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { optimizeDistinctProjectionSequence } from '../app/projection-matching.ts';
import {
  optimizeHistoryAwareProjectionSequence, compareReviewSequences, REVIEW_SEQUENCE_OPTIONS,
  REVIEW_HISTORY_OPTIONS, REVIEW_HISTORY_QUALITY_BUDGET as budget,
} from '../app/live/review-history-selection.ts';

assert(process.argv[2] && process.argv[3], 'Provide the captured snapshot and output JSON paths');
const bytes = await fs.readFile(process.argv[2]);
const snapshot = JSON.parse(gunzipSync(bytes).toString(), (_key, value) =>
  value?.__typed === 'Float32Array' ? new Float32Array(value.data) : value?.__typed === 'Float64Array' ? new Float64Array(value.data) : value);
const { frames, candidates } = snapshot;
const beams = snapshot.beams.map(beam => beam.map(item => ({ candidate: candidates[item.index], error: item.error })));
const original = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
const localKeys = ['mouth', 'mouthShape', 'eyes', 'leftEye', 'rightEye', 'brows', 'wink', 'blink', 'worstLocal'];
const poseKeys = ['yawDegrees', 'pitchDegrees', 'rollDegrees'];
const constrained = beams.map((beam, index) => beam.filter(item =>
  item.error.total <= original[index].error.total + budget.maximumFrameErrorIncrease &&
  localKeys.every(key => item.error[key] <= original[index].error[key] + budget.maximumLocalErrorIncrease) &&
  poseKeys.every(key => Math.abs(item.error[key]) <= Math.abs(original[index].error[key]) + budget.maximumPoseIncreaseDegrees)));
assert(constrained.every((beam, index) => beam.some(item => item.candidate === original[index].candidate)), 'Always retain the baseline candidate');
const report = {
  exploratory: true, baselineCommit: '04a41b80469980454758feba9a31ac48b92c11fd',
  snapshotSha256: createHash('sha256').update(bytes).digest('hex'), budget,
  frames: frames.length, candidates: candidates.length,
  admissibleCandidates: { minimum: Math.min(...constrained.map(beam => beam.length)),
    mean: constrained.reduce((sum, beam) => sum + beam.length, 0) / frames.length,
    framesWithAlternatives: constrained.filter(beam => beam.length > 1).length },
  variants: [],
};
for (const historiesPerCandidate of [1, 2]) for (const weight of [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1]) {
  const options = { ...REVIEW_HISTORY_OPTIONS, weight, historiesPerCandidate };
  const choices = optimizeHistoryAwareProjectionSequence(frames, constrained, options);
  const comparison = compareReviewSequences(original, choices);
  report.variants.push({ options, accepted: comparison.accepted, reasons: comparison.reasons,
    changedFrames: choices.filter((choice, index) => choice.candidate.id !== original[index].candidate.id).length,
    uniqueImages: comparison.after.uniqueImages, reappearances: comparison.after.reappearances,
    recentReappearances: comparison.after.recentReappearances, switches: comparison.after.switches,
    error: comparison.after.error, continuity: comparison.after.continuity, expressionMotion: comparison.after.expressionMotion,
    maximumFrameErrorIncrease: comparison.maximumFrameErrorIncrease,
    maximumLocalErrorIncrease: comparison.maximumLocalErrorIncrease,
    maximumPoseIncreaseDegrees: comparison.maximumPoseIncreaseDegrees });
}
// A small admissible set can be enumerated exactly. Ignoring all aggregate and
// motion gates makes this a superset of acceptable paths, so its count minima
// are lower bounds for any selector restricted to these beams and frame caps.
const variableFrames = constrained.flatMap((beam, index) => beam.length > 1 ? [index] : []);
const combinations = variableFrames.reduce((product, index) => product * constrained[index].length, 1);
report.exhaustive = { combinations, performed: combinations <= 100000,
  ignoresAggregateAndMotionGates: true, scope: 'captured ranked beams under unchanged per-frame budgets' };
if (report.exhaustive.performed) {
  const ids = original.map(choice => choice.candidate.id), histogram = {};
  let checked = 0, minimumRecentReappearances = Infinity, minimumReappearances = Infinity, minimumSwitches = Infinity;
  const visit = depth => {
    if (depth < variableFrames.length) {
      const index = variableFrames[depth];
      for (const item of constrained[index]) { ids[index] = item.candidate.id; visit(depth + 1); }
      return;
    }
    const seen = new Set(), departed = new Map();
    let previous = null, recent = 0, returns = 0, switches = 0;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index], time = frames[index].time;
      if (id === previous) continue;
      if (previous !== null) { departed.set(previous, time); switches++; }
      if (seen.has(id)) {
        returns++;
        if (time < departed.get(id) + REVIEW_HISTORY_OPTIONS.windowSeconds) recent++;
      }
      seen.add(id); previous = id;
    }
    checked++; histogram[recent] = (histogram[recent] ?? 0) + 1;
    minimumRecentReappearances = Math.min(minimumRecentReappearances, recent);
    minimumReappearances = Math.min(minimumReappearances, returns);
    minimumSwitches = Math.min(minimumSwitches, switches);
  };
  visit(0); assert.equal(checked, combinations);
  Object.assign(report.exhaustive, { checked, minimumRecentReappearances, minimumReappearances, minimumSwitches, recentHistogram: histogram });
}
await fs.writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log('HISTORY_FEASIBILITY ' + JSON.stringify(report));
