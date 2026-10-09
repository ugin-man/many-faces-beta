import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import {
  optimizeHistoryAwareProjectionSequence, selectHistoryAwareReviewSequence,
  compareReviewSequences, measureReviewSequence, REVIEW_SEQUENCE_OPTIONS,
  REVIEW_HISTORY_OPTIONS, REVIEW_HISTORY_QUALITY_BUDGET,
} from '../app/live/review-history-selection.ts';
import { optimizeDistinctProjectionSequence } from '../app/projection-matching.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve('.browser-tools/node_modules/playwright'));
const out = path.resolve(process.env.HISTORY_REPORT_DIR || 'work/video-history');
const baselineRoot = path.resolve(process.env.HISTORY_BASELINE_ROOT || '/tmp/mf-history-baseline');
const fixture = path.resolve('public/test-fixtures/reference-face-motion.mp4');
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const decisions = choices => choices.map(c => ({ id: c.candidate.id, time: c.frame.time, error: c.error, emission: c.emission, accepted: c.accepted, expressionMotion: c.expressionMotion }));
const revive = (_key, value) => value?.__typed === 'Float32Array' ? new Float32Array(value.data) : value?.__typed === 'Float64Array' ? new Float64Array(value.data) : value;
const emit = (name, value) => console.log(name + ' ' + JSON.stringify(value));
const save = async (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const summary = comparison => ({ accepted: comparison.accepted, reasons: comparison.reasons,
  before: { ...comparison.before, reentryEvents: undefined }, after: { ...comparison.after, reentryEvents: undefined },
  maximumFrameErrorIncrease: comparison.maximumFrameErrorIncrease, maximumLocalErrorIncrease: comparison.maximumLocalErrorIncrease,
  maximumPoseIncreaseDegrees: comparison.maximumPoseIncreaseDegrees });
// Declared before the source video is run. No threshold tuning from its results.
const variants = [0.001, 0.003, 0.01, 0.03].map(weight => ({ ...REVIEW_HISTORY_OPTIONS, weight }));
const speedBudget = { guardedSelectorRatio: 2.25, guardedSelectorSlackMs: 25, endToEndRatio: 1.10 };
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA,
  baselineCommit: '04a41b80469980454758feba9a31ac48b92c11fd',
  fixtureSha256: sha(await fs.readFile(fixture)), catalogManifestSha256: sha(await fs.readFile('public/seed-catalog/manifest.json')),
  catalogTree: 'afcb8f68a8db87424fe5169896be0fd0a57dbf65', densityFps: 20,
  options: variants, qualityBudget: REVIEW_HISTORY_QUALITY_BUDGET, speedBudget,
  variants: [], selectorTiming: [], trials: [], checks: [], experimentCompleted: false, adoptionAccepted: false,
  physicalCameraVerified: false, hostedSiteVerified: false };
await fs.mkdir(out, { recursive: true });
assert.equal(report.fixtureSha256, 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b');
assert.equal(report.catalogManifestSha256, 'fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a');
const manifest = JSON.parse(await fs.readFile('public/seed-catalog/manifest.json', 'utf8'));
assert.equal(manifest.totalFaces, 70000); assert.equal(manifest.searchableFaces, 70000); assert.equal(manifest.poseStep, 3);
report.catalogId = manifest.catalogId;
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const originalWorker = await fs.readFile(path.join(baselineRoot, 'app/live/review-search.worker.ts'), 'utf8');
const optimizerPattern = /    const choices = optimizeDistinctProjectionSequence\(frames, beams, \{[\s\S]*?\n    \}\);/;
assert.equal((originalWorker.match(/const choices = optimizeDistinctProjectionSequence/g) || []).length, 1);
assert(optimizerPattern.test(originalWorker));
report.originalWorkerSha256 = sha(originalWorker);

async function workerBundle(identity, { capture = false, history = null } = {}) {
  let source = originalWorker;
  // Repeat the last progress sequence with a diagnostic payload. The ordinary
  // client ignores its duplicate sequence; an unknown message would be treated
  // as a malformed result and must never be injected into that protocol.
  if (capture) source = source.replace('    const pathStarted = performance.now();', '    scope.postMessage({ ...progress, historyProbe: { frames, beams } });\n    const pathStarted = performance.now();');
  if (history) {
    source = 'import {selectHistoryAwareReviewSequence} from ' + JSON.stringify(path.resolve('app/live/review-history-selection.ts')) + ';\n' + source;
    source = source.replace(optimizerPattern, '    const selection = selectHistoryAwareReviewSequence(frames, beams, ' + JSON.stringify(history) + ');\n    const choices = selection.choices;');
  }
  const built = await build({ stdin: { contents: source, sourcefile: 'history-experiment.worker.ts', resolveDir: path.join(baselineRoot, 'app/live'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    define: { __MF_BUILD_ID__: JSON.stringify(identity.build), __MF_REVISION__: JSON.stringify(identity.revision) } });
  return built.outputFiles[0].text;
}

let browser, page;
async function uiTrial(variant, index, { capture = false, history = null, native = false } = {}) {
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const base = variant === 'baseline' ? 'http://127.0.0.1:4185' : 'http://127.0.0.1:4183';
  const identity = await (await context.request.get(base + '/api/runtime')).json();
  const code = native ? null : await workerBundle(identity, { capture, history });
  if (code) await context.route('**/*review-search.worker*.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: code }));
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); }
      postMessage(message, ...rest) {
        if (Array.isArray(message?.frames) && message.build) {
          window.__historyInput = message.frames;
          this.addEventListener('message', event => {
            if (event.data?.historyProbe) window.__historyProbe = event.data.historyProbe;
            if (event.data?.type === 'result') window.__historyResult = { ...event.data, choices: event.data.choices.map(c => ({ id: c.candidate.id, time: c.frame.time, error: c.error, emission: c.emission, accepted: c.accepted, expressionMotion: c.expressionMotion })) };
          });
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/live', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__MANY_FACES_RUNTIME__?.phase === 'idle', null, { timeout: 45000 });
  const started = performance.now();
  await page.getByTestId('video-input').setInputFiles(fixture);
  await page.waitForFunction(() => window.__MANY_FACES_VERIFY__ || window.__MANY_FACES_RUNTIME__?.phase === 'error', null, { timeout: 600000 });
  const wallMs = performance.now() - started;
  const result = await page.evaluate(() => ({ report: window.__MANY_FACES_VERIFY__, runtime: window.__MANY_FACES_RUNTIME__, search: window.__historyResult, duration: document.querySelector('[data-testid="input-video"]').duration }));
  assert.equal(result.report?.passed, true, JSON.stringify(result.runtime));
  assert.equal(result.report.plannedFrames, Math.floor(result.duration * 20));
  assert(result.duration > 23); assert.equal(result.report.faceFrames, result.report.sequenceFrames);
  assert.equal(result.report.imageFailures, 0); assert.equal(errors.length, 0, errors.join(';'));
  assert.equal(result.search.build, identity.build); assert.equal(result.report.build, identity.build);
  const input = await page.evaluate(() => JSON.stringify(window.__historyInput, (_key, value) => ArrayBuffer.isView(value) ? { __typed: value.constructor.name, data: Array.from(value) } : value));
  let snapshot = null;
  if (capture) {
    snapshot = await page.evaluate(() => {
      const { frames, beams } = window.__historyProbe;
      const candidates = [], indexes = new Map();
      const compact = beams.map(beam => beam.map(({ candidate, error }) => {
        if (!indexes.has(candidate)) { indexes.set(candidate, candidates.length); candidates.push(candidate); }
        return { index: indexes.get(candidate), error };
      }));
      return JSON.stringify({ frames, candidates, beams: compact }, (_key, value) => ArrayBuffer.isView(value) ? { __typed: value.constructor.name, data: Array.from(value) } : value);
    });
    await fs.writeFile(path.join(out, 'same-video-ranking-snapshot.json.gz'), gzipSync(snapshot));
  }
  const trial = { variant, index, nativeWorker: native, diagnosticCapture: capture, identity, workerSha256: code ? sha(code) : null,
    wallMs, framesSha256: sha(input), ...result.report, choicesSha256: sha(result.search.choices), workerMetrics: result.search.performanceMetrics ?? null };
  await save(variant + '-' + index + '.json', { ...trial, choices: result.search.choices });
  emit('HISTORY_UI', { ...trial, sequenceIds: undefined });
  if (!capture) {
    await page.getByTestId('play-pause').click(); await page.waitForTimeout(400); await page.getByTestId('play-pause').click();
    await page.getByTestId('step-forward').click();
    assert(await page.getByTestId('input-video').evaluate(video => video.currentTime > 0 && video.paused));
    await page.getByTestId('review-seek').focus(); await page.keyboard.press('End');
    assert(await page.getByTestId('input-video').evaluate(video => video.currentTime > 20));
    await page.screenshot({ path: path.join(out, variant + '-' + index + '.png') });
  }
  await browser.close(); browser = null; page = null;
  return { trial, snapshot, choices: result.search.choices };
}

try {
  const captured = await uiTrial('baseline', 'capture', { capture: true });
  report.capture = { ...captured.trial, sequenceIds: undefined };
  const snapshot = JSON.parse(captured.snapshot, revive);
  const { frames, candidates } = snapshot;
  const beams = snapshot.beams.map(beam => beam.map(item => ({ candidate: candidates[item.index], error: item.error })));
  assert(frames.length > 300); assert.equal(frames.length, captured.trial.faceFrames);
  const original = optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
  assert.deepEqual(decisions(original), captured.choices, 'Node replay must exactly reproduce the current UI decisions from the same full-video beams');
  assert.deepEqual(optimizeHistoryAwareProjectionSequence(frames, beams, { ...REVIEW_HISTORY_OPTIONS, weight: 0 }), original);
  report.checks.push('same captured frames/ranked beams; exact baseline UI/Node replay and zero-weight equality');
  report.baseline = measureReviewSequence(original);
  await save('baseline-metrics.json', report.baseline);
  const outputs = new Map();
  for (const options of variants) {
    const trial = optimizeHistoryAwareProjectionSequence(frames, beams, options);
    assert.deepEqual(decisions(optimizeHistoryAwareProjectionSequence(frames, beams, options)), decisions(trial), 'determinism');
    const comparison = compareReviewSequences(original, trial, options.windowSeconds);
    // Measure every predeclared option, including rejected options. The guarded
    // path includes the baseline, history search and comparison even on fallback.
    const runSelector = variant => variant === 'baseline'
      ? optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS)
      : variant === 'raw' ? optimizeHistoryAwareProjectionSequence(frames, beams, options)
        : selectHistoryAwareReviewSequence(frames, beams, options).choices;
    for (const variant of ['baseline', 'raw', 'guarded']) runSelector(variant);
    const screeningTiming = [];
    for (const [index, variant] of ['baseline', 'raw', 'guarded', 'guarded', 'raw', 'baseline', 'baseline', 'guarded', 'raw'].entries()) {
      const started = performance.now();
      const result = runSelector(variant);
      const elapsedMs = performance.now() - started;
      const expected = variant === 'baseline' || (variant === 'guarded' && !comparison.accepted) ? original : trial;
      assert.deepEqual(decisions(result), decisions(expected), 'timed selection and fallback must reproduce the expected path');
      screeningTiming.push({ index, variant, elapsedMs });
    }
    const screeningMedianMs = Object.fromEntries(['baseline', 'raw', 'guarded'].map(name => [name, median(screeningTiming.filter(t => t.variant === name).map(t => t.elapsedMs))]));
    const record = { options, ...summary(comparison), choicesSha256: sha(decisions(trial)), screeningTiming, screeningMedianMs };
    report.variants.push(record); outputs.set(options.weight, trial);
    await save('weight-' + options.weight + '.json', { ...record, choices: decisions(trial) });
    emit('HISTORY_VARIANT', record);
  }
  // Prefer the largest actual reduction, then the lower unpenalized loss and
  // smallest weight. The fixed video is a development comparison, not holdout.
  const passing = report.variants.filter(value => value.accepted).sort((a, b) =>
    a.after.recentReappearances - b.after.recentReappearances ||
    a.after.objectiveWithoutHistory.mean - b.after.objectiveWithoutHistory.mean || a.options.weight - b.options.weight);
  report.recommended = passing[0]?.options ?? null;
  // Complete the full-video speed/control comparison even when quality rejects
  // every option. In that case measure the declared default with exact fallback,
  // and keep adoption false regardless of the timing or CI conclusion.
  report.uiEvaluationOptions = report.recommended ?? REVIEW_HISTORY_OPTIONS;
  report.uiEvaluationMode = report.recommended ? 'accepted-history-path' : 'baseline-fallback';
  {
    const evaluatedOptions = report.uiEvaluationOptions;
    const chosen = report.recommended ? outputs.get(report.recommended.weight) : original;
    const selected = selectHistoryAwareReviewSequence(frames, beams, evaluatedOptions);
    assert.equal(selected.diagnostics.adopted, Boolean(report.recommended));
    assert.deepEqual(decisions(selected.choices), decisions(chosen));
    // All operational work (original search path + history path + quality gate)
    // is included in the guarded measurement. Warmup is excluded equally.
    for (const variant of ['baseline', 'guarded']) {
      if (variant === 'baseline') optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS);
      else selectHistoryAwareReviewSequence(frames, beams, evaluatedOptions);
    }
    for (const [index, variant] of ['baseline', 'guarded', 'guarded', 'baseline', 'baseline', 'guarded'].entries()) {
      const started = performance.now();
      const result = variant === 'baseline' ? optimizeDistinctProjectionSequence(frames, beams, REVIEW_SEQUENCE_OPTIONS) : selectHistoryAwareReviewSequence(frames, beams, evaluatedOptions).choices;
      const elapsedMs = performance.now() - started;
      assert.deepEqual(decisions(result), decisions(variant === 'baseline' ? original : chosen));
      report.selectorTiming.push({ index, variant, elapsedMs });
    }
    report.selectorMedianMs = Object.fromEntries(['baseline', 'guarded'].map(name => [name, median(report.selectorTiming.filter(t => t.variant === name).map(t => t.elapsedMs))]));
    report.selectorSpeedPassed = report.selectorMedianMs.guarded <= report.selectorMedianMs.baseline * speedBudget.guardedSelectorRatio + speedBudget.guardedSelectorSlackMs;
    const nativeConnected = (await fs.readFile('app/live/review-search.worker.ts', 'utf8')).includes('selectHistoryAwareReviewSequence');
    report.nativeConnected = nativeConnected;
    for (const [index, variant] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
      const run = await uiTrial(variant, index, { history: variant === 'candidate' ? evaluatedOptions : null, native: nativeConnected });
      assert.equal(run.trial.framesSha256, captured.trial.framesSha256, 'Acquired input changed between variants');
      assert.deepEqual(run.choices, decisions(variant === 'baseline' ? original : chosen));
      assert.deepEqual(run.trial.searchTraffic, captured.trial.searchTraffic, 'candidate data coverage changed');
      report.trials.push({ ...run.trial, sequenceIds: undefined });
    }
    report.endToEndMedianMs = Object.fromEntries(['baseline', 'candidate'].map(name => [name, median(report.trials.filter(t => t.variant === name).map(t => t.wallMs))]));
    report.endToEndSpeedPassed = report.endToEndMedianMs.candidate <= report.endToEndMedianMs.baseline * speedBudget.endToEndRatio;
    report.adoptionAccepted = Boolean(report.recommended) && report.selectorSpeedPassed && report.endToEndSpeedPassed;
    report.checks.push('full 23.3-second ABBA with fresh browser profiles, identical detected frames and candidate traffic; playback, pause, frame step and seek');
  }
  report.experimentCompleted = true;
} catch (error) {
  report.error = String(error.stack || error);
  if (page && !page.isClosed()) {
    report.failure = await page.evaluate(() => ({ runtime: window.__MANY_FACES_RUNTIME__, alert: document.querySelector('[role="alert"]')?.textContent })).catch(() => null);
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  await browser?.close(); report.finishedAt = new Date().toISOString();
  await save('report.json', report);
  emit('HISTORY_FINAL', { ...report, variants: report.variants.map(v => ({ options: v.options, accepted: v.accepted, reasons: v.reasons, unique: v.after.uniqueImages, recent: v.after.recentReappearances, total: v.after.reappearances })), trials: report.trials.map(t => ({ variant: t.variant, wallMs: t.wallMs, phaseTimingsMs: t.phaseTimingsMs, framesSha256: t.framesSha256 })), capture: report.capture ? { ...report.capture, workerMetrics: undefined } : undefined, baseline: report.baseline ? { ...report.baseline, reentryEvents: undefined } : undefined });
}
