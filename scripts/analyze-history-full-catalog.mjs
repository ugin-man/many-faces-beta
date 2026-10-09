#!/usr/bin/env node
/**
 * Exhaustive descriptor feasibility audit for the fixed video, not a benchmark.
 *
 * Usage (Node >= 22.13):
 * node --experimental-strip-types scripts/analyze-history-full-catalog.mjs \
 *   SNAPSHOT.json.gz OUTPUT_DIRECTORY [BASELINE_CAPTURE.json]
 *
 * Reads one catalog shard at a time, applies the unchanged per-frame gates,
 * and retains only admissible candidates. Does not edit app code or the catalog.
 * The saved gzip has the original snapshot's frames/candidates/beams layout.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { liveCandidateFromEntry } from '../app/live-matching.ts';
import { optimizeDistinctProjectionSequence, projectionError } from '../app/projection-matching.ts';
import {
  measureReviewSequence, REVIEW_SEQUENCE_OPTIONS,
  REVIEW_HISTORY_OPTIONS, REVIEW_HISTORY_QUALITY_BUDGET as budget,
} from '../app/live/review-history-selection.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogRoot = path.join(repo, 'public/seed-catalog');
const expected = Object.freeze({
  baselineCommit: '04a41b80469980454758feba9a31ac48b92c11fd',
  fixtureSha256: 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b',
  manifestSha256: 'fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a',
  catalogTree: 'afcb8f68a8db87424fe5169896be0fd0a57dbf65',
  catalogId: 'many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1',
  totalFaces: 70000, poseStep: 3, cells: 775,
});
const expectedBudget = {
  meanRelative: 0.0025, p95Relative: 0.005, maximumFrameErrorIncrease: 0.003,
  maximumLocalErrorIncrease: 0.003, maximumPoseIncreaseDegrees: 0.5,
  motionMeanRelative: 0.005, motionP95Relative: 0.01,
};
const enumerationCap = 1_000_000;
const localKeys = ['mouth', 'mouthShape', 'eyes', 'leftEye', 'rightEye', 'brows', 'wink', 'blink', 'worstLocal'];
const poseKeys = ['yawDegrees', 'pitchDegrees', 'rollDegrees'];
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
}).trim();
const reviver = (_key, value) => value?.__typed === 'Float32Array' ? new Float32Array(value.data) :
  value?.__typed === 'Float64Array' ? new Float64Array(value.data) : value;
const replacer = (_key, value) => value instanceof Float32Array ? { __typed: 'Float32Array', data: Array.from(value) } :
  value instanceof Float64Array ? { __typed: 'Float64Array', data: Array.from(value) } : value;
const safeFile = name => {
  assert(typeof name === 'string' && /^[a-z0-9_.+-]+$/i.test(name) && name !== '.' && name !== '..', `Unsafe shard filename: ${name}`);
  return path.join(catalogRoot, 'shards', name);
};
const maximumDifference = (left, right) => {
  assert.equal(left.length, right.length, 'Descriptor dimensions differ');
  let maximum = 0;
  for (let index = 0; index < left.length; index++) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
};
const errorDeltas = (error, original) => ({
  total: error.total - original.total,
  local: Math.max(...localKeys.map(key => error[key] - original[key])),
  pose: Math.max(...poseKeys.map(key => Math.abs(error[key]) - Math.abs(original[key]))),
});
const allowed = (error, original) => error.total - original.total <= budget.maximumFrameErrorIncrease &&
  localKeys.every(key => error[key] - original[key] <= budget.maximumLocalErrorIncrease) &&
  poseKeys.every(key => Math.abs(error[key]) - Math.abs(original[key]) <= budget.maximumPoseIncreaseDegrees);

function enumerateCounts(baseline, beams, windowSeconds) {
  const variables = beams.flatMap((beam, index) => beam.length > 1 ? [index] : []);
  const exactCombinations = variables.reduce((product, index) => product * BigInt(beams[index].length), 1n);
  const output = {
    scope: 'All full-catalog sequences satisfying unchanged per-frame caps; aggregate and motion gates are omitted.',
    ignoresAggregateAndMotionGates: true, variableFrames: variables.length,
    combinations: exactCombinations <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exactCombinations) : exactCombinations.toString(),
    enumerationCap, performed: exactCombinations <= BigInt(enumerationCap),
  };
  if (!output.performed) return output;
  const originalIds = baseline.map(choice => choice.candidate.id), ids = [...originalIds];
  const histogram = {};
  let checked = 0, minimumRecentReappearances = Infinity, minimumReappearances = Infinity, minimumSwitches = Infinity, best = null;
  const visit = depth => {
    if (depth < variables.length) {
      const index = variables[depth];
      for (const item of beams[index]) { ids[index] = item.candidate.id; visit(depth + 1); }
      return;
    }
    const seen = new Set(), departed = new Map();
    let previous = null, recent = 0, returns = 0, switches = 0;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index], time = baseline[index].frame.time;
      if (id === previous) continue;
      if (previous !== null) { switches++; departed.set(previous, time); }
      if (seen.has(id)) {
        returns++;
        if (time < departed.get(id) + windowSeconds) recent++;
      }
      seen.add(id); previous = id;
    }
    checked++; histogram[recent] = (histogram[recent] ?? 0) + 1;
    minimumRecentReappearances = Math.min(minimumRecentReappearances, recent);
    minimumReappearances = Math.min(minimumReappearances, returns);
    minimumSwitches = Math.min(minimumSwitches, switches);
    const score = [recent, returns, switches];
    if (!best || score.some((value, index) => value < best.score[index] && score.slice(0, index).every((value, offset) => value === best.score[offset]))) {
      best = { score, uniqueImages: seen.size, changedFrames: variables.filter(index => ids[index] !== originalIds[index]) };
    }
  };
  visit(0);
  assert.equal(checked, Number(exactCombinations));
  return { ...output, checked, minimumRecentReappearances, minimumReappearances, minimumSwitches, recentHistogram: histogram, bestCountsExample: best };
}

function runEvidence(baseline, beams) {
  const runs = [], frameRuns = [];
  for (let index = 0; index < baseline.length; index++) {
    const id = baseline[index].candidate.id;
    if (runs.length && runs.at(-1).id === id) runs.at(-1).end = index;
    else runs.push({ index: runs.length, start: index, end: index, id, time: baseline[index].frame.time });
    frameRuns[index] = runs.length - 1;
  }
  const common = (start, end, except) => beams[start].filter(item => item.candidate.id !== except &&
    beams.slice(start + 1, end + 1).every(beam => beam.some(next => next.candidate.id === item.candidate.id))).map(item => item.candidate.id);
  const previousRun = new Map(), reentries = [];
  for (const run of runs) {
    const previous = previousRun.get(run.id);
    if (previous) {
      const departed = baseline[previous.end + 1].frame.time;
      const gapSeconds = run.time - departed;
      reentries.push({ runIndex: run.index, start: run.start, end: run.end, time: run.time, id: run.id,
        previousRunIndex: previous.index, previousStart: previous.start, previousEnd: previous.end,
        gapSeconds, recent: gapSeconds >= 0 && run.time < departed + REVIEW_HISTORY_OPTIONS.windowSeconds,
        entryAlternatives: beams[run.start].filter(item => item.candidate.id !== run.id).map(item => item.candidate.id),
        commonAlternativesAcrossRun: common(run.start, run.end, run.id),
        commonAlternativesAcrossPreviousRun: common(previous.start, previous.end, run.id),
        gapFrames: run.start - previous.end - 1,
        couldHoldReturningPhotoThroughGap: beams.slice(previous.end + 1, run.start).every(beam => beam.some(item => item.candidate.id === run.id)),
      });
    }
    previousRun.set(run.id, run);
  }
  return { runs, frameRuns, reentries };
}

async function main() {
  assert(process.argv[2] && process.argv[3], 'Provide snapshot and output directory paths');
  const snapshotPath = path.resolve(process.argv[2]), outputDirectory = path.resolve(process.argv[3]);
  const capturePath = path.resolve(process.argv[4] ?? path.join(path.dirname(snapshotPath), 'baseline-capture.json'));
  await fs.mkdir(outputDirectory, { recursive: true });
  const save = (name, payload) => fs.writeFile(path.join(outputDirectory, name), JSON.stringify(payload, null, 2) + '\n');
  const report = {
    schemaVersion: 1, exploratory: true, completed: false, adoptionAccepted: false,
    startedAt: new Date().toISOString(), baselineCommit: expected.baselineCommit, commit: git('rev-parse', 'HEAD'),
    scope: 'All 70000 original catalog descriptors at every fixed-video detected frame under the unchanged per-frame gates.',
    benchmark: false, catalogImagesDecoded: false, physicalCameraVerified: false, hostedSiteVerified: false,
    limits: [
      'This is exhaustive descriptor feasibility, not a browser speed benchmark or subjective image-quality score.',
      'Only per-frame caps define the saved beams; a selected sequence must additionally pass unchanged aggregate, continuity and speed gates.',
      'No source video frames, sampling density, catalog data, UI, Worker or realtime code are modified.',
    ],
    budget, checks: [], failures: [],
  };
  try {
    assert.deepEqual(budget, expectedBudget, 'The original quality caps must not change');
    const [snapshotBytes, captureBytes, manifestBytes, fixtureBytes] = await Promise.all([
      fs.readFile(snapshotPath), fs.readFile(capturePath),
      fs.readFile(path.join(catalogRoot, 'manifest.json')),
      fs.readFile(path.join(repo, 'public/test-fixtures/reference-face-motion.mp4')),
    ]);
    report.snapshotSha256 = hash(snapshotBytes); report.baselineCaptureSha256 = hash(captureBytes);
    report.manifestSha256 = hash(manifestBytes); report.fixtureSha256 = hash(fixtureBytes);
    assert.equal(report.manifestSha256, expected.manifestSha256, 'The 70000-photo manifest must be unchanged');
    assert.equal(report.fixtureSha256, expected.fixtureSha256, 'The full original 23.3-second video must be unchanged');
    report.catalogTree = git('rev-parse', 'HEAD:public/seed-catalog');
    assert.equal(report.catalogTree, expected.catalogTree, 'The original full catalog tree must be unchanged');
    git('diff', '--exit-code', 'HEAD', '--', 'public/seed-catalog', 'public/test-fixtures/reference-face-motion.mp4');
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.catalogId, expected.catalogId);
    assert.equal(manifest.totalFaces, expected.totalFaces);
    assert.equal(manifest.sourceFaces, expected.totalFaces);
    assert.equal(manifest.searchableFaces, expected.totalFaces);
    assert.equal(manifest.poseStep, expected.poseStep);
    assert.equal(Object.keys(manifest.cells).length, expected.cells);
    report.catalogId = manifest.catalogId; report.poseStep = manifest.poseStep;
    report.checks.push('Exact original manifest, video and catalog tree; clean tracked catalog/video files; unchanged quality budget.');
    report.sourceSha256 = {};
    for (const source of ['app/live-matching.ts', 'app/projection-matching.ts', 'app/face-actions.ts', 'app/fixed-candidate-search.ts', 'app/live/review-history-selection.ts', 'scripts/analyze-history-full-catalog.mjs']) {
      report.sourceSha256[source] = hash(await fs.readFile(path.join(repo, source)));
    }

    const snapshot = JSON.parse(gunzipSync(snapshotBytes).toString(), reviver);
    const capture = JSON.parse(captureBytes);
    const frames = snapshot.frames;
    assert(frames.length > 0 && frames.length === snapshot.beams.length);
    assert(frames.every((frame, index) => Number.isFinite(frame.time) && frame.time >= 0 && (index === 0 || frame.time > frames[index - 1].time)));
    const snapshotById = new Map(), snapshotDuplicateReferences = [];
    for (const candidate of snapshot.candidates) {
      const previous = snapshotById.get(candidate.id);
      if (previous) {
        assert.deepEqual(candidate.feature, previous.feature, `Duplicate snapshot ID has different features: ${candidate.id}`);
        assert.deepEqual(candidate.geometry, previous.geometry, `Duplicate snapshot ID has different geometry: ${candidate.id}`);
        snapshotDuplicateReferences.push({ id: candidate.id, firstShard: previous.shard, duplicateShard: candidate.shard });
      } else snapshotById.set(candidate.id, candidate);
    }
    report.snapshotDuplicateReferences = snapshotDuplicateReferences;
    const originalBeams = snapshot.beams.map(beam => beam.map(item => ({ candidate: snapshot.candidates[item.index], error: item.error })));
    const baseline = optimizeDistinctProjectionSequence(frames, originalBeams, REVIEW_SEQUENCE_OPTIONS);
    assert.equal(baseline.length, frames.length);
    assert.equal(capture.choices.length, baseline.length);
    let maximumSnapshotBaselineScoreDifference = 0;
    for (let index = 0; index < baseline.length; index++) {
      const choice = baseline[index], recorded = capture.choices[index];
      assert.equal(choice.candidate.id, recorded.id, `Original optimizer ID differs at frame ${index}`);
      assert.equal(choice.frame.time, recorded.time);
      assert.deepEqual(choice.error, recorded.error, `Original optimizer error differs at frame ${index}`);
      const recomputed = projectionError(choice.frame, choice.candidate);
      for (const key of Object.keys(choice.error)) {
        maximumSnapshotBaselineScoreDifference = Math.max(maximumSnapshotBaselineScoreDifference, Math.abs(recomputed[key] - choice.error[key]));
      }
    }
    assert.equal(maximumSnapshotBaselineScoreDifference, 0, 'Recomputed snapshot baseline scores must be exactly identical');
    report.frames = frames.length; report.snapshotCandidateRecords = snapshot.candidates.length;
    report.snapshotUniqueCandidates = snapshotById.size;
    report.maximumSnapshotBaselineScoreDifference = maximumSnapshotBaselineScoreDifference;
    report.baseline = measureReviewSequence(baseline);
    report.checks.push('Original optimizer exactly reproduces every captured baseline ID/time/error; all baseline score components recompute with zero difference.');

    const framePoseCaps = baseline.map(choice => poseKeys.map(key => Math.abs(choice.error[key])));
    const ids = new Set(), addresses = new Set(), shardFiles = new Set(), snapshotFound = new Set();
    const retained = new Map(), beams = frames.map(() => []), shardInventory = [];
    let entries = 0, decoded = 0, descriptorDecodeFailures = 0, invalidRecords = 0, duplicateIds = 0, duplicateAddresses = 0;
    let poseFilteredPairs = 0, fullScoreEvaluations = 0, admittedPairs = 0;
    let maximumSnapshotDescriptorDifference = 0, maximumCatalogBaselineScoreDifference = 0, verifiedCatalogBaselineFrames = 0;
    const decodeFailureSamples = [], invalidRecordSamples = [];
    const shardDigest = createHash('sha256');
    const orderedCells = Object.entries(manifest.cells).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [cellKey, cell] of orderedCells) {
      let cellEntries = 0;
      for (const filename of cell.shards ?? [cell.shard]) {
        assert(!shardFiles.has(filename), `Duplicate manifest shard reference: ${filename}`);
        shardFiles.add(filename);
        let bytes, storageName = filename;
        try { bytes = await fs.readFile(safeFile(filename)); }
        catch (error) {
          if (error.code !== 'ENOENT' || filename.endsWith('.gz')) throw error;
          storageName = `${filename}.gz`; bytes = await fs.readFile(safeFile(storageName));
        }
        const uncompressed = storageName.endsWith('.gz') ? gunzipSync(bytes) : bytes;
        const shard = JSON.parse(uncompressed);
        assert(Array.isArray(shard.items), `Invalid shard shape: ${filename}`);
        assert.equal(shard.cell, cellKey, `Shard cell differs: ${filename}`);
        const sha256 = hash(uncompressed);
        shardInventory.push({ file: filename, storedAs: storageName, sha256, bytes: bytes.length, uncompressedBytes: uncompressed.length, entries: shard.items.length });
        shardDigest.update(filename).update('\0').update(sha256).update('\n');
        for (const entry of shard.items) {
          entries++; cellEntries++;
          if (ids.has(entry.id)) duplicateIds++;
          ids.add(entry.id);
          const address = entry.image ? `image:${entry.image}` : `pack:${entry.pack}:${entry.offset}:${entry.length}`;
          if (addresses.has(address)) duplicateAddresses++;
          addresses.add(address);
          if (typeof entry.id !== 'string' || !entry.id || !Array.isArray(entry.feature) || entry.feature.length !== manifest.featureLength ||
            !entry.feature.every(Number.isFinite) || !Array.isArray(entry.layout) || entry.layout.length !== 4 || !entry.layout.every(Number.isFinite)) {
            invalidRecords++; if (invalidRecordSamples.length < 10) invalidRecordSamples.push({ id: entry.id, shard: filename });
            continue;
          }
          const candidate = liveCandidateFromEntry(entry, filename);
          if (!candidate) {
            descriptorDecodeFailures++; if (decodeFailureSamples.length < 10) decodeFailureSamples.push({ id: entry.id, shard: filename });
            continue;
          }
          decoded++;
          const old = snapshotById.get(candidate.id);
          if (old) {
            snapshotFound.add(candidate.id);
            for (const [current, recorded] of [
              [candidate.feature, old.feature], [candidate.geometry.structure, old.geometry.structure],
              [candidate.geometry.surface, old.geometry.surface], [candidate.geometry.projection, old.geometry.projection],
              [candidate.geometry.layout, old.geometry.layout],
            ]) maximumSnapshotDescriptorDifference = Math.max(maximumSnapshotDescriptorDifference, maximumDifference(current, recorded));
          }
          // No ranking, pose-window selection, top-K truncation or approximate index:
          // this exact per-axis condition is also checked after projectionError.
          for (let index = 0; index < frames.length; index++) {
            const frame = frames[index], caps = framePoseCaps[index];
            if (Math.abs((Number(frame.feature[0] ?? 0) - Number(candidate.feature[0] ?? 0)) * 90) - caps[0] > budget.maximumPoseIncreaseDegrees ||
              Math.abs((Number(frame.feature[1] ?? 0) - Number(candidate.feature[1] ?? 0)) * 90) - caps[1] > budget.maximumPoseIncreaseDegrees ||
              Math.abs((Number(frame.feature[2] ?? 0) - Number(candidate.feature[2] ?? 0)) * 90) - caps[2] > budget.maximumPoseIncreaseDegrees) {
              poseFilteredPairs++; continue;
            }
            fullScoreEvaluations++;
            const error = projectionError(frame, candidate);
            assert(Object.values(error).every(Number.isFinite), `Nonfinite score: ${candidate.id}, frame ${index}`);
            if (candidate.id === baseline[index].candidate.id) {
              verifiedCatalogBaselineFrames++;
              for (const key of Object.keys(error)) maximumCatalogBaselineScoreDifference = Math.max(maximumCatalogBaselineScoreDifference, Math.abs(error[key] - baseline[index].error[key]));
            }
            if (allowed(error, baseline[index].error)) {
              beams[index].push({ candidate, error }); retained.set(candidate.id, candidate); admittedPairs++;
            }
          }
        }
      }
      assert.equal(cellEntries, cell.count, `Manifest count mismatch at ${cellKey}`);
      if (shardFiles.size % 50 === 0) console.log('HISTORY_FULL_CATALOG ' + JSON.stringify({ stage: 'scan', shards: shardFiles.size, entries, fullScoreEvaluations, admittedPairs }));
    }
    report.inventory = { entries, uniqueIds: ids.size, uniqueImageAddresses: addresses.size, decoded,
      descriptorDecodeFailures, invalidRecords, duplicateIds, duplicateAddresses,
      decodeFailureSamples, invalidRecordSamples, cells: orderedCells.length, shards: shardFiles.size,
      uncompressedShardDigest: shardDigest.digest('hex'),
    };
    report.scoring = { frameCandidatePairs: entries * frames.length, poseFilteredPairs, fullScoreEvaluations, admittedPairs,
      snapshotCandidatesFoundInCatalog: snapshotFound.size, maximumSnapshotDescriptorDifference,
      verifiedCatalogBaselineFrames, maximumCatalogBaselineScoreDifference,
    };
    await save('inventory.json', { ...report.inventory, shards: shardInventory });
    assert.equal(entries, expected.totalFaces); assert.equal(ids.size, expected.totalFaces);
    assert.equal(addresses.size, expected.totalFaces); assert.equal(decoded, expected.totalFaces);
    assert.equal(descriptorDecodeFailures, 0); assert.equal(invalidRecords, 0);
    assert.equal(duplicateIds, 0); assert.equal(duplicateAddresses, 0);
    assert.equal(snapshotFound.size, snapshotById.size);
    assert.equal(maximumSnapshotDescriptorDifference, 0, 'All saved snapshot descriptors must equal current catalog decoding');
    assert.equal(verifiedCatalogBaselineFrames, frames.length);
    assert.equal(maximumCatalogBaselineScoreDifference, 0, 'Full-catalog baseline scores must exactly equal the captured baseline');
    assert.equal(poseFilteredPairs + fullScoreEvaluations, entries * frames.length);
    assert(beams.every((beam, index) => beam.some(item => item.candidate.id === baseline[index].candidate.id)), 'Every original choice must be retained');
    report.checks.push('All 70000 entries/unique IDs/unique image addresses decoded without failure; every saved candidate descriptor and every baseline score exactly match.');

    for (const beam of beams) beam.sort((left, right) => left.error.total - right.error.total || (left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0));
    const candidates = [...retained.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const candidateIndex = new Map(candidates.map((candidate, index) => [candidate.id, index]));
    const compact = { schemaVersion: 1, snapshotSha256: report.snapshotSha256,
      manifestSha256: report.manifestSha256, fixtureSha256: report.fixtureSha256, budget,
      frames, candidates, beams: beams.map(beam => beam.map(item => ({ index: candidateIndex.get(item.candidate.id), error: item.error }))),
      baseline: baseline.map(choice => ({ index: candidateIndex.get(choice.candidate.id), error: choice.error,
        emission: choice.emission, accepted: choice.accepted, expressionMotion: choice.expressionMotion })),
    };
    const compactBytes = gzipSync(JSON.stringify(compact, replacer), { level: 9 });
    await fs.writeFile(path.join(outputDirectory, 'admissible-beams.json.gz'), compactBytes);
    report.admissibleSnapshot = { file: 'admissible-beams.json.gz', sha256: hash(compactBytes), bytes: compactBytes.length, uniqueCandidates: candidates.length };
    report.admissibleCandidates = { minimum: Math.min(...beams.map(beam => beam.length)), maximum: Math.max(...beams.map(beam => beam.length)),
      mean: admittedPairs / frames.length, nonbaselinePairs: admittedPairs - frames.length,
      framesWithAlternatives: beams.filter(beam => beam.length > 1).length };
    const { runs, frameRuns, reentries } = runEvidence(baseline, beams);
    const newCandidates = beams.flatMap((beam, index) => {
      const savedIds = new Set(originalBeams[index].map(item => item.candidate.id));
      return beam.filter(item => !savedIds.has(item.candidate.id)).map(item => ({
        frameIndex: index, time: frames[index].time, baselineId: baseline[index].candidate.id,
        run: runs[frameRuns[index]], id: item.candidate.id, candidateIndex: candidateIndex.get(item.candidate.id),
        absentFromAllSavedCandidates: !snapshotById.has(item.candidate.id),
        delta: errorDeltas(item.error, baseline[index].error), error: item.error,
        shard: item.candidate.shard, pack: item.candidate.pack, offset: item.candidate.offset, length: item.candidate.length,
      }));
    });
    await save('new-candidates.json', { newAdmissibleFrameCandidatePairs: newCandidates.length, candidates: newCandidates });
    report.newCandidates = { file: 'new-candidates.json', frameCandidatePairs: newCandidates.length,
      uniqueIds: new Set(newCandidates.map(item => item.id)).size,
      affectedFrames: [...new Set(newCandidates.map(item => item.frameIndex))],
      outsideEntireSnapshot: newCandidates.filter(item => item.absentFromAllSavedCandidates).length,
    };
    report.flexibleFrames = beams.flatMap((beam, index) => beam.length <= 1 ? [] : [{ index, time: frames[index].time,
      run: runs[frameRuns[index]], candidates: beam.map(item => ({ id: item.candidate.id, delta: errorDeltas(item.error, baseline[index].error) })) }]);
    report.reentries = reentries;
    report.reentryOpportunities = {
      recentEvents: reentries.filter(event => event.recent).length,
      recentEntriesWithAlternative: reentries.filter(event => event.recent && event.entryAlternatives.length).length,
      recentRunsWithCommonAlternative: reentries.filter(event => event.recent && event.commonAlternativesAcrossRun.length).length,
      recentPreviousRunsWithCommonAlternative: reentries.filter(event => event.recent && event.commonAlternativesAcrossPreviousRun.length).length,
      recentGapsFullyHoldable: reentries.filter(event => event.recent && event.couldHoldReturningPhotoThroughGap).length,
    };
    report.exhaustive = enumerateCounts(baseline, beams, REVIEW_HISTORY_OPTIONS.windowSeconds);
    report.completed = true; report.finishedAt = new Date().toISOString();
    await save('summary.json', report);
    console.log('HISTORY_FULL_CATALOG ' + JSON.stringify({ stage: 'complete', outputDirectory,
      inventory: report.inventory, scoring: report.scoring, admissibleCandidates: report.admissibleCandidates,
      newCandidates: report.newCandidates, reentryOpportunities: report.reentryOpportunities,
      exhaustive: report.exhaustive,
    }));
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
    report.finishedAt = new Date().toISOString();
    await save('summary.json', report);
    throw error;
  }
}

await main();
