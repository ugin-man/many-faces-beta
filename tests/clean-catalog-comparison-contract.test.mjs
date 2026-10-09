import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {facePresentationTransform} from '../app/face-presentation.ts';
import {ACCEPTED_BASELINE, MATRIX_TOLERANCE, REMAINING_STAGES, assertBaselineInitialRecovery,
  assertComparisonContract, assertKnownBaselineInitialFailure, expectedFaceMatrix} from '../scripts/clean-catalog-comparison-contract.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/baseline-initial-square-aspect.json', import.meta.url), 'utf8'));
const probeSource = readFileSync(new URL('../scripts/verify-clean-catalog.mjs', import.meta.url), 'utf8');
const probe = ts.createSourceFile('verify-clean-catalog.mjs', probeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const launcherSource = readFileSync(new URL('../scripts/run-video-validation.mjs', import.meta.url), 'utf8');
const launcher = ts.createSourceFile('run-video-validation.mjs', launcherSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const choiceAt = (choice, time) => ({...clone(choice), time});
function extract(name, bindings) {
  const nodes = probe.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, name);
  return vm.runInNewContext('(' + nodes[0].getText(probe) + ')', bindings);
}
const assertDrawing = extract('assertDrawing', {assert});
const expectedTransform = extract('expectedTransform', {});
function actualAssertion(trial) {
  const initial = trial.presentation.initial;
  try {assertDrawing(initial, expectedTransform(trial.firstChoice, initial.videoWidth / initial.videoHeight), trial.firstChoice);}
  catch (error) {return {name: error.name, code: error.code, message: error.message, stack: error.stack};}
  throw new Error('The altered observation unexpectedly passed the production assertion');
}
function correctSample(choice, drawCount = 3, tracked = true) {
  const state = {...clone(fixture.trial.presentation.initial), ...clone(choice), time: choice.time,
    videoTime: choice.time, drawCount, pixelHash: hash({id: choice.id, time: choice.time, tracked})};
  delete state.beforeAnySeek;
  state.expected = expectedTransform(choice, state.videoWidth / state.videoHeight, tracked);
  state.lastDraw.matrix = expectedFaceMatrix(state, state.videoWidth / state.videoHeight, tracked);
  state.lastDraw.at += drawCount; state.lastDraw.sourceImage.url = choice.url;
  return state;
}
function recoveryFor(trial) {
  const awayChoice = choiceAt(trial.firstChoice, trial.timeline[1]);
  return {method: 'seek-away-and-back', passed: true, sequenceUnchanged: true, seekAwayTime: awayChoice.time,
    returnedTime: 0, awayChoice, away: correctSample(awayChoice, 3), canvas: correctSample(trial.firstChoice, 4)};
}
// Only the failed initial observation is a real browser fixture. These complete
// rows are model-free boundary fixtures; no test claims they are browser passes.
function completedTrial(name) {
  const baseline = name === 'baseline', row = clone(fixture.trial);
  row.name = name; row.base = `http://127.0.0.1:${baseline ? 4185 : 4183}`;
  if (!baseline) {
    row.identity = {version: 'camera-arrival-v3', build: '87b57e8f16cd44dd', revision: 'b66eaa0cf466e61cc01f4999ab9e04770097702c'};
    row.firstChoice.id = 'clean-v5-' + 'c'.repeat(28);
    row.firstChoice.url = row.firstChoice.url.replace(':4185/', ':4183/');
  }
  row.initialPresentationPassed = !baseline; row.passed = !baseline; row.remainingChecksPassed = true;
  row.pageErrors = []; row.verificationStages = Object.fromEntries(REMAINING_STAGES.map(stage => [stage, true]));
  row.runtimeIdentityAndManifestStable = true; row.runtime = {phase: 'review', ...row.identity};
  row.builds = Object.fromEntries(['client', 'runtime', 'input', 'worker'].map(key => [key, row.identity.build]));
  row.builds.version = row.identity.version; row.acquiredFrameCount = 410; row.durationSeconds = 23.3;
  row.timeline = Array.from({length: 410}, (_, index) => index / 20); row.timelineHash = hash(row.timeline);
  row.framesHash = hash('same full acquired frame bytes'); row.choicesHash = hash(name);
  row.video = {passed: true, reasons: [], plannedFrames: 466, faceFrames: 410, sequenceFrames: 410,
    imageFailures: 0, canvasNonBlank: true, faceCoverage: 410 / 466, build: row.identity.build,
    inputBuild: row.identity.version, sequenceIds: row.timeline.map(() => row.firstChoice.id)};
  row.catalog = {images: 70000, uniqueIds: 70000, physicalAddresses: 70000, manifestHash: hash('manifest ' + name), imageBytesHash: hash('physical images ' + name)};
  row.downloadedShardCount = 9; row.downloadedCoreImages = 20;
  if (!baseline) row.presentation.initial = {...correctSample(row.firstChoice), beforeAnySeek: true};
  row.presentation.samples = [0, 0.25, 0.5, 0.75, 0.94].map((fraction, index) => correctSample(choiceAt(row.firstChoice, row.timeline[Math.floor(409 * fraction)]), 5 + index));
  const selectedChoice = choiceAt(row.firstChoice, row.timeline[100]);
  row.presentation.toggles = {normal: correctSample(selectedChoice, 20), untracked: correctSample(selectedChoice, 21, false),
    tracked: correctSample(selectedChoice, 22), face: correctSample(selectedChoice, 23), selectedChoice,
    selectedId: selectedChoice.id, selectedTime: selectedChoice.time,
    mirrored: {'input-video': 'matrix(-1, 0, 0, 1, 0, 0)', 'output-canvas': 'matrix(-1, 0, 0, 1, 0, 0)'},
    unmirrored: {'input-video': 'none', 'output-canvas': 'none'}};
  row.presentation.toggles.face.pixelHash = hash('face only pixels');
  row.layout = [{width: 390, height: 844}, {width: 1440, height: 900}].map(viewport => ({viewport,
    stage: {x: 0, y: 0, ...viewport}, pip: {x: viewport.width - 100, y: 10, width: 80, height: 80},
    scroll: viewport.width, oldTabs: 0, modes: 2, objectFit: 'cover'}));
  row.playback = {paused: {paused: true, time: 0.3, reviewTime: 0.3}, stepped: {paused: true, time: 0.35}, seekSeconds: 22};
  row.freshPixels = {errors: [], photosDetected: 10, storedContradictions: [], reversedInputYawFrames: []};
  row.boundWinkIndex = {externalPhotos: 0, manifestSha256: row.catalog.manifestHash};
  row.performance = {wink: {addedPhotos: 0, indexError: null}}; row.legacyQualityOverlayRequests = [];
  row.knownInitialFailure = null; row.initialRecovery = baseline ? recoveryFor(row) : null;
  return row;
}
function completeReport(known = true) {
  const report = {...clone(fixture.report), schemaVersion: 1, passed: true, failures: [], densityFps: 20, expectedPlannedFrames: 466};
  const baseline = completedTrial('baseline'), candidate = completedTrial('candidate');
  if (known) baseline.knownInitialFailure = assertKnownBaselineInitialFailure(report, baseline, clone(fixture.originalError));
  else {
    baseline.initialPresentationPassed = true; baseline.passed = true; baseline.initialRecovery = null;
    baseline.presentation.initial = {...correctSample(baseline.firstChoice), beforeAnySeek: true};
  }
  report.trials = [baseline, candidate]; report.comparison = {sameAcquiredFrames: true, sameTimeline: true};
  report.comparisonContract = {schemaVersion: 1, status: 'complete', candidatePassed: true, candidateInitialPresentationPassed: true,
    baselinePassed: !known, baselineInitialPresentationPassed: !known, baselineRemainingChecksPassed: true,
    baselineKnownInitialFailureAccepted: known, sameAcquiredFrames: true, sameTimeline: true,
    acquiredFramesSha256: baseline.framesHash, timelineSha256: baseline.timelineHash, comparedFaceFrames: 410};
  return report;
}

test('real baseline fixture reproduces all six stale-aspect components and preserves the original assertion', () => {
  const evidence = assertKnownBaselineInitialFailure(fixture.report, fixture.trial, fixture.originalError);
  assert.equal(evidence.kind, 'baseline-initial-square-aspect');
  assert.equal(evidence.maximumStaleComponentError, 0.000008466314852739742);
  assert.equal(evidence.actualMatrix[0], 0.5170550346374512); assert.equal(evidence.correctMatrix[0], 0.7656278048187918);
  assert.equal(evidence.originalError.stack, fixture.originalError.stack);
  assert.equal(fixture.provenance.reportSha256, '5113c94891ac5c6b4a6f92112259f8c89b7f5ed366874ca55993f02b2b5f9522');
  assert.equal(fixture.trial.initialPresentationPassed, false);
});

test('independent contract matrices agree with unchanged production face-position mathematics', () => {
  const sample = fixture.trial.presentation.initial;
  for (const aspect of [1, 512 / 910, 16 / 9]) for (const tracked of [true, false]) {
    const transform = facePresentationTransform({layout: sample.candidateLayout}, {layout: sample.inputLayout}, aspect, tracked);
    const actual = [transform.scale, 0, 0, transform.scale, sample.width / 2 + transform.xPercent / 100 * sample.width, sample.height / 2 + transform.yPercent / 100 * sample.height];
    expectedFaceMatrix(sample, aspect, tracked).forEach((value, index) => assert(Math.abs(value - actual[index]) < 1e-10));
  }
});

for (const [name, mutate] of [
  ['candidate variant', (_r, t) => {t.name = 'candidate';}],
  ['different baseline commit', r => {r.baselineSource.commit = 'a'.repeat(40);}],
  ['different complete source bytes', r => {r.baselineSource.sha256 = 'a'.repeat(64);}],
  ['source changes during the run', r => {r.baselineSource.verifiedUnchanged = false;}],
  ['different runtime build', (_r, t) => {t.identity.build = 'f'.repeat(16);}],
  ['different runtime revision', (_r, t) => {t.identity.revision = 'f'.repeat(40);}],
  ['different fixed video', r => {r.fixtureSha256 = 'f'.repeat(64);}],
  ['observation after a seek', (_r, t) => {t.presentation.initial.beforeAnySeek = false;}],
  ['nonzero initial time below ordinary seek tolerance', (_r, t) => {t.presentation.initial.videoTime = 0.000001;}],
  ['playing video', (_r, t) => {t.presentation.initial.paused = false;}],
  ['unfinished seek', (_r, t) => {t.presentation.initial.seeking = true;}],
  ['different decoded video dimensions', (_r, t) => {t.presentation.initial.videoWidth = 513;}],
  ['different decoded image', (_r, t) => {t.presentation.initial.lastDraw.sourceImage.url += '&different=1';}],
  ['wrong baseline image origin', (_r, t) => {t.base = 'http://127.0.0.1:4183';}],
  ['incomplete image decode', (_r, t) => {t.presentation.initial.lastDraw.sourceImage.complete = false;}],
  ['different decoded photo dimensions', (_r, t) => {t.presentation.initial.lastDraw.sourceImage.naturalWidth = 255;}],
  ['changed source choice', (_r, t) => {t.firstChoice.id += '-other';}],
  ['different actual sequence', (_r, t) => {t.video.sequenceIds[0] += '-other';}],
  ['missing real draw', (_r, t) => {t.presentation.initial.drawCount = 0;}],
  ['wrong drawing axis', (_r, t) => {const a = t.presentation.initial.lastDraw.matrix; [a[4], a[5]] = [a[5], a[4]];}],
  ['NaN matrix', (_r, t) => {t.presentation.initial.lastDraw.matrix[0] = NaN;}],
  ['infinite matrix', (_r, t) => {t.presentation.initial.lastDraw.matrix[5] = Infinity;}],
  ['NaN input layout', (_r, t) => {t.presentation.initial.inputLayout[0] = NaN; t.firstChoice.inputLayout[0] = NaN;}],
  ['infinite expected offset', (_r, t) => {t.presentation.initial.expected.x = Infinity;}],
]) test('known-failure recognizer rejects ' + name, () => {
  const r = clone(fixture.report), t = clone(fixture.trial); mutate(r, t);
  assert.throws(() => assertKnownBaselineInitialFailure(r, t, fixture.originalError));
});

test('all six axes retain the strict 0.0001 boundary, including off-diagonal components', () => {
  assert.equal(MATRIX_TOLERANCE, 0.0001);
  for (let component = 0; component < 6; component++) {
    const t = clone(fixture.trial), stale = expectedFaceMatrix(t.presentation.initial, 1);
    t.presentation.initial.lastDraw.matrix = [...stale];
    t.presentation.initial.lastDraw.matrix[component] += 0.000099;
    assert.doesNotThrow(() => assertKnownBaselineInitialFailure(fixture.report, t, actualAssertion(t)));
    t.presentation.initial.lastDraw.matrix[component] = stale[component] + 0.000101;
    assert.throws(() => assertKnownBaselineInitialFailure(fixture.report, t, actualAssertion(t)));
  }
  const atBoundary = clone(fixture.trial); atBoundary.presentation.initial.lastDraw.matrix[1] = 0.0001;
  assert.throws(() => assertKnownBaselineInitialFailure(fixture.report, atBoundary, actualAssertion(atBoundary)));
});

test('correct initial draws and unrelated error text are never classified as the known failure', () => {
  const t = clone(fixture.trial); t.presentation.initial.lastDraw.matrix = expectedFaceMatrix(t.presentation.initial, 512 / 910);
  assert.throws(() => assertKnownBaselineInitialFailure(fixture.report, t, fixture.originalError), /stale square-aspect closure/);
  assert.throws(() => assertKnownBaselineInitialFailure(fixture.report, fixture.trial, {...fixture.originalError, message: 'Unrelated canvas failure'}));
  const altered = clone(fixture.originalError); altered.stack = 'missing';
  assert.throws(() => assertKnownBaselineInitialFailure(fixture.report, fixture.trial, altered), /stack/);
});

test('a completed candidate plus recovered baseline retains honest baseline failure fields', () => {
  const report = completeReport(), before = JSON.stringify(report);
  const result = assertComparisonContract(report);
  assert.equal(result.baselinePassed, false); assert.equal(result.baselineKnownInitialFailureAccepted, true);
  assert.equal(result.candidatePassed, true); assert.equal(result.baselineRemainingChecksPassed, true);
  assert.equal(report.trials[0].passed, false); assert.equal(report.trials[0].initialPresentationPassed, false);
  assert.equal(JSON.stringify(report), before, 'Validation must not rewrite the evidence');
  assert.doesNotThrow(() => assertComparisonContract(completeReport(false)), 'An entirely passing original baseline needs no exception');
});

for (const [name, mutate] of [
  ['baseline failure relabelled as passed', r => {r.trials[0].passed = true;}],
  ['unfinished baseline remainder', r => {r.trials[0].remainingChecksPassed = false;}],
  ['skipped baseline pixel inspection', r => {delete r.trials[0].verificationStages.freshPixels;}],
  ['missing baseline motion frame', r => {r.trials[0].presentation.samples.pop();}],
  ['different restored baseline matrix', r => {r.trials[0].initialRecovery.canvas.lastDraw.matrix[4] += 1;}],
  ['no true seek away from zero', r => {r.trials[0].initialRecovery.away.videoTime = 0;}],
  ['different recovery photo from the emitted sequence', r => {const recovery = r.trials[0].initialRecovery; recovery.awayChoice.id = 'different-photo'; recovery.away.id = 'different-photo';}],
  ['same failed pixels after recovery', r => {r.trials[0].initialRecovery.canvas.pixelHash = r.trials[0].presentation.initial.pixelHash;}],
  ['source mismatch after recognition', r => {r.baselineSource.sha256 = 'f'.repeat(64);}],
  ['candidate initial matrix failure', r => {r.trials[1].presentation.initial.lastDraw.matrix[0] += 1;}],
  ['candidate failed despite top-level pass', r => {r.trials[1].passed = false;}],
  ['candidate marked for baseline exception', r => {r.trials[1].knownInitialFailure = r.trials[0].knownInitialFailure;}],
  ['candidate repaired before initial assertion', r => {r.trials[1].initialRecovery = r.trials[0].initialRecovery;}],
  ['candidate display control failure', r => {r.trials[1].presentation.toggles.face.lastDraw.matrix[5] += 1;}],
  ['candidate page error', r => {r.trials[1].pageErrors.push('uncaught error');}],
  ['candidate quality overlay request', r => {r.trials[1].legacyQualityOverlayRequests.push('/catalog-quality/v1/exclusions.json');}],
  ['unhandled failure', r => {r.failures.push('unrelated check failed');}],
  ['different full frame arrays', r => {r.trials[1].framesHash = 'f'.repeat(64);}],
  ['fabricated frame coverage', r => {r.trials[1].video.faceCoverage = 1;}],
  ['different complete timeline', r => {r.trials[1].timeline[20] += 0.01; r.trials[1].timelineHash = hash(r.trials[1].timeline);}],
  ['nonfinite timeline', r => {r.trials[0].timeline[20] = NaN;}],
  ['missing candidate trial', r => {r.trials.pop();}],
  ['false comparison claim', r => {r.comparison.sameAcquiredFrames = false;}],
  ['contract altered independently', r => {r.comparisonContract.baselinePassed = true;}],
]) test('complete comparison contract rejects ' + name, () => {
  const report = completeReport(); mutate(report); assert.throws(() => assertComparisonContract(report));
});

test('production recovery truly seeks away and back before accepting the restored first canvas', async () => {
  const row = completedTrial('baseline'), recovery = recoveryFor(row), seeks = [];
  let observation = 0;
  const recover = extract('recoverBaselineInitialPresentation', {assert, expectedTransform, assertDrawing, assertBaselineInitialRecovery,
    seek: async time => {seeks.push(time);}, canvasState: async () => clone(observation++ ? recovery.canvas : recovery.away),
    screenshot: async () => undefined, selectionSignature: async () => ({ids: [row.firstChoice.id]})});
  await recover(row, [row.firstChoice, recovery.awayChoice], 512 / 910, {ids: [row.firstChoice.id]});
  assert.deepEqual(seeks, [0.05, 0]); assert.equal(row.initialRecovery.passed, true);
  assert.equal(row.passed, false); assert.equal(row.initialPresentationPassed, false);
  const noMotion = clone(row); noMotion.initialRecovery.away.videoTime = 0;
  assert.throws(() => assertBaselineInitialRecovery(noMotion));
  const noNewDraw = clone(row); noNewDraw.initialRecovery.canvas.drawCount = noNewDraw.initialRecovery.away.drawCount;
  assert.throws(() => assertBaselineInitialRecovery(noNewDraw));
});

test('production initial gate records the known failure but rejects an unknown source before recovery', async () => {
  for (const validSource of [true, false]) {
    const r = clone(fixture.report), row = clone(fixture.trial), calls = [], stop = new Error('stop after inspected recovery boundary');
    if (!validSource) r.baselineSource.sha256 = 'f'.repeat(64);
    // verifyPresentation allocates presentation before reading the canvas.
    const state = clone(row.presentation.initial);
    const bindings = {report: r, assert, expectedTransform, assertDrawing, assertKnownBaselineInitialFailure,
      page: {getByTestId: () => ({evaluate: async () => 512 / 910}), waitForFunction: async () => undefined}, selectionSignature: async () => ({ids: [row.firstChoice.id]}), check: value => assert(value), canvasState: async () => state,
      settle: async () => undefined, screenshot: async name => calls.push(name), save: async name => calls.push(name), progress: () => undefined,
      recoverBaselineInitialPresentation: async () => {calls.push('recover'); throw stop;}};
    const run = extract('verifyPresentation', bindings);
    await assert.rejects(run(row, [row.firstChoice]), error => validSource ? error === stop : /Actual face transform differs/.test(error.message));
    assert.equal(calls.includes('recover'), validSource); assert.equal(row.initialPresentationPassed, false);
    assert.equal(calls.includes('baseline-known-initial-failure.json'), validSource);
  }
});

function admittedBranch() {
  const matches = [];
  const visit = node => {if (ts.isIfStatement(node) && node.expression.getText(launcher) === "report.mode === 'identical'") matches.push(node.elseStatement); ts.forEachChild(node, visit);};
  visit(launcher); assert.equal(matches.length, 1);
  return matches[0].getText(launcher);
}
test('launcher uses the shared contract before running cancellation and subsequent browser stages', async () => {
  for (const valid of [true, false]) {
    const comparison = completeReport(), calls = [];
    if (!valid) comparison.trials[1].presentation.initial.lastDraw.matrix[0] += 0.1;
    const report = {reports: {}, runtimeIdentity: Object.fromEntries(comparison.trials.map(row => [row.name, row.identity]))};
    const run = vm.runInNewContext('(async () => ' + admittedBranch() + ')', {
      path, out: '/bounded-test', process, roots: {baseline: '/original-baseline', candidate: '/candidate'}, env: {}, assert, assertComparisonContract,
      report, run: async (name, _command, _args, _cwd, env) => {calls.push(name); if (name === 'admitted-catalog-comparison') assert.equal(env.CLEAN_BASELINE_APP_ROOT, '/original-baseline');},
      checkReport: async key => {report.reports[key] = {}; return key === 'admittedCatalog' ? comparison : {passed: true};},
    });
    if (valid) await run(); else await assert.rejects(run());
    assert.equal(calls.includes('pending-network-cancellation'), valid);
    if (valid) assert.equal(report.comparisonContract.baselinePassed, false);
  }
});

test('standalone CLI validates the same JSON contract and rejects a fabricated candidate pass', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'many-faces-comparison-contract-'));
  try {
    const file = path.join(directory, 'report.json'), cli = new URL('../scripts/clean-catalog-comparison-contract.mjs', import.meta.url);
    const report = completeReport(); writeFileSync(file, JSON.stringify(report));
    const output = execFileSync(process.execPath, [cli.pathname, file], {encoding: 'utf8'});
    assert.deepEqual(JSON.parse(output), report.comparisonContract);
    report.trials[1].initialPresentationPassed = false; writeFileSync(file, JSON.stringify(report));
    const rejected = spawnSync(process.execPath, [cli.pathname, file], {encoding: 'utf8'});
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Candidate initial presentation must pass/);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('baseline source proof verifies the complete real file and the pinned revision rather than trusting a supplied digest', async () => {
  const calls = [];
  let changed = false;
  const read = extract('baselineSourceIdentity', {
    execFileSync(command, args) {
      calls.push({command, args});
      if (command === 'git') return args.includes('rev-parse') ? ACCEPTED_BASELINE + '\n' : '';
      return JSON.stringify({revision: ACCEPTED_BASELINE, build: fixture.trial.identity.build});
    }, assert, hash: bytes => hash(Array.from(bytes)), fs: {readFile: async file => {calls.push({file}); return new Uint8Array(changed ? [1, 2, 3, 4] : [1, 2, 3]);}},
    path, signal: {signal: undefined}, process, ACCEPTED_BASELINE, BASELINE_CLIENT_SHA256: hash([1, 2, 3]),
  });
  const value = await read('/accepted');
  assert.equal(value.verifiedUnchanged, true); assert.equal(value.commit, ACCEPTED_BASELINE);
  assert(calls.some(call => call.file === '/accepted/app/live/review-client-lite.tsx'));
  assert(calls.some(call => call.args?.includes('diff') && call.args.includes(ACCEPTED_BASELINE) && call.args.includes('public')));
  changed = true;
  await assert.rejects(read('/accepted'), /Complete baseline client source differs/);
});
