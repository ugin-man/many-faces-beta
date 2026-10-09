#!/usr/bin/env node
/**
 * Validate the complete same-input comparison, including the one measured
 * initial-render failure in the immutable 7b6 baseline. No candidate failure is
 * accepted. A qualified baseline remains failed; its later checks must finish.
 * This module reads no files except in its explicit report-validation CLI.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const ACCEPTED_BASELINE = '7b6f7f0d42c18e770379bd56577e9608ba2e9f9e';
export const BASELINE_CLIENT_SHA256 = '2639a28d55083e77a2b97af3791183f4543ce0619efda5a820d1489557d71984';
export const FIXTURE_SHA256 = 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b';
export const MATRIX_TOLERANCE = 0.0001;
export const REMAINING_STAGES = ['completeVideo', 'presentation', 'layout', 'playback', 'freshPixels', 'modeSwitch', 'downloadedAssets', 'runtimeAndCatalogStable'];
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = (value, label) => assert(Number.isFinite(value), `Nonfinite ${label}`);
const positiveInteger = (value, label) => assert(Number.isSafeInteger(value) && value > 0, `Invalid ${label}`);
const matches = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < MATRIX_TOLERANCE);

function assertVector(value, length, label) {
  assert(Array.isArray(value) && value.length === length, `Invalid ${label}`);
  value.forEach(component => finite(component, label));
}
function assertIdentity(identity, label) {
  assert.equal(identity?.version, 'camera-arrival-v3', `${label} runtime version`);
  assert(typeof identity.build === 'string' && /^[a-f0-9]{16}$/.test(identity.build), `${label} build identity`);
  assert(typeof identity.revision === 'string' && /^[a-f0-9]{40}$/.test(identity.revision), `${label} source revision`);
}
function assertBaselineSource(report, trial) {
  const source = report.baselineSource;
  assert.equal(report.fixtureSha256, FIXTURE_SHA256, 'The exception is limited to the unchanged complete fixture');
  assert.equal(source?.commit, ACCEPTED_BASELINE, 'Wrong baseline source commit');
  assert.equal(source.path, 'app/live/review-client-lite.tsx', 'Wrong baseline source path');
  assert.equal(source.sha256, BASELINE_CLIENT_SHA256, 'Wrong complete baseline client source SHA256');
  assert.equal(source.verifiedUnchanged, true, 'Baseline source was not checked for changes');
  assertIdentity(source.sourceIdentity, 'Baseline source');
  assertIdentity(trial.identity, 'Baseline served');
  assert.equal(source.sourceIdentity.revision, ACCEPTED_BASELINE);
  assert.deepEqual(trial.identity, source.sourceIdentity, 'The baseline server differs from its checked source');
}

export function expectedFaceMatrix(sample, aspect, tracked = true) {
  finite(aspect, 'source aspect'); assert(aspect > 0);
  assertVector(sample.candidateLayout, 4, 'candidate face layout');
  assertVector(sample.inputLayout, 4, 'input face layout');
  positiveInteger(sample.width, 'canvas width'); positiveInteger(sample.height, 'canvas height');
  assert(sample.candidateLayout[2] > 0 && sample.candidateLayout[3] > 0 && sample.inputLayout[2] > 0 && sample.inputLayout[3] > 0, 'Invalid face dimensions');
  const [cx, cy, cw, ch] = sample.candidateLayout, [tx, ty, tw, th] = sample.inputLayout;
  const ax = Math.max(1, aspect), ay = Math.max(1, 1 / aspect);
  const scale = tracked ? Math.max(0.5, Math.min(2.5, (th * ay / Math.max(0.01, ch)) * 0.7 + (tw * ax / Math.max(0.01, cw)) * 0.3)) : 1;
  const x = tracked ? (tx - 0.5) * ax - (cx - 0.5) * scale : 0;
  const y = tracked ? (ty - 0.5) * ay - (cy - 0.5) * scale : 0;
  const matrix = [scale, 0, 0, scale, sample.width * (0.5 + x), sample.height * (0.5 + y)];
  assertVector(matrix, 6, 'computed face matrix');
  return matrix;
}
function assertChoice(sample, choice) {
  assert(choice && typeof choice.id === 'string' && choice.id && typeof choice.url === 'string', 'Missing captured first/selected choice');
  finite(choice.time, 'selected time'); assert(choice.time >= 0 && choice.time < 23.3);
  for (const key of ['id', 'url', 'time', 'candidateLayout', 'inputLayout']) assert.deepEqual(sample[key], choice[key], `Canvas evidence differs from its captured choice: ${key}`);
}
function assertCanvas(sample, choice) {
  assertChoice(sample, choice);
  positiveInteger(sample.width, 'canvas width'); positiveInteger(sample.height, 'canvas height');
  positiveInteger(sample.drawCount, 'successful canvas draw count');
  positiveInteger(sample.videoWidth, 'decoded video width'); positiveInteger(sample.videoHeight, 'decoded video height');
  finite(sample.videoTime, 'canvas video time'); assert(sample.videoTime >= 0 && sample.videoTime < 23.3);
  assert.equal(sample.paused, true, 'Canvas was observed during playback');
  assert.equal(sample.seeking, false, 'Canvas was observed before seek completion');
  assert(Math.abs(sample.videoTime - sample.time) < 0.005, 'Canvas time differs from selected frame');
  assert(digest(sample.pixelHash), 'Missing observed canvas pixel SHA256');
  const draw = sample.lastDraw, source = draw?.sourceImage;
  assertVector(draw?.matrix, 6, 'actual canvas matrix');
  finite(draw.at, 'draw timestamp'); assert(draw.at >= 0);
  assert.equal(draw.sourceWidth, sample.width); assert.equal(draw.sourceHeight, sample.height);
  assert.deepEqual(draw.args, [-sample.width / 2, -sample.height / 2], 'Unexpected presentation layer draw');
  assert.equal(source?.url, choice.url, 'Canvas decoded a different source photo');
  assert.equal(source.complete, true, 'Source photo was not completely decoded');
  for (const key of ['width', 'height', 'naturalWidth', 'naturalHeight']) positiveInteger(source[key], 'decoded photo ' + key);
  assert.equal(source.width, source.naturalWidth); assert.equal(source.height, source.naturalHeight);
}
function assertCorrectCanvas(sample, choice, tracked = true) {
  assertCanvas(sample, choice);
  const expected = expectedFaceMatrix(sample, sample.videoWidth / sample.videoHeight, tracked);
  assert(matches(sample.lastDraw.matrix, expected), 'Canvas does not match the correct face transform');
  return expected;
}

/** Throws unless this is precisely the observed failure; it never repairs it. */
export function assertKnownBaselineInitialFailure(report, trial, originalError) {
  assert.equal(trial.name, 'baseline', 'A candidate failure cannot be accepted as a baseline failure');
  assertBaselineSource(report, trial);
  assert.equal(trial.initialPresentationPassed, false);
  const initial = trial.presentation?.initial, first = trial.firstChoice;
  assertCanvas(initial, first);
  const sourceUrl = new URL(first.url);
  assert.equal(sourceUrl.origin, trial.base); assert.equal(sourceUrl.pathname, '/api/catalog/image');
  assert.equal(sourceUrl.searchParams.get('source'), 'seed', 'The initial source is outside the original core catalog');
  assert.equal(initial.beforeAnySeek, true, 'Initial evidence was captured after a seek');
  assert.equal(initial.time, 0); assert.equal(initial.videoTime, 0, 'The known failure is confined to exact initial time zero');
  assert.equal(first.id, trial.video?.sequenceIds?.[0], 'Initial photo differs from the actual worker sequence');
  assert.equal(initial.videoWidth, 512); assert.equal(initial.videoHeight, 910);
  assert.equal(initial.width, 768); assert.equal(initial.height, 768);
  assert.equal(initial.lastDraw.sourceImage.naturalWidth, 256); assert.equal(initial.lastDraw.sourceImage.naturalHeight, 256);
  const correctAspectRatio = 512 / 910;
  assert.equal(trial.presentation.sourceAspectRatio, correctAspectRatio);
  const actualMatrix = initial.lastDraw.matrix, staleMatrix = expectedFaceMatrix(initial, 1), correctMatrix = expectedFaceMatrix(initial, correctAspectRatio);
  assert(matches(actualMatrix, staleMatrix), 'All six components must match the stale square-aspect closure');
  assert(!matches(actualMatrix, correctMatrix), 'A correct initial draw is not the known baseline failure');
  const expected = {scale: correctMatrix[0], x: initial.expected?.x, y: initial.expected?.y};
  finite(expected.x, 'saved expected x'); finite(expected.y, 'saved expected y');
  assert.equal(initial.expected?.scale, correctMatrix[0]);
  assert.equal(initial.width * (0.5 + expected.x), correctMatrix[4]);
  assert.equal(initial.height * (0.5 + expected.y), correctMatrix[5]);
  assert.equal(originalError?.name, 'AssertionError', 'Only the original matrix assertion qualifies');
  assert.equal(originalError.code, 'ERR_ASSERTION');
  assert(typeof originalError.stack === 'string' && originalError.stack.includes(originalError.message), 'Original assertion stack is missing');
  const failure = /^Actual face transform differs at matrix component ([0-5]): (.+)$/s.exec(originalError.message);
  assert(failure, 'The failing assertion was not the initial canvas matrix');
  const component = Number(failure[1]);
  assert(Math.abs(actualMatrix[component] - correctMatrix[component]) >= MATRIX_TOLERANCE);
  assert.deepEqual(JSON.parse(failure[2]), {
    actual: actualMatrix, expected: correctMatrix, width: initial.width, height: initial.height,
    videoTime: initial.videoTime, videoWidth: initial.videoWidth, videoHeight: initial.videoHeight,
    drawCount: initial.drawCount, sourceImage: initial.lastDraw.sourceImage,
    candidateLayout: initial.candidateLayout, inputLayout: initial.inputLayout,
  }, 'Original failure evidence differs from the saved initial observation');
  return {
    schemaVersion: 1, kind: 'baseline-initial-square-aspect', originalError,
    baselineClientSha256: BASELINE_CLIENT_SHA256, staleAspectRatio: 1, correctAspectRatio,
    matrixTolerance: MATRIX_TOLERANCE, actualMatrix, staleMatrix, correctMatrix,
    maximumStaleComponentError: Math.max(...actualMatrix.map((value, index) => Math.abs(value - staleMatrix[index]))),
  };
}

export function assertBaselineInitialRecovery(trial) {
  const recovery = trial.initialRecovery, initial = trial.presentation?.initial;
  assert.equal(recovery?.method, 'seek-away-and-back');
  assert.equal(recovery.passed, true); assert.equal(recovery.sequenceUnchanged, true);
  finite(recovery.seekAwayTime, 'recovery seek time');
  assert(recovery.seekAwayTime >= 0.05 && recovery.seekAwayTime < 23.3, 'Recovery must actually leave time zero');
  const awayIndex = trial.timeline.indexOf(recovery.seekAwayTime);
  assert(awayIndex > 0, 'Recovery time is absent from the later acquired timeline');
  assert.equal(recovery.awayChoice?.id, trial.video.sequenceIds[awayIndex], 'Recovery photo differs from the actual selected sequence');
  assert.equal(recovery.returnedTime, 0); assert.equal(recovery.canvas?.videoTime, 0);
  assert.equal(recovery.away?.time, recovery.seekAwayTime);
  assertCorrectCanvas(recovery.away, recovery.awayChoice);
  assertCorrectCanvas(recovery.canvas, trial.firstChoice);
  for (const key of ['videoWidth', 'videoHeight', 'width', 'height']) {
    assert.equal(recovery.away[key], initial[key]); assert.equal(recovery.canvas[key], initial[key]);
  }
  assert(recovery.away.videoTime > 0 && recovery.away.drawCount > initial.drawCount && recovery.canvas.drawCount > recovery.away.drawCount, 'Recovery did not produce both real seek redraws');
  assert(recovery.away.lastDraw.at > initial.lastDraw.at && recovery.canvas.lastDraw.at > recovery.away.lastDraw.at, 'Recovery draws are not later observations');
  assert.notEqual(recovery.canvas.pixelHash, initial.pixelHash, 'The recovered canvas still has the initial failed pixels');
}

function assertCompletedTrial(trial) {
  assertIdentity(trial.identity, trial.name);
  assert.equal(trial.remainingChecksPassed, true, `${trial.name} did not finish all remaining checks`);
  assert.deepEqual(trial.verificationStages, Object.fromEntries(REMAINING_STAGES.map(stage => [stage, true])), 'A required trial stage is missing');
  assert.deepEqual(trial.pageErrors, []); assert.equal(trial.runtimeIdentityAndManifestStable, true);
  const video = trial.video;
  assert.equal(video?.passed, true); assert.deepEqual(video.reasons, []);
  assert.equal(video.plannedFrames, 466); positiveInteger(video.faceFrames, 'complete detected frame count');
  assert(video.faceFrames <= video.plannedFrames); assert.equal(video.faceCoverage, video.faceFrames / video.plannedFrames);
  assert.equal(video.sequenceFrames, video.faceFrames); assert.equal(trial.acquiredFrameCount, video.faceFrames);
  assert.equal(video.imageFailures, 0); assert.equal(video.canvasNonBlank, true); assert(video.faceCoverage >= 0.7 && video.faceCoverage <= 1);
  finite(trial.durationSeconds, 'video duration'); assert(Math.abs(trial.durationSeconds - 23.3) < 0.001);
  assert.equal(trial.runtime?.phase, 'review');
  for (const key of ['version', 'build', 'revision']) assert.equal(trial.runtime[key], trial.identity[key]);
  for (const key of ['client', 'runtime', 'input', 'worker']) assert.equal(trial.builds?.[key], trial.identity.build, 'A video build differs from the served application');
  assert.equal(trial.builds.version, trial.identity.version); assert.equal(video.build, trial.identity.build); assert.equal(video.inputBuild, trial.identity.version);
  assert(digest(trial.framesHash) && digest(trial.choicesHash) && digest(trial.timelineHash), 'Missing complete frame/choice/timeline SHA256');
  assert(Array.isArray(trial.timeline) && trial.timeline.length === video.faceFrames);
  trial.timeline.forEach((time, index) => {finite(time, 'acquired timeline time'); assert(time >= 0 && time < 23.3 && (index === 0 || time > trial.timeline[index - 1]));});
  assert.equal(trial.timelineHash, sha256(trial.timeline), 'Complete timeline hash differs');
  assert(Array.isArray(video.sequenceIds) && video.sequenceIds.length === video.faceFrames && video.sequenceIds.every(id => typeof id === 'string' && id));
  assert.equal(trial.firstChoice?.id, video.sequenceIds[0]); assert.equal(trial.firstChoice?.time, trial.timeline[0]);
  const initial = trial.presentation?.initial;
  assert.equal(initial?.beforeAnySeek, true); assert.equal(initial.time, 0); assert.equal(initial.videoTime, 0);
  assert.equal(trial.presentation.sourceAspectRatio, initial.videoWidth / initial.videoHeight);
  const initialUrl = new URL(trial.firstChoice.url); assert.equal(initialUrl.origin, trial.base); assert.equal(initialUrl.pathname, '/api/catalog/image');
  assert.equal(trial.catalog?.images, 70000); assert.equal(trial.catalog.uniqueIds, 70000); assert.equal(trial.catalog.physicalAddresses, 70000);
  assert(digest(trial.catalog.manifestHash) && digest(trial.catalog.imageBytesHash));
  positiveInteger(trial.downloadedShardCount, 'downloaded shard count'); positiveInteger(trial.downloadedCoreImages, 'downloaded image count');
  assert.equal(trial.presentation.samples?.length, 5);
  for (const [index, fraction] of [0, 0.25, 0.5, 0.75, 0.94].entries()) {
    const sample = trial.presentation.samples[index], choiceIndex = Math.min(trial.timeline.length - 1, Math.floor((trial.timeline.length - 1) * fraction));
    assert.equal(sample.id, video.sequenceIds[choiceIndex]); assert.equal(sample.time, trial.timeline[choiceIndex]);
    assertCorrectCanvas(sample, sample);
  }
  const toggles = trial.presentation.toggles, choice = toggles?.selectedChoice;
  assert.equal(choice?.id, toggles.selectedId); assert.equal(choice.time, toggles.selectedTime);
  assert.equal(video.sequenceIds[trial.timeline.indexOf(choice.time)], choice.id);
  for (const name of ['normal', 'untracked', 'tracked', 'face']) assertCorrectCanvas({...choice, ...toggles[name]}, choice, name !== 'untracked');
  assert(toggles.untracked.drawCount > toggles.normal.drawCount && toggles.face.drawCount > toggles.tracked.drawCount);
  assert.notEqual(toggles.untracked.pixelHash, toggles.normal.pixelHash); assert.notEqual(toggles.face.pixelHash, toggles.tracked.pixelHash);
  assert.equal(toggles.tracked.pixelHash, toggles.normal.pixelHash);
  assert.deepEqual(toggles.mirrored, {'input-video': 'matrix(-1, 0, 0, 1, 0, 0)', 'output-canvas': 'matrix(-1, 0, 0, 1, 0, 0)'});
  assert.deepEqual(toggles.unmirrored, {'input-video': 'none', 'output-canvas': 'none'});
  assert.equal(trial.layout?.length, 2);
  for (const [index, viewport] of [{width: 390, height: 844}, {width: 1440, height: 900}].entries()) {
    const layout = trial.layout[index]; assert.deepEqual(layout.viewport, viewport);
    assert(Math.abs(layout.stage.width - viewport.width) < 1 && Math.abs(layout.stage.height - viewport.height) < 1 && Math.abs(layout.stage.x) < 1 && Math.abs(layout.stage.y) < 1);
    assert.equal(layout.scroll, viewport.width); assert.equal(layout.oldTabs, 0); assert.equal(layout.modes, 2); assert.equal(layout.objectFit, 'cover');
    assert(layout.pip.x > viewport.width / 2 && layout.pip.y < 40 && layout.pip.width * layout.pip.height < viewport.width * viewport.height * 0.12);
  }
  assert.equal(trial.playback?.paused.paused, true); assert.equal(trial.playback?.stepped.paused, true);
  finite(trial.playback.paused.reviewTime, 'paused review time'); finite(trial.playback.stepped.time, 'stepped video time');
  assert(trial.playback.stepped.time > trial.playback.paused.reviewTime && Math.abs(trial.playback.stepped.time - trial.playback.paused.reviewTime - 0.05) < 0.005);
  assert.equal(trial.playback.seekSeconds, 22);
  assert.deepEqual(trial.freshPixels?.errors, []); positiveInteger(trial.freshPixels.photosDetected, 'fresh pixel face detections');
  if (trial.name === 'candidate') {
    assert.equal(trial.initialPresentationPassed, true, 'Candidate initial presentation must pass');
    assert.equal(trial.passed, true, 'Every candidate check must pass');
    assert.equal(trial.knownInitialFailure, null, 'No candidate failure is eligible for the baseline exception');
    assert.equal(trial.initialRecovery, null, 'Candidate initial rendering may not be repaired by the harness');
    assert.deepEqual(trial.legacyQualityOverlayRequests, []);
    assert.deepEqual(trial.freshPixels.storedContradictions, []); assert.deepEqual(trial.freshPixels.reversedInputYawFrames, []);
    assert.equal(trial.boundWinkIndex?.externalPhotos, 0); assert.equal(trial.boundWinkIndex.manifestSha256, trial.catalog.manifestHash);
    assert.equal(trial.performance?.wink?.addedPhotos, 0); assert.equal(trial.performance.wink.indexError, null);
    assertCorrectCanvas(initial, trial.firstChoice);
  }
}

/** The workflow, launcher and promoter all consume exactly this validator. */
export function assertComparisonContract(report) {
  assert.equal(report?.schemaVersion, 1); assert.equal(report.passed, true, 'Comparison did not finish successfully');
  assert.deepEqual(report.failures, [], 'Unhandled comparison failures remain');
  assert.equal(report.fixtureSha256, FIXTURE_SHA256); assert.equal(report.densityFps, 20); assert.equal(report.expectedPlannedFrames, 466);
  assert.equal(report.trials?.length, 2); assert.deepEqual(report.trials.map(trial => trial.name), ['baseline', 'candidate']);
  const [baseline, candidate] = report.trials;
  assertBaselineSource(report, baseline);
  for (const trial of report.trials) assertCompletedTrial(trial);
  let accepted = false;
  if (baseline.initialPresentationPassed === true) {
    assert.equal(baseline.passed, true); assert.equal(baseline.knownInitialFailure, null); assert.equal(baseline.initialRecovery, null);
    assertCorrectCanvas(baseline.presentation.initial, baseline.firstChoice);
  } else {
    assert.equal(baseline.passed, false, 'The known baseline failure must remain reported as failed');
    const evidence = assertKnownBaselineInitialFailure(report, baseline, baseline.knownInitialFailure?.originalError);
    assert.deepEqual(baseline.knownInitialFailure, evidence, 'Known baseline evidence was changed or incompletely recorded');
    assertBaselineInitialRecovery(baseline); accepted = true;
  }
  assert.equal(report.comparison?.sameAcquiredFrames, true); assert.equal(report.comparison.sameTimeline, true);
  assert.equal(baseline.framesHash, candidate.framesHash, 'Full acquired frame hashes differ');
  assert.equal(baseline.video.faceFrames, candidate.video.faceFrames);
  assert.deepEqual(baseline.timeline, candidate.timeline, 'Full acquired timelines differ');
  assert.equal(baseline.timelineHash, candidate.timelineHash);
  assert.notEqual(baseline.catalog.imageBytesHash, candidate.catalog.imageBytesHash, 'The candidate did not replace the old physical catalog');
  const contract = {
    schemaVersion: 1, status: 'complete', candidatePassed: true, candidateInitialPresentationPassed: true,
    baselinePassed: baseline.passed, baselineInitialPresentationPassed: baseline.initialPresentationPassed,
    baselineRemainingChecksPassed: true, baselineKnownInitialFailureAccepted: accepted,
    sameAcquiredFrames: true, sameTimeline: true, acquiredFramesSha256: baseline.framesHash,
    timelineSha256: baseline.timelineHash, comparedFaceFrames: baseline.video.faceFrames,
  };
  assert.deepEqual(report.comparisonContract, contract, 'Comparison contract disagrees with the underlying trial evidence');
  return contract;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/clean-catalog-comparison-contract.mjs <report.json>');
    console.log(JSON.stringify(assertComparisonContract(JSON.parse(await fs.readFile(process.argv[2], 'utf8')))));
  } catch (error) {
    console.error(error.stack || String(error)); process.exitCode = 1;
  }
}
