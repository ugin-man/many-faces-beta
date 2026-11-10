import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Use the real upload/review UI and real inference. The public fixture, its full
// duration and the default 30 fps are fixed before either implementation runs.
// Usage: node scripts/verify-video-pipeline.mjs [--mode all|exact|default|cancellation]
//        [--baseline URL] [--improved URL] [--out DIR] [--timeout-ms NUMBER]
//        [--budget-ms NUMBER] [--skip-cancel]
// `exact` compares the old acquisition path on both versions. The default
// decoder is a separate comparison: a different decoded input is reported,
// never silently treated as an exact matcher comparison.
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'public/demo/many-faces-sample-30fps.mp4');
const config = {
  mode: 'all', baseline: 'http://127.0.0.1:4185', improved: 'http://127.0.0.1:4183',
  out: path.join(repo, 'work/video-pipeline'), timeoutMs: 15 * 60 * 1000,
  budgetMs: 30 * 60 * 1000, skipCancel: false,
};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--skip-cancel') { config.skipCancel = true; continue; }
  const key = {'--mode': 'mode', '--baseline': 'baseline', '--improved': 'improved', '--out': 'out', '--timeout-ms': 'timeoutMs', '--budget-ms': 'budgetMs'}[argument];
  if (!key || !process.argv[index + 1]) throw new Error(`Unknown or incomplete option: ${argument}`);
  const value = process.argv[++index];
  config[key] = key === 'timeoutMs' || key === 'budgetMs' ? Number(value) : value;
}
assert.ok(['all', 'exact', 'default', 'cancellation'].includes(config.mode), 'Invalid --mode');
assert.ok(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0, 'Invalid --timeout-ms');
assert.ok(Number.isFinite(config.budgetMs) && config.budgetMs > 0, 'Invalid --budget-ms');
config.out = path.resolve(config.out);
const publish = path.join(config.out, 'publish');
await fs.mkdir(publish, {recursive: true});

const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const writeJson = (name, value, pretty = true) => fs.writeFile(path.join(config.out, name), JSON.stringify(value, null, pretty ? 2 : undefined));
const logs = [];
async function log(event, detail) {
  const line = JSON.stringify({at: new Date().toISOString(), event, ...detail});
  logs.push(line); console.log(`VIDEO_PIPELINE ${line}`);
  await fs.writeFile(path.join(config.out, 'run.jsonl'), `${logs.join('\n')}\n`);
}

const report = {
  startedAt: new Date().toISOString(), config, densityFps: 30,
  fixture: {path: 'public/demo/many-faces-sample-30fps.mp4', sha256: createHash('sha256').update(await fs.readFile(fixture)).digest('hex')},
  environment: {node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), chromePath: process.env.CHROME_PATH || '/usr/bin/chromium'},
  methodology: {
    cold: 'Fresh Chromium process and context for each cold trial; same executable and launch settings. Server/OS caches are not reset.',
    warm: 'Same page and worker, same full file selected again immediately after the default cold trial.',
    timing: 'Upload selection through completed UI report; worker input/output observations are included. Phase timings are also saved. Polling adds at most roughly 200 ms when the page is responsive.',
    equality: 'Compare every sampled time, feature, projection, layout and roll flag, then every choice ID, time, error field, emission, acceptance and expressionMotion. Unused structure/surface arrays are excluded.',
    evidence: 'One ordered cold trial per variant and one warm repeat are diagnostic observations, not statistical speed estimates.',
    inference: 'No face, frame, catalog or candidate mocks. Cancellation alone holds real shard requests and is excluded from timing comparisons.',
  },
  trials: [], comparisons: [], cancellation: null, failures: [], passed: false,
};

// CI uploads this explicit aggregate projection, never the local diagnostic
// directory. Per-frame coordinates, choices and sequence ID arrays stay local.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const briefError = value => String(value ?? '').split('\n')[0].slice(0, 500);
const aggregateMetrics = value => {
  if (Array.isArray(value)) return undefined;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => !Array.isArray(entry)).map(([key, entry]) => [key, aggregateMetrics(entry)]));
};
function publicComparison(comparison) {
  return pick(comparison, ['label', 'before', 'after', 'status', 'requireExactInputs', 'sameInputs', 'sameChoices',
    'frameCounts', 'observedSpeed', 'beforePhaseTimingsMs', 'afterPhaseTimingsMs', 'inputDrift', 'choiceChanges', 'passed', 'interpretation']);
}
async function publishSummary() {
  await fs.writeFile(path.join(publish, 'summary.json'), JSON.stringify({
    schemaVersion: 1, startedAt: report.startedAt, finishedAt: report.finishedAt,
    config: pick(config, ['mode', 'baseline', 'improved', 'timeoutMs', 'budgetMs', 'skipCancel']),
    fixture: report.fixture, densityFps: report.densityFps, environment: report.environment, methodology: report.methodology,
    artifactPolicy: 'Aggregate results, hashes, runtime identities and screenshots of the fixed public composite only; no raw face frames or per-frame choices.',
    trials: report.trials.map(trial => ({
      ...pick(trial, ['label', 'temperature', 'url', 'browser', 'identity', 'duration', 'wallMs', 'hashes', 'controls', 'screenshot', 'passed']),
      verification: pick(trial.report, ['analysisFps', 'plannedFrames', 'faceFrames', 'sequenceFrames', 'selectedImages', 'imageFailures',
        'outputChanges', 'uniqueFaces', 'processingMs', 'phaseTimingsMs', 'sequenceFingerprint', 'canvasNonBlank', 'faceCoverage',
        'passed', 'reasons', 'frameEvidence', 'inputBuild', 'build', 'searchTraffic', 'matching']),
      analysisMetrics: aggregateMetrics(trial.report?.analysisMetrics), searchMetrics: aggregateMetrics(trial.search?.performanceMetrics),
      observation: pick(trial.worker, ['jobId', 'build', 'inputObservationMs', 'outputObservationMs']),
      rejectedProfileFrames: trial.report?.poseContinuity?.rejectedFrames,
      profileIntervals: trial.report?.poseContinuity?.intervals?.length,
      pageErrorCount: trial.pageErrors?.length ?? 0, consoleErrorCount: trial.consoleErrors?.length ?? 0,
      failedRequestCount: trial.failedRequests?.length ?? 0, httpErrorCount: trial.httpErrors?.length ?? 0,
      failurePhase: trial.failure?.runtime?.phase, error: trial.error ? briefError(trial.error) : undefined,
    })),
    comparisons: report.comparisons.map(publicComparison),
    cancellation: report.cancellation ? {
      ...pick(report.cancellation, ['passed', 'interceptedShards', 'cancelToIdleMs', 'recoveryTrial']),
      phaseAfterRelease: report.cancellation.afterRelease?.runtime?.phase,
      pageErrorCount: report.cancellation.pageErrors?.length ?? 0,
      error: report.cancellation.error ? briefError(report.cancellation.error) : undefined,
    } : null,
    failures: report.failures.map(failure => ({...pick(failure, ['trial', 'comparison', 'check']), error: briefError(failure.error)})),
    passed: report.passed,
  }, null, 2));
}

let stopRequested = null;
const browsers = new Set();
async function requestStop(reason) {
  if (stopRequested) return;
  stopRequested = reason;
  report.failures.push({check: 'execution-budget', error: reason});
  await publishSummary();
  await Promise.allSettled([...browsers].map(browser => browser.close()));
}
const budgetTimer = setTimeout(() => { void requestStop(`Harness exceeded its ${config.budgetMs} ms total budget`); }, config.budgetMs);
const stopForSignal = signal => { void requestStop(`Harness interrupted by ${signal}`); };
process.once('SIGTERM', stopForSignal); process.once('SIGINT', stopForSignal);

function installWorkerProbe() {
  const probe = window.__VIDEO_PIPELINE_PROBE__ = {records: [], workers: [], nextWorkerId: 0};
  // Preserve -0 and non-finite numbers through JSON artifacts and hashes.
  const snapshot = value => {
    if (typeof value === 'number') {
      if (Object.is(value, -0)) return {$number: '-0'};
      if (!Number.isFinite(value)) return {$number: String(value)};
      return value;
    }
    if (value === undefined) return {$undefined: true};
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, snapshot);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
  };
  const jobId = message => message.jobId ?? message.runId ?? null;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.__pipelineWorkerId = ++probe.nextWorkerId;
      this.__pipelineWorkerUrl = new URL(String(url), location.href).href;
      probe.workers.push({workerId: this.__pipelineWorkerId, url: this.__pipelineWorkerUrl});
      this.addEventListener('message', event => {
        const message = event.data;
        if (!message || !['progress', 'result', 'error'].includes(message.type)) return;
        const record = probe.records.findLast(item => item.workerId === this.__pipelineWorkerId && item.jobId === jobId(message));
        if (!record) return;
        if (message.type === 'progress') { record.lastProgress = snapshot(message); return; }
        if (message.type === 'error') { record.error = snapshot(message); return; }
        if (!Array.isArray(message.choices)) return;
        const started = performance.now();
        record.result = {
          jobId: jobId(message), build: message.build,
          candidateSearchMs: message.candidateSearchMs, pathOptimizationMs: message.pathOptimizationMs,
          performanceMetrics: snapshot(message.performanceMetrics ?? null),
          choices: message.choices.map(choice => snapshot({
            id: choice.candidate.id, time: choice.frame.time, error: choice.error,
            emission: choice.emission, accepted: choice.accepted, expressionMotion: choice.expressionMotion,
          })),
        };
        record.resultObservedAt = started;
        record.outputObservationMs = performance.now() - started;
      });
    }
    postMessage(message, ...rest) {
      if (Array.isArray(message?.frames) && message.build) {
        const started = performance.now();
        const record = {
          workerId: this.__pipelineWorkerId, workerUrl: this.__pipelineWorkerUrl,
          jobId: jobId(message), build: message.build, submittedAt: started,
          frames: message.frames.map(frame => snapshot({
            time: frame.time, feature: frame.feature,
            geometry: {projection: frame.geometry.projection, layout: frame.geometry.layout},
            compensateRoll: frame.compensateRoll,
          })),
        };
        record.inputObservationMs = performance.now() - started;
        probe.records.push(record);
      }
      return super.postMessage(message, ...rest);
    }
  };
}

async function openSession(origin, query = '') {
  if (stopRequested) throw new Error(stopRequested);
  const browser = await chromium.launch({
    executablePath: report.environment.chromePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });
  browsers.add(browser); browser.once('disconnected', () => browsers.delete(browser));
  try {
    if (stopRequested) throw new Error(stopRequested);
    const context = await browser.newContext({viewport: {width: 1280, height: 900}, serviceWorkers: 'block'});
    await context.addInitScript(installWorkerProbe);
    const page = await context.newPage();
    const session = {browser, context, page, origin, query, pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [], version: browser.version()};
    page.on('pageerror', error => session.pageErrors.push({at: Date.now(), message: error.message}));
    page.on('console', message => { if (message.type() === 'error') session.consoleErrors.push({at: Date.now(), text: message.text()}); });
    context.on('requestfailed', request => session.failedRequests.push({at: Date.now(), url: request.url(), resourceType: request.resourceType(), failure: request.failure()?.errorText}));
    context.on('response', response => { if (response.status() >= 400) session.httpErrors.push({at: Date.now(), url: response.url(), status: response.status()}); });
    const identityResponse = await context.request.get(`${origin}/api/runtime`);
    assert.ok(identityResponse.ok(), `Runtime identity returned ${identityResponse.status()}`);
    session.identity = await identityResponse.json();
    const expectedRevision = origin === config.baseline ? process.env.VIDEO_PIPELINE_BASELINE_SHA : process.env.VIDEO_PIPELINE_IMPROVED_SHA;
    if (expectedRevision) assert.equal(session.identity.revision, expectedRevision, 'Production server revision does not match the requested source');
    await page.goto(`${origin}/live${query}`, {waitUntil: 'domcontentloaded', timeout: 120000});
    await page.waitForFunction(() => window.__MANY_FACES_RUNTIME__?.phase === 'idle', null, {timeout: 120000});
    // CallStage mounts the density control only while its settings sheet is
    // open. Inspect the real default through the normal UI without changing it.
    await page.getByTestId('settings').click();
    assert.equal(await page.getByTestId('analysis-fps').inputValue(), '30', 'The normal UI must default to 30 fps');
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', {name: /^(?:Close|閉じる)$/}).click();
    await settings.waitFor({state: 'hidden'});
    return session;
  } catch (error) { await browser.close(); throw error; }
}

const readStatus = page => page.evaluate(() => ({
  runtime: window.__MANY_FACES_RUNTIME__, alert: document.querySelector('[role="alert"]')?.textContent,
  completed: Boolean(window.__MANY_FACES_VERIFY__ && window.__VIDEO_PIPELINE_PROBE__.records.some(record => record.result) && window.__MANY_FACES_RUNTIME__?.phase === 'review'),
  search: window.__VIDEO_PIPELINE_PROBE__.records.at(-1)?.lastProgress ?? null,
}));

async function waitForResult(session, label, started, history) {
  let lastPhase, lastLogAt = 0;
  while (true) {
    const status = await readStatus(session.page);
    const elapsedMs = performance.now() - started;
    if (status.runtime?.phase !== lastPhase || elapsedMs - lastLogAt >= 15000) {
      history.push({elapsedMs, ...status});
      await log('progress', {trial: label, elapsedMs: Math.round(elapsedMs), ...status});
      lastPhase = status.runtime?.phase; lastLogAt = elapsedMs;
    }
    if (status.runtime?.phase === 'error') throw new Error(`Application error: ${JSON.stringify(status)}`);
    if (status.completed) return elapsedMs;
    if (elapsedMs > config.timeoutMs) throw new Error(`Full-video timeout: ${JSON.stringify(status)}`);
    await session.page.waitForTimeout(200);
  }
}

async function canvasEvidence(page) {
  return page.getByTestId('output-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d');
    const {width, height} = canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    let samples = 0, visible = 0, minimum = 255, maximum = 0;
    const colors = new Set();
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 48))) {
      for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 48))) {
        const offset = (y * width + x) * 4;
        samples++;
        if (pixels[offset + 3] === 0) continue;
        visible++;
        const [red, green, blue] = pixels.subarray(offset, offset + 3);
        minimum = Math.min(minimum, red, green, blue); maximum = Math.max(maximum, red, green, blue);
        colors.add((red << 16) | (green << 8) | blue);
      }
    }
    return {width, height, samples, visible, colors: colors.size, range: maximum - minimum,
      nonBlank: visible > 0 && colors.size > 1 && maximum - minimum > 8};
  });
}

async function checkReviewControls(page, duration) {
  const evidence = {initialCanvas: await canvasEvidence(page)};
  assert.equal(evidence.initialCanvas.nonBlank, true, 'Initial output canvas is blank');
  await page.getByTestId('play-pause').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="input-video"]').currentTime > 0.1, null, {timeout: 10000});
  await page.waitForTimeout(650);
  await page.getByTestId('play-pause').click();
  evidence.paused = await page.getByTestId('input-video').evaluate(video => ({time: video.currentTime, paused: video.paused}));
  assert.ok(evidence.paused.paused && evidence.paused.time > 0, 'Playback/pause did not advance the video');
  await page.getByTestId('step-forward').click();
  await page.waitForFunction(time => document.querySelector('[data-testid="input-video"]').currentTime > time, evidence.paused.time, {timeout: 5000});
  evidence.frameStep = await page.getByTestId('input-video').evaluate(video => video.currentTime);
  await page.getByTestId('review-seek').focus(); await page.keyboard.press('End');
  await page.waitForFunction(end => {
    const video = document.querySelector('[data-testid="input-video"]');
    return !video.seeking && video.currentTime >= end * 0.95;
  }, duration, {timeout: 10000});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  evidence.endTime = await page.getByTestId('input-video').evaluate(video => video.currentTime);
  evidence.endCanvas = await canvasEvidence(page);
  assert.equal(evidence.endCanvas.nonBlank, true, 'Output canvas is blank after seek to end');
  await page.getByTestId('review-seek').focus(); await page.keyboard.press('Home');
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-testid="input-video"]');
    return !video.seeking && video.currentTime < 0.05;
  }, null, {timeout: 10000});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  evidence.returnCanvas = await canvasEvidence(page);
  assert.equal(evidence.returnCanvas.nonBlank, true, 'Output canvas is blank after seek to start');
  return evidence;
}

async function runTrial(session, label, temperature) {
  if (stopRequested) throw new Error(stopRequested);
  const trial = {label, temperature, url: `${session.origin}/live${session.query}`, browser: session.version, identity: session.identity, history: [], passed: false};
  const eventStart = Date.now();
  try {
    await session.page.evaluate(() => { window.__VIDEO_PIPELINE_PROBE__.records = []; });
    const started = performance.now();
    await session.page.getByTestId('video-input').setInputFiles(fixture);
    trial.wallMs = await waitForResult(session, label, started, trial.history);
    const observed = await session.page.evaluate(() => ({
      report: window.__MANY_FACES_VERIFY__, runtime: window.__MANY_FACES_RUNTIME__,
      duration: document.querySelector('[data-testid="input-video"]').duration,
      record: window.__VIDEO_PIPELINE_PROBE__.records.findLast(record => record.result),
    }));
    trial.duration = observed.duration; trial.report = observed.report; trial.runtime = observed.runtime;
    const {frames, result, ...worker} = observed.record;
    const {choices, ...search} = result;
    trial.worker = worker; trial.search = search;
    trial.files = {frames: `${label}.frames.json`, choices: `${label}.choices.json`};
    trial.hashes = {frames: hash(frames), times: hash(frames.map(frame => frame.time)), features: hash(frames.map(frame => frame.feature)),
      projection: hash(frames.map(frame => frame.geometry.projection)), layout: hash(frames.map(frame => frame.geometry.layout)), choices: hash(choices)};
    await writeJson(trial.files.frames, frames, false); await writeJson(trial.files.choices, choices, false);
    assert.equal(observed.report?.passed, true, `Verification gate: ${JSON.stringify(observed.report?.reasons)}`);
    assert.ok(observed.duration > 35 && observed.duration < 36, 'Unexpected fixture duration or truncated input');
    assert.equal(observed.report.plannedFrames, Math.floor(observed.duration * 30), 'Full default-density sample count changed');
    if (observed.report.analysisFps !== undefined) assert.equal(observed.report.analysisFps, 30);
    assert.equal(observed.report.faceFrames, frames.length, 'Worker did not receive all admitted frames');
    assert.equal(observed.report.sequenceFrames, frames.length, 'Sequence lost admitted frames');
    assert.equal(choices.length, frames.length, 'Worker result lost admitted frames');
    assert.deepEqual(observed.report.sequenceIds, choices.map(choice => choice.id), 'Displayed sequence differs from worker output');
    assert.equal(observed.report.imageFailures, 0, 'A selected output image failed to load');
    assert.equal(observed.report.canvasNonBlank, true, 'Application reports a blank canvas');
    trial.controls = await checkReviewControls(session.page, observed.duration);
    assert.equal(session.pageErrors.length, 0, `Uncaught page errors: ${JSON.stringify(session.pageErrors)}`);
    trial.passed = true;
  } catch (error) {
    trial.error = error.stack || String(error);
    trial.failure = await readStatus(session.page).catch(() => null);
    report.failures.push({trial: label, error: trial.error});
  } finally {
    trial.pageErrors = session.pageErrors.filter(event => event.at >= eventStart);
    trial.consoleErrors = session.consoleErrors.filter(event => event.at >= eventStart);
    trial.failedRequests = session.failedRequests.filter(event => event.at >= eventStart);
    trial.httpErrors = session.httpErrors.filter(event => event.at >= eventStart);
    if (!session.page.isClosed() && !stopRequested) {
      try {
        trial.screenshot = `${label}.png`;
        await session.page.screenshot({path: path.join(publish, trial.screenshot), timeout: 10000});
      } catch { delete trial.screenshot; }
    }
    await writeJson(`${label}.json`, trial);
    report.trials.push(trial);
    await publishSummary();
    await log('trial', {label, passed: trial.passed, wallMs: trial.wallMs, processingMs: trial.report?.processingMs,
      phaseTimingsMs: trial.report?.phaseTimingsMs, analysisMetrics: trial.report?.analysisMetrics,
      searchMetrics: trial.search?.performanceMetrics, hashes: trial.hashes, error: trial.error ? briefError(trial.error) : undefined});
  }
  return trial;
}

function firstDifference(left, right, location = '$') {
  if (Object.is(left, right)) return null;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return {path: location, before: left, after: right};
  if (Array.isArray(left) !== Array.isArray(right)) return {path: location, beforeType: typeof left, afterType: typeof right};
  if (Array.isArray(left) && left.length !== right.length) return {path: `${location}.length`, before: left.length, after: right.length};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const mismatch = firstDifference(left[key], right[key], `${location}${Array.isArray(left) ? `[${key}]` : `.${key}`}`);
    if (mismatch) return mismatch;
  }
  return null;
}

function inputDrift(before, after) {
  const previous = new Map(before.map(frame => [canonical(frame.time), frame]));
  const fields = {feature: {count: 0, changed: 0, maxAbs: 0, sumAbs: 0}, projection: {count: 0, changed: 0, maxAbs: 0, sumAbs: 0}, layout: {count: 0, changed: 0, maxAbs: 0, sumAbs: 0}};
  let sharedTimes = 0;
  for (const frame of after) {
    const old = previous.get(canonical(frame.time));
    if (!old) continue;
    sharedTimes++;
    for (const [key, stats] of Object.entries(fields)) {
      const left = key === 'feature' ? old.feature : old.geometry[key];
      const right = key === 'feature' ? frame.feature : frame.geometry[key];
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (typeof left[index] !== 'number' || typeof right[index] !== 'number') continue;
        const delta = Math.abs(left[index] - right[index]);
        stats.count++; if (delta !== 0) stats.changed++;
        stats.sumAbs += delta; stats.maxAbs = Math.max(stats.maxAbs, delta);
      }
    }
  }
  return {sharedTimes, beforeOnlyTimes: before.length - sharedTimes, afterOnlyTimes: after.length - sharedTimes,
    fields: Object.fromEntries(Object.entries(fields).map(([key, stats]) => [key, {...stats, meanAbs: stats.count ? stats.sumAbs / stats.count : 0}]))};
}

async function compareTrials(before, after, label, requireExactInputs) {
  if (!before?.hashes || !after?.hashes) {
    report.comparisons.push({label, status: 'incomplete', before: before?.label, after: after?.label}); return;
  }
  const comparison = {label, before: before.label, after: after.label, requireExactInputs,
    sameInputs: before.hashes.frames === after.hashes.frames, sameChoices: before.hashes.choices === after.hashes.choices,
    frameCounts: {before: before.report.faceFrames, after: after.report.faceFrames},
    observedSpeed: {wallRatio: before.wallMs / after.wallMs, processingRatio: before.report.processingMs / after.report.processingMs},
    beforePhaseTimingsMs: before.report.phaseTimingsMs, afterPhaseTimingsMs: after.report.phaseTimingsMs,
  };
  if (!comparison.sameInputs) {
    const left = JSON.parse(await fs.readFile(path.join(config.out, before.files.frames), 'utf8'));
    const right = JSON.parse(await fs.readFile(path.join(config.out, after.files.frames), 'utf8'));
    comparison.inputDifference = firstDifference(left, right);
    comparison.inputDrift = inputDrift(left, right);
  }
  if (!comparison.sameChoices) {
    const left = JSON.parse(await fs.readFile(path.join(config.out, before.files.choices), 'utf8'));
    const right = JSON.parse(await fs.readFile(path.join(config.out, after.files.choices), 'utf8'));
    comparison.choiceDifference = firstDifference(left, right);
    const atTime = new Map(left.map(choice => [canonical(choice.time), choice]));
    comparison.choiceChanges = {sharedTimes: 0, id: 0, accepted: 0};
    for (const choice of right) {
      const old = atTime.get(canonical(choice.time)); if (!old) continue;
      comparison.choiceChanges.sharedTimes++;
      if (choice.id !== old.id) comparison.choiceChanges.id++;
      if (choice.accepted !== old.accepted) comparison.choiceChanges.accepted++;
    }
  }
  comparison.passed = (!requireExactInputs || comparison.sameInputs) && (!comparison.sameInputs || comparison.sameChoices);
  comparison.interpretation = comparison.sameInputs
    ? (comparison.sameChoices ? 'All matcher inputs and complete decisions are identical.' : 'Identical matcher inputs produced different decisions; exactness failed.')
    : (requireExactInputs ? 'The legacy acquisition comparison changed inputs; exact pipeline equivalence is not established.' : 'Acquisition inputs differ. Timing and decision drift are reported separately from exact matcher equivalence.');
  if (!comparison.passed) report.failures.push({comparison: label, error: comparison.interpretation});
  report.comparisons.push(comparison); await publishSummary(); await log('comparison', publicComparison(comparison));
}

async function verifyCancellation() {
  const cancellation = {passed: false, interceptedShards: 0, history: []};
  let session, unblock;
  try {
    session = await openSession(config.improved);
    const blocked = new Promise(resolve => { unblock = resolve; });
    const matcher = url => /^\/api\/catalog\/(?:review-)?shard$/.test(url.pathname);
    const handler = async route => { cancellation.interceptedShards++; await blocked; await route.abort().catch(() => {}); };
    await session.context.route(matcher, handler);
    const started = performance.now();
    await session.page.getByTestId('video-input').setInputFiles(fixture);
    let lastPhase, lastLogAt = 0;
    while (cancellation.interceptedShards === 0) {
      const status = await readStatus(session.page);
      const elapsedMs = performance.now() - started;
      if (status.runtime?.phase !== lastPhase || elapsedMs - lastLogAt >= 15000) {
        cancellation.history.push({elapsedMs, ...status});
        await log('cancellation-progress', {elapsedMs: Math.round(elapsedMs), ...status});
        lastPhase = status.runtime?.phase; lastLogAt = elapsedMs;
      }
      if (status.runtime?.phase === 'error' || status.completed) throw new Error(`Did not intercept a live shard request: ${JSON.stringify(status)}`);
      if (elapsedMs > config.timeoutMs) throw new Error('Timed out waiting for a real catalog request');
      await session.page.waitForTimeout(200);
    }
    const clicked = performance.now();
    await session.page.getByTestId('cancel-analysis').click();
    await session.page.waitForFunction(() => window.__MANY_FACES_RUNTIME__?.phase === 'idle', null, {timeout: 5000});
    cancellation.cancelToIdleMs = performance.now() - clicked;
    assert.equal(await session.page.evaluate(() => Boolean(window.__MANY_FACES_VERIFY__)), false, 'Cancellation published a successful result');
    unblock(); await session.context.unroute(matcher, handler); await session.page.waitForTimeout(750);
    cancellation.afterRelease = await readStatus(session.page);
    assert.equal(cancellation.afterRelease.runtime.phase, 'idle', 'Cancelled work restarted after its response arrived');
    assert.equal(await session.page.evaluate(() => Boolean(window.__MANY_FACES_VERIFY__)), false, 'Cancelled work published a late result');
    assert.equal(session.pageErrors.length, 0, JSON.stringify(session.pageErrors));
    cancellation.recoveryTrial = (await runTrial(session, 'cancel-recovery', 'recovery, excluded from cold timing')).label;
    assert.equal(report.trials.at(-1).passed, true, 'Full-video retry after cancellation failed');
    cancellation.passed = true;
  } catch (error) {
    cancellation.error = error.stack || String(error);
    report.failures.push({check: 'cancellation', error: cancellation.error});
  } finally {
    unblock?.();
    if (session) { cancellation.pageErrors = session.pageErrors; await session.browser.close(); }
    report.cancellation = cancellation;
    await publishSummary();
    await writeJson('cancellation.json', cancellation); await log('cancellation', cancellation);
  }
}

let activeSession;
try {
  await log('start', {config, fixture: report.fixture, environment: report.environment});
  let baseline, exact, cold;
  if (config.mode === 'all' || config.mode === 'exact') {
    activeSession = await openSession(config.baseline);
    baseline = await runTrial(activeSession, 'baseline-cold', 'cold');
    await activeSession.browser.close(); activeSession = null;
    activeSession = await openSession(config.improved, '?mfDecoder=video-element&mfFaceMode=IMAGE&mfFaceDelegate=CPU&mfFaceExecution=main-thread');
    exact = await runTrial(activeSession, 'improved-exact-cold', 'cold');
    await activeSession.browser.close(); activeSession = null;
    await compareTrials(baseline, exact, 'legacy-acquisition-exact-pipeline', true);
  }
  if (config.mode === 'all' || config.mode === 'default') {
    activeSession = await openSession(config.improved);
    cold = await runTrial(activeSession, 'improved-default-cold', 'cold');
    const warm = await runTrial(activeSession, 'improved-default-warm', 'warm');
    await activeSession.browser.close(); activeSession = null;
    if (baseline) await compareTrials(baseline, cold, 'baseline-to-default-pipeline', false);
    if (exact) await compareTrials(exact, cold, 'legacy-to-default-acquisition', false);
    await compareTrials(cold, warm, 'default-cold-to-warm', false);
  }
  if (config.mode === 'cancellation' || (config.mode === 'all' && !config.skipCancel)) await verifyCancellation();
  report.passed = report.failures.length === 0 && report.trials.every(trial => trial.passed);
} catch (error) {
  report.failures.push({check: 'harness', error: error.stack || String(error)});
  if (activeSession) report.failureState = await readStatus(activeSession.page).catch(() => null);
} finally {
  clearTimeout(budgetTimer);
  process.removeListener('SIGTERM', stopForSignal); process.removeListener('SIGINT', stopForSignal);
  await Promise.allSettled([...browsers].map(browser => browser.close()));
  report.finishedAt = new Date().toISOString();
  await writeJson('browser-report.json', report);
  await publishSummary();
  await log('finished', {passed: report.passed, trials: report.trials.map(trial => ({label: trial.label, passed: trial.passed, wallMs: trial.wallMs})), failures: report.failures, report: path.join(config.out, 'browser-report.json')});
  if (!report.passed) process.exitCode = 1;
}
