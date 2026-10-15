#!/usr/bin/env node
/**
 * Compare already-built local servers; never builds the application or publishes.
 *
 * Required: CLEAN_BASELINE_APP_ROOT=/absolute/path/to/accepted-baseline,
 * CLEAN_BASELINE_CATALOG_ROOT=/absolute/path/to/old/public/seed-catalog
 * Optional: CLEAN_CANDIDATE_CATALOG_ROOT (defaults to public/seed-catalog),
 * CLEAN_BASELINE_URL (http://127.0.0.1:4185), CLEAN_CANDIDATE_URL (:4183),
 * CLEAN_REPORT_DIR, CLEAN_TRIAL_TIMEOUT_MS, CLEAN_TOTAL_TIMEOUT_MS, CHROME_PATH.
 * Run with Node >=22.13 after installing the project's browser tools and esbuild.
 * Catalogs and production servers must remain immutable throughout the run.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ACCEPTED_BASELINE, BASELINE_CLIENT_SHA256, assertBaselineInitialRecovery, assertComparisonContract, assertKnownBaselineInitialFailure} from './clean-catalog-comparison-contract.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fixture = path.join(repo, 'public/test-fixtures/reference-face-motion.mp4');
const fixtureHash = 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b';
const out = path.resolve(process.env.CLEAN_REPORT_DIR || path.join(repo, 'work/clean-catalog-verification'));
const hash = value => createHash('sha256').update(ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const signal = new AbortController();
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), fixture, fixtureSha256: null,
  densityFps: 20, expectedPlannedFrames: 466, trials: [], checks: [], failures: [],
  localProductionServers: true, physicalCameraVerified: false, hostedSiteVerified: false,
  independentHumanLabels: false, qualityImprovementEstablished: false, passed: false,
  limits: [
    'One complete video trial per catalog; timings are diagnostic, not an ABBA speed benchmark.',
    'Physical inventory validates local image bytes, the served manifest and downloaded shards, not every served image.',
    'Fresh output pixels use the current MediaPipe model; these are not independent human labels.',
    'Camera capture, camera tracking, physical devices and Site publication are not tested here.',
  ],
};
let browser, page, totalTimer, probeCode, chromium, baselineAppRoot;

async function baselineSourceIdentity(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trimEnd();
  const commit = git('rev-parse', 'HEAD');
  assert.equal(commit, ACCEPTED_BASELINE, 'Baseline application must remain the original accepted commit');
  git('diff', '--exit-code', ACCEPTED_BASELINE, '--', 'app', 'worker', 'build', 'public', 'package.json', 'package-lock.json', 'vite.config.ts', '.openai');
  const file = 'app/live/review-client-lite.tsx', sha256 = hash(await fs.readFile(path.join(root, file), {signal: signal.signal}));
  assert.equal(sha256, BASELINE_CLIENT_SHA256, 'Complete baseline client source differs from the known original');
  const source = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', 'import {buildIdentity} from "./build/runtime-identity.ts"; console.log(JSON.stringify(buildIdentity()));'], {cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024}));
  assert.equal(source.revision, commit);
  return {commit, path: file, sha256, sourceIdentity: {version: 'camera-arrival-v3', ...source}, verifiedUnchanged: true};
}

function duration(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  assert(Number.isSafeInteger(value) && value >= 1000 && value <= maximum, `${name} must be 1000..${maximum} ms`);
  return value;
}
function localUrl(value) {
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This harness requires local production servers');
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use a bare local server origin');
  return url.origin;
}
function dependency(name) {
  for (const base of [path.join(repo, '.browser-tools/node_modules'), path.join(repo, 'node_modules')]) {
    try { return require(path.join(base, name)); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error(`Missing ${name}; prepare the existing browser tools before running this harness`);
}
function check(value, label, trial) {
  assert(value, label);
  (trial?.checks || report.checks).push(label);
}
async function save(name, payload) {
  await fs.writeFile(path.join(out, name), JSON.stringify(payload, null, 2) + '\n');
}
function progress(stage, extra = {}) {
  console.log('CLEAN_CATALOG ' + JSON.stringify({stage, ...extra}));
}
function safeFile(root, name) {
  assert(typeof name === 'string' && /^[a-z0-9_.+-]+$/i.test(name) && name !== '.' && name !== '..', `Unsafe catalog filename: ${name}`);
  return path.join(root, name);
}
async function physicalCatalog(root) {
  const manifestBytes = await fs.readFile(path.join(root, 'manifest.json'), {signal: signal.signal});
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.totalFaces, 70000, 'Physical manifest total must be exactly 70,000');
  assert.equal(manifest.searchableFaces, 70000, 'Physical manifest searchable total must be exactly 70,000');
  assert(manifest.cells && Object.keys(manifest.cells).length > 0, 'Physical pose cells are missing');
  const ids = new Set(), addresses = new Set(), shardHashes = {}, coreReferences = Object.create(null), imageHashes = Object.create(null), digest = createHash('sha256');
  let images = 0, bytes = 0;
  for (const [cellKey, cell] of Object.entries(manifest.cells).sort(([a], [b]) => a.localeCompare(b))) {
    signal.signal.throwIfAborted();
    let count = 0;
    const packs = new Map();
    for (const file of cell.shards || [cell.shard]) {
      assert(!Object.hasOwn(shardHashes, file), `Shard referenced more than once: ${file}`);
      const shardBytes = await fs.readFile(safeFile(path.join(root, 'shards'), file), {signal: signal.signal});
      shardHashes[file] = hash(shardBytes);
      const shard = JSON.parse(shardBytes);
      assert(Array.isArray(shard.items), `Invalid shard: ${file}`);
      for (const item of shard.items) {
        assert(typeof item.id === 'string' && item.id && !ids.has(item.id), `Missing or duplicate ID: ${item.id}`);
        assert(Array.isArray(item.feature) && item.feature.length === 55 && item.feature.every(Number.isFinite), `Invalid feature: ${item.id}`);
        assert(Array.isArray(item.layout) && item.layout.length === 4 && item.layout.every(Number.isFinite), `Invalid layout: ${item.id}`);
        assert(item.shape && item.mesh && item.projection && Buffer.from(item.projection, 'base64').length === 1872, `Missing geometry: ${item.id}`);
        let payload, address;
        if (item.image) {
          address = `image:${item.image}`;
          payload = await fs.readFile(safeFile(path.join(root, 'images'), item.image), {signal: signal.signal});
        } else {
          assert(Number.isSafeInteger(item.offset) && item.offset >= 0 && Number.isSafeInteger(item.length) && item.length >= 12, `Invalid packed range: ${item.id}`);
          if (!packs.has(item.pack)) packs.set(item.pack, await fs.readFile(safeFile(path.join(root, 'packs'), item.pack), {signal: signal.signal}));
          const pack = packs.get(item.pack);
          assert(item.offset + item.length <= pack.length, `Truncated packed image: ${item.id}`);
          payload = pack.subarray(item.offset, item.offset + item.length);
          address = `pack:${item.pack}:${item.offset}:${item.length}`;
        }
        assert(!addresses.has(address), `Multiple IDs alias one physical image: ${item.id}`);
        assert.equal(payload.subarray(0, 4).toString('ascii'), 'RIFF', `Invalid WebP: ${item.id}`);
        assert.equal(payload.subarray(8, 12).toString('ascii'), 'WEBP', `Invalid WebP: ${item.id}`);
        assert.equal(payload.readUInt32LE(4) + 8, payload.length, `Incomplete WebP container: ${item.id}`);
        const imageSha256 = hash(payload);
        if (manifest.qualityAdmission !== undefined) {
          assert.equal(item.admissionSha256, imageSha256, `Photo differs from its admission record: ${item.id}`);
          assert.equal(item.admissionPolicySha256, manifest.qualityAdmission.policySha256, `Photo admission policy differs: ${item.id}`);
          assert.equal(item.id, 'clean-v5-' + imageSha256.slice(0, 28), `Photo has a noncanonical admitted ID: ${item.id}`);
          assert(!Object.hasOwn(item, 'image'), `Admitted core contains a separate image path: ${item.id}`);
        }
        coreReferences[item.id] = {address, imageSha256, featureSha256: hash(item.feature), layoutSha256: hash(item.layout)};
        imageHashes[address] = imageSha256;
        ids.add(item.id); addresses.add(address); images++; count++; bytes += payload.length;
        digest.update(item.id + '\0').update(payload);
      }
    }
    assert.equal(count, cell.count, `Physical count differs for cell ${cellKey}`);
  }
  assert.equal(images, 70000); assert.equal(ids.size, 70000); assert.equal(addresses.size, 70000);
  return {root, manifest, manifestHash: hash(manifestBytes), imageBytesHash: digest.digest('hex'), images, uniqueIds: ids.size, physicalAddresses: addresses.size, bytes, poseCells: Object.keys(manifest.cells).length, shardHashes, coreReferences, imageHashes};
}

function catalogImageAddress(url) {
  if (url.searchParams.has('id')) return 'image:' + url.searchParams.get('id');
  return `pack:${url.searchParams.get('pack')}:${Number(url.searchParams.get('offset'))}:${Number(url.searchParams.get('length'))}`;
}
function verifyAdmittedChoices(choices, catalog, base) {
  for (const choice of choices) {
    const reference = catalog.coreReferences[choice.id], url = new URL(choice.url, base);
    assert(reference, `Selected photo is outside the admitted 70,000: ${choice.id}`);
    assert.equal(url.origin, base); assert.equal(url.pathname, '/api/catalog/image');
    assert.equal(url.searchParams.get('source'), 'seed');
    assert.equal(catalogImageAddress(url), reference.address, `Selected ID points at another physical photo: ${choice.id}`);
    assert([catalog.manifest.catalogId, catalog.manifestHash].includes(url.searchParams.get('catalog')), `Missing current catalog cache token: ${choice.id}`);
    assert.equal(hash(choice.feature), reference.featureSha256, `Selected photo has features outside its admission record: ${choice.id}`);
    assert.equal(hash(choice.candidateLayout), reference.layoutSha256, `Selected photo has layout outside its admission record: ${choice.id}`);
    assert.notEqual(choice.supportKind, 'addition', 'External wink additions are forbidden for the admitted core');
  }
}

async function compileProbe() {
  // Fulfilled only in this browser context. No public asset or application is rewritten.
  const imports = name => JSON.stringify(path.join(repo, name));
  const source = `
    import {createStableLandmarker} from ${imports('app/live/stable-landmarker.ts')};
    import {catalogFeatureFromResult} from ${imports('app/catalog-feature.ts')};
    import {faceGeometryFromLandmarks} from ${imports('app/offline-matching.ts')};
    import {winkEvidence} from ${imports('app/live/wink-evidence.ts')};
    export async function inspect(rows, frames) {
      const deadline = performance.now() + 180000;
      const engine = await createStableLandmarker('IMAGE', () => undefined, AbortSignal.timeout(60000));
      const output = [];
      try {
        for (const row of rows) {
          if (performance.now() > deadline) throw new Error('Fresh output inspection timed out');
          const image = new Image(); let timer;
          try {
            image.src = row.url;
            await Promise.race([image.decode(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Output image decode timed out')), 15000);})]);
            const result = engine.detect(image), points = result.faceLandmarks[0];
            const geometry = points && faceGeometryFromLandmarks(points, image.naturalWidth / image.naturalHeight);
            const feature = geometry && result.faceBlendshapes.length && result.facialTransformationMatrixes.length ? catalogFeatureFromResult(result) : null;
            output.push({id: row.id, url: row.url, feature, wink: feature && geometry ? winkEvidence(feature, geometry.projection) : null});
          } catch (error) {output.push({id: row.id, url: row.url, feature: null, error: String(error)});}
          finally {clearTimeout(timer); image.src = '';}
        }
      } finally {engine.close();}
      return {photos: output, inputWinks: frames.map((frame, index) => ({index, evidence: winkEvidence(frame.feature, frame.geometry.projection)})).filter(row => row.evidence)};
    }
  `;
  const result = await dependency('esbuild').build({stdin: {contents: source, resolveDir: repo, sourcefile: 'clean-catalog-pixel-probe.ts', loader: 'ts'}, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent'});
  report.probe = {kind: 'current-model pixel reanalysis in a test-only route', sha256: hash(result.outputFiles[0].contents), fixturePixelsAltered: false};
  return result.outputFiles[0].text;
}

function installCapture() {
  const NativeWorker = window.Worker;
  window.__cleanSearchRequests = 0; window.__cleanDraws = []; window.__cleanDrawCount = 0;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {super(url, options); this.__cleanUrl = new URL(String(url), location.href).href;}
    postMessage(message, ...args) {
      if (Array.isArray(message?.frames) && message.build) {
        window.__cleanSearchRequests++;
        window.__cleanInput = structuredClone(message);
        window.__cleanWorkerUrl = this.__cleanUrl;
        this.addEventListener('message', event => {
          if (event.data?.type !== 'result') return;
          window.__cleanResult = {build: event.data.build, metrics: event.data.performanceMetrics, choices: event.data.choices.map(choice => ({
            id: choice.candidate.id, url: choice.candidate.url, feature: Array.from(choice.candidate.feature),
            candidateLayout: Array.from(choice.candidate.geometry.layout),
            supportKind: choice.candidate.supportKind ?? null, time: choice.frame.time,
            inputFeature: Array.from(choice.frame.feature), inputLayout: Array.from(choice.frame.geometry.layout),
            error: choice.error, emission: choice.emission, accepted: choice.accepted, expressionMotion: choice.expressionMotion,
          }))};
        });
      }
      return super.postMessage(message, ...args);
    }
  };
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  const imageSources = new WeakMap();
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const source = args[0];
    const sourceImage = source instanceof HTMLImageElement
      ? {url: source.currentSrc || source.src, width: source.width, height: source.height, naturalWidth: source.naturalWidth, naturalHeight: source.naturalHeight, complete: source.complete}
      : imageSources.get(source) ?? null;
    const output = this.canvas.getAttribute?.('data-testid') === 'output-canvas';
    const matrix = output ? this.getTransform() : null;
    const result = drawImage.apply(this, args);
    // The presentation first draws the decoded image to a cached layer canvas.
    // Preserve that source identity when the layer is drawn to the output.
    if (sourceImage) imageSources.set(this.canvas, sourceImage); else imageSources.delete(this.canvas);
    if (output) {
      window.__cleanDrawCount++;
      window.__cleanDraws.push({matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f], args: args.slice(1), at: performance.now(), sourceWidth: source.width, sourceHeight: source.height, sourceImage});
      if (window.__cleanDraws.length > 100) window.__cleanDraws.shift();
    }
    return result;
  };
}

async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function canvasState(includePlaybackControls = false) {
  return page.evaluate(async includeControls => {
    const canvas = document.querySelector('[data-testid="output-canvas"]');
    const video = document.querySelector('[data-testid="input-video"]');
    // Freeze all evidence in the same synchronous turn as the pixel readback.
    // A later draw during the asynchronous hash must not replace its metadata.
    const snapshot = {width: canvas.width, height: canvas.height, drawCount: window.__cleanDrawCount,
      lastDraw: structuredClone(window.__cleanDraws.at(-1)), videoTime: video.currentTime,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, paused: video.paused, seeking: video.seeking};
    if (includeControls) {
      const slider = document.querySelector('[data-testid="review-seek"]');
      const button = document.querySelector('[data-testid="play-pause"]');
      snapshot.playbackControls = {
        reviewTime: slider ? Number(slider.value) : null,
        slider: slider ? {value: slider.value, valueAttribute: slider.getAttribute('value'), min: slider.min, max: slider.max, step: slider.step, disabled: slider.disabled} : null,
        playPause: button ? {label: button.getAttribute('aria-label'), text: button.textContent, disabled: button.disabled} : null,
      };
    }
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return {...snapshot, pixelHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')};
  }, includePlaybackControls);
}
async function seek(time) {
  await page.getByTestId('review-seek').evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, time);
  await page.waitForFunction(target => {const v = document.querySelector('[data-testid="input-video"]'); return v.paused && !v.seeking && Math.abs(v.currentTime - target) < 0.005;}, time, {timeout: 15000});
  await settle();
}
function expectedTransform(choice, aspect, tracked = true) {
  if (!tracked) return {scale: 1, x: 0, y: 0};
  const [cx, cy, cw, ch] = choice.candidateLayout, [tx, ty, tw, th] = choice.inputLayout;
  const ax = Math.max(1, aspect), ay = Math.max(1, 1 / aspect);
  const scale = Math.max(0.5, Math.min(2.5, (th * ay / Math.max(0.01, ch)) * 0.7 + (tw * ax / Math.max(0.01, cw)) * 0.3));
  return {scale, x: (tx - 0.5) * ax - (cx - 0.5) * scale, y: (ty - 0.5) * ay - (cy - 0.5) * scale};
}
function assertDrawing(state, transform, choice) {
  const expected = [transform.scale, 0, 0, transform.scale, state.width * (0.5 + transform.x), state.height * (0.5 + transform.y)];
  assert(state.lastDraw, 'No real canvas draw was observed');
  const evidence = {actual: state.lastDraw.matrix, expected, width: state.width, height: state.height,
    videoTime: state.videoTime, videoWidth: state.videoWidth, videoHeight: state.videoHeight,
    drawCount: state.drawCount, sourceImage: state.lastDraw.sourceImage,
    candidateLayout: choice?.candidateLayout, inputLayout: choice?.inputLayout};
  expected.forEach((value, i) => assert(Math.abs(state.lastDraw.matrix[i] - value) < 0.0001, `Actual face transform differs at matrix component ${i}: ${JSON.stringify(evidence)}`));
  if (choice) {
    const source = state.lastDraw.sourceImage;
    assert.equal(source?.url, choice.url, 'Canvas drew a different decoded photo from the selected timeline entry');
    assert(source.naturalWidth > 0 && source.naturalHeight > 0 && source.width > 0 && source.height > 0, 'Drawn photo dimensions are missing');
  }
}
async function selectionSignature() {
  return page.evaluate(() => ({ids: window.__MANY_FACES_VERIFY__?.sequenceIds, fingerprint: window.__MANY_FACES_VERIFY__?.sequenceFingerprint, workerIds: window.__cleanResult?.choices.map(row => row.id), requests: window.__cleanSearchRequests}));
}
async function mirrorState() {
  return page.evaluate(() => Object.fromEntries(['input-video', 'output-canvas'].map(id => [id, getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).transform])));
}
async function closeSettings() {await page.getByRole('button', {name: '閉じる', exact: true}).click(); await settle();}
async function screenshot(name) {await page.screenshot({path: path.join(out, name)});}

async function recoverBaselineInitialPresentation(trial, choices, aspect, signature) {
  // A synthetic seek to the already-selected zero value may not notify React.
  // Actually leave zero, observe that draw, then return and validate the redraw.
  const awayChoice = choices.find(choice => choice.time >= 0.05 && choice.time < 23.3);
  assert(awayChoice, 'No later acquired frame is available for a real baseline seek');
  const first = choices[0], observation = (choice, state) => ({id: choice.id, time: choice.time, url: choice.url,
    candidateLayout: choice.candidateLayout, inputLayout: choice.inputLayout, expected: expectedTransform(choice, aspect), ...state});
  trial.initialRecovery = {method: 'seek-away-and-back', passed: false, sequenceUnchanged: false,
    seekAwayTime: awayChoice.time, returnedTime: 0, awayChoice};
  await seek(awayChoice.time);
  trial.initialRecovery.away = observation(awayChoice, await canvasState());
  assertDrawing(trial.initialRecovery.away, expectedTransform(awayChoice, aspect), awayChoice);
  await seek(0);
  trial.initialRecovery.canvas = observation(first, await canvasState());
  await screenshot('baseline-initial-recovered.png');
  assertDrawing(trial.initialRecovery.canvas, expectedTransform(first, aspect), first);
  assert.deepEqual(await selectionSignature(), signature, 'Baseline recovery changed the selected sequence');
  trial.initialRecovery.sequenceUnchanged = true; trial.initialRecovery.passed = true;
  assertBaselineInitialRecovery(trial);
}

async function verifyPresentation(trial, choices) {
  const signature = await selectionSignature();
  const aspect = await page.getByTestId('input-video').evaluate(video => video.videoWidth / video.videoHeight);
  const stimulus = choices.map(choice => ({choice, transform: expectedTransform(choice, aspect)})).sort((a, b) => (Math.abs(b.transform.x) + Math.abs(b.transform.y) + Math.abs(b.transform.scale - 1)) - (Math.abs(a.transform.x) + Math.abs(a.transform.y) + Math.abs(a.transform.scale - 1)))[0];
  check(stimulus && Math.abs(stimulus.transform.x) + Math.abs(stimulus.transform.y) + Math.abs(stimulus.transform.scale - 1) > 0.01, 'The real fixture contains a nontrivial face-tracking stimulus', trial);
  trial.presentation = {sourceAspectRatio: aspect, samples: []};
  // Observe async completion before a seek/control event can repair a stale draw.
  await page.waitForFunction(() => {const video = document.querySelector('[data-testid="input-video"]'); return video.paused && !video.seeking && Math.abs(video.currentTime) < 0.005;}, null, {timeout: 15000});
  await settle();
  const first = choices[0], initial = await canvasState(), initialExpected = expectedTransform(first, aspect);
  trial.presentation.initial = {beforeAnySeek: true, id: first.id, time: first.time, url: first.url,
    candidateLayout: first.candidateLayout, inputLayout: first.inputLayout, expected: initialExpected, ...initial};
  await screenshot(`${trial.name}-initial.png`);
  trial.initialPresentationPassed = false;
  try {
    assertDrawing(initial, initialExpected, first);
    trial.initialPresentationPassed = true;
    check(true, 'Initial completed canvas has the current face position and size before any seek or display-control redraw', trial);
  } catch (error) {
    if (trial.name !== 'baseline') throw error;
    const originalError = {name: error.name, code: error.code, message: error.message, stack: error.stack};
    try {trial.knownInitialFailure = assertKnownBaselineInitialFailure(report, trial, originalError);}
    catch {throw error;} // Unrecognized baseline errors retain their original failure.
    await save('baseline-known-initial-failure.json', {baselineSource: report.baselineSource, initial: trial.presentation.initial, evidence: trial.knownInitialFailure});
    progress('known-baseline-initial-failure', {kind: trial.knownInitialFailure.kind, baselinePassed: false});
    await recoverBaselineInitialPresentation(trial, choices, aspect, signature);
  }
  // Multiple real frame geometries ensure the rendering reads the current input geometry.
  for (const fraction of [0, 0.25, 0.5, 0.75, 0.94]) {
    const choice = choices[Math.min(choices.length - 1, Math.floor((choices.length - 1) * fraction))];
    await seek(choice.time);
    const state = await canvasState(), expected = expectedTransform(choice, aspect);
    trial.presentation.samples.push({id: choice.id, time: choice.time, url: choice.url,
      candidateLayout: choice.candidateLayout, inputLayout: choice.inputLayout, expected, ...state});
    assertDrawing(state, expected, choice);
    await screenshot(`${trial.name}-motion-${Math.round(fraction * 100)}.png`);
  }
  await seek(stimulus.choice.time);
  const normal = await canvasState(); assertDrawing(normal, stimulus.transform, stimulus.choice);
  await page.getByTestId('settings').click();
  check(await page.getByTestId('face-tracking-toggle').isChecked(), 'Face tracking starts ON in the actual video UI', trial);
  assert.equal(await page.getByTestId('face-display-mode').inputValue(), 'normal');
  await page.getByTestId('face-tracking-toggle').uncheck(); await settle();
  const untracked = await canvasState(); assertDrawing(untracked, expectedTransform(stimulus.choice, aspect, false), stimulus.choice);
  check(untracked.drawCount > normal.drawCount && untracked.pixelHash !== normal.pixelHash, 'Disabling tracking redraws the same selected photo', trial);
  assert.deepEqual(await selectionSignature(), signature, 'Tracking toggle changed the search/selection');
  await page.getByTestId('face-tracking-toggle').check(); await settle();
  const tracked = await canvasState(); assertDrawing(tracked, stimulus.transform, stimulus.choice);
  assert.equal(tracked.pixelHash, normal.pixelHash, 'Restoring tracking did not restore the same frame');
  await page.getByTestId('face-display-mode').selectOption('face'); await settle();
  const face = await canvasState(); assertDrawing(face, stimulus.transform, stimulus.choice);
  check(face.drawCount > tracked.drawCount && face.pixelHash !== tracked.pixelHash, 'Face-only mode redraws the chosen photo without changing geometry', trial);
  assert.deepEqual(await selectionSignature(), signature, 'Face-only mode changed the search/selection');
  await closeSettings(); await screenshot(`${trial.name}-face-only.png`);
  await page.getByTestId('settings').click();
  await page.getByTestId('face-display-mode').selectOption('normal'); await settle();
  assert.equal((await canvasState()).pixelHash, normal.pixelHash, 'Normal presentation did not restore the same frame');
  await page.getByTestId('mirror-toggle').check(); await settle();
  const mirrored = await mirrorState();
  assert.equal(mirrored['input-video'], mirrored['output-canvas']);
  assert.equal(mirrored['input-video'], 'matrix(-1, 0, 0, 1, 0, 0)');
  assert.equal((await canvasState()).pixelHash, normal.pixelHash, 'Mirror altered source canvas pixels');
  await page.getByTestId('face-display-mode').selectOption('face'); await settle();
  assert.equal((await canvasState()).pixelHash, face.pixelHash, 'Mirroring changed the face-only selected image');
  assert.deepEqual(await mirrorState(), mirrored);
  await closeSettings(); await screenshot(`${trial.name}-face-only-mirrored.png`);
  await page.getByTestId('settings').click();
  await page.getByTestId('mirror-toggle').uncheck(); await page.getByTestId('face-display-mode').selectOption('normal'); await settle();
  const unmirrored = await mirrorState();
  assert.equal(unmirrored['input-video'], 'none'); assert.equal(unmirrored['output-canvas'], 'none');
  assert.deepEqual(await selectionSignature(), signature);
  await closeSettings();
  trial.presentation.toggles = {normal, untracked, tracked, face, mirrored, unmirrored, selectedTime: stimulus.choice.time, selectedId: stimulus.choice.id, selectedChoice: stimulus.choice};
  check(true, 'Tracking, face-only and paired mirror controls preserve every selected ID and do not rerun search', trial);
}

async function verifyLayout(trial) {
  trial.layout = [];
  for (const viewport of [{width: 390, height: 844}, {width: 1440, height: 900}]) {
    await page.setViewportSize(viewport); await settle();
    const state = await page.evaluate(() => {
      const rect = id => {const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height};};
      return {viewport: {width: innerWidth, height: innerHeight}, stage: rect('result-stage'), canvas: rect('output-canvas'), pip: rect('source-pip'), scroll: document.documentElement.scrollWidth, oldTabs: document.querySelectorAll('[role="tab"], nav').length, modes: document.querySelectorAll('[data-testid="mode-video"], [data-testid="mode-camera"]').length, objectFit: getComputedStyle(document.querySelector('[data-testid="output-canvas"]')).objectFit};
    });
    assert(Math.abs(state.stage.width - viewport.width) < 1 && Math.abs(state.stage.height - viewport.height) < 1 && Math.abs(state.stage.x) < 1 && Math.abs(state.stage.y) < 1, 'Result stage does not fill viewport');
    assert.equal(state.scroll, viewport.width); assert.equal(state.oldTabs, 0); assert.equal(state.modes, 2);
    assert(state.pip.x > viewport.width / 2 && state.pip.y < 40 && state.pip.width * state.pip.height < viewport.width * viewport.height * 0.12, 'Source PiP moved from its small upper-right position');
    assert.equal(state.objectFit, 'cover');
    await screenshot(`${trial.name}-${viewport.width}-cover.png`);
    await page.getByTestId('settings').click();
    await page.getByLabel('画像全体を表示', {exact: true}).check(); await closeSettings();
    assert.equal(await page.getByTestId('output-canvas').evaluate(canvas => getComputedStyle(canvas).objectFit), 'contain');
    await screenshot(`${trial.name}-${viewport.width}-contain.png`);
    await page.getByTestId('settings').click(); await page.getByLabel('画像全体を表示', {exact: true}).uncheck(); await closeSettings();
    trial.layout.push(state);
  }
  check(true, 'Mobile and desktop retain the fullscreen two-mode UI, small PiP and working cover/contain controls', trial);
}

function contradiction(stored, fresh) {
  return Math.abs(stored) >= 12 && Math.abs(fresh) >= 8 && stored * fresh < 0 && Math.abs(stored - fresh) >= 20;
}
function freshMetrics(choices, inspection) {
  const byId = new Map(inspection.photos.map(photo => [photo.id, photo]));
  const errors = inspection.photos.filter(photo => photo.error), undetected = inspection.photos.filter(photo => !photo.feature && !photo.error);
  const unique = [...new Map(choices.map(choice => [choice.id, choice])).values()];
  const storedContradictions = unique.filter(choice => byId.get(choice.id)?.feature && contradiction(choice.feature[0] * 90, byId.get(choice.id).feature[0] * 90)).map(choice => ({id: choice.id, storedYaw: choice.feature[0] * 90, freshYaw: byId.get(choice.id).feature[0] * 90}));
  const frameRows = choices.map((choice, index) => {
    const fresh = byId.get(choice.id)?.feature;
    return {index, time: choice.time, id: choice.id, detected: Boolean(fresh), yawErrorDegrees: fresh ? Math.abs(choice.inputFeature[0] - fresh[0]) * 90 : null, pitchErrorDegrees: fresh ? Math.abs(choice.inputFeature[1] - fresh[1]) * 90 : null, reversedInputYaw: Boolean(fresh && contradiction(choice.inputFeature[0] * 90, fresh[0] * 90))};
  });
  const detected = frameRows.filter(row => row.detected);
  const winkRows = inspection.inputWinks.map(row => ({index: row.index, id: choices[row.index].id, inputSide: row.evidence.side, outputSide: byId.get(choices[row.index].id)?.wink?.side ?? null}));
  return {photosInspected: inspection.photos.length, photosDetected: inspection.photos.filter(photo => photo.feature).length, errors, undetected, storedContradictions, frames: frameRows, detectedFrames: detected.length, meanYawErrorDegrees: detected.length ? detected.reduce((sum, row) => sum + row.yawErrorDegrees, 0) / detected.length : null, meanPitchErrorDegrees: detected.length ? detected.reduce((sum, row) => sum + row.pitchErrorDegrees, 0) / detected.length : null, reversedInputYawFrames: frameRows.filter(row => row.reversedInputYaw), winks: {frames: winkRows.length, correctSide: winkRows.filter(row => row.inputSide === row.outputSide).length, rows: winkRows}};
}

async function trial(name, base, catalog, trialTimeout) {
  const row = {name, base, checks: [], pageErrors: [], verificationStages: {}, initialPresentationPassed: false,
    remainingChecksPassed: false, knownInitialFailure: null, initialRecovery: null, runtimeIdentityAndManifestStable: false, passed: false};
  report.trials.push(row); progress('trial-start', {name});
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport: {width: 390, height: 844}, locale: 'ja-JP'});
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
  await context.addInitScript(installCapture);
  await context.route('**/__clean_catalog_pixel_probe.js', route => route.fulfill({status: 200, contentType: 'text/javascript', body: probeCode}));
  row.legacyQualityOverlayRequests = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/catalog-quality/v1/exclusions.json') row.legacyQualityOverlayRequests.push(request.url());
  });
  const shardChecks = [], checkedShards = new Set(), checkedImages = new Set(), shardFailures = [];
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== base || !['/api/catalog/shard', '/api/catalog/image'].includes(url.pathname)) return;
    const file = url.searchParams.get('file');
    shardChecks.push((async () => {
      assert(response.ok(), `Downloaded catalog asset: HTTP ${response.status()} ${url.pathname}`);
      assert.equal(url.searchParams.get('source'), 'seed');
      if (url.pathname === '/api/catalog/shard') {
        assert.equal(hash(await response.body()), catalog.shardHashes[file], `Served shard differs from physical inventory: ${file}`);
        checkedShards.add(file);
      } else {
        const address = catalogImageAddress(url);
        assert.equal(hash(await response.body()), catalog.imageHashes[address], `Served photo differs from physical inventory: ${address}`);
        checkedImages.add(address);
      }
    })().catch(error => shardFailures.push(error.stack || String(error))));
  });
  page = await context.newPage(); page.on('pageerror', error => row.pageErrors.push(error.stack || error.message));
  const readJson = async (url, expectedHash) => {
    const response = await context.request.get(url, {timeout: 30000});
    assert(response.ok(), `${url}: HTTP ${response.status()}`);
    const bytes = await response.body();
    if (expectedHash) assert.equal(hash(bytes), expectedHash, `Served manifest bytes differ from the bound physical manifest: ${url}`);
    return JSON.parse(bytes);
  };
  row.identity = await readJson(base + '/api/runtime');
  assert.equal(row.identity.version, 'camera-arrival-v3');
  assert(typeof row.identity.build === 'string' && row.identity.build !== 'unbundled-source' && row.identity.build.length > 0, 'Server build identity is missing');
  if (name === 'baseline') assert.deepEqual(row.identity, report.baselineSource.sourceIdentity, 'The baseline server does not run the checked original source');
  const servedManifest = await readJson(base + '/api/catalog/manifest?source=seed', catalog.manifestHash);
  assert.deepEqual(servedManifest, catalog.manifest, 'Production server manifest does not match the inventoried local catalog');
  row.catalog = {...catalog, manifest: undefined, shardHashes: undefined, coreReferences: undefined, imageHashes: undefined};
  if (name === 'candidate') {
    const stamp = catalog.manifest.qualityAdmission;
    assert(stamp && stamp.schemaVersion === 2 && stamp.status === 'complete' && stamp.selectedCount === 70000 && stamp.runtimeExclusionOverlayRequired === false, 'Candidate core lacks the completed quality-admission stamp');
    const support = await readJson(base + '/wink-support/v1/catalog.json?catalog=' + catalog.manifestHash);
    assert.equal(support.schemaVersion, 3); assert.equal(support.baseCatalogId, catalog.manifest.catalogId);
    assert.equal(support.baseCatalogManifestSha256, catalog.manifestHash); assert.equal(support.policySha256, stamp.policySha256);
    assert.equal(support.addedPhotographs, 0); assert(Array.isArray(support.items));
    for (const item of support.items) {
      const reference = catalog.coreReferences[item.id];
      assert(reference && item.supportKind === 'core-refresh', 'Bound wink index contains a photo outside the admitted core');
      assert(!Object.hasOwn(item, 'image'), 'Bound wink index contains a separate image path');
      assert.equal(item.id, 'clean-v5-' + reference.imageSha256.slice(0, 28));
      const address = `pack:${item.pack}:${item.offset}:${item.length}`;
      assert.equal(address, reference.address); assert.equal(item.imageSha256, reference.imageSha256);
      assert.equal(item.admissionSha256, reference.imageSha256); assert.equal(item.admissionPolicySha256, stamp.policySha256);
      assert.equal(hash(item.feature), reference.featureSha256); assert.equal(hash(item.layout), reference.layoutSha256);
    }
    row.boundWinkIndex = {items: support.items.length, manifestSha256: support.baseCatalogManifestSha256, externalPhotos: 0};
  }
  await page.goto(base + '/live', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => window.__MANY_FACES_RUNTIME__?.phase === 'idle', null, {timeout: 30000});
  await page.getByTestId('settings').click();
  check(await page.getByTestId('face-tracking-toggle').isChecked(), 'Default face tracking is ON before analysis', row);
  assert.equal(await page.getByTestId('face-display-mode').inputValue(), 'normal');
  await page.getByTestId('analysis-fps').selectOption('20'); await closeSettings();
  const started = Date.now();
  await page.getByTestId('video-input').setInputFiles(fixture);
  await page.waitForFunction(() => window.__MANY_FACES_VERIFY__ || window.__MANY_FACES_RUNTIME__?.phase === 'error', null, {timeout: trialTimeout});
  row.wallMs = Date.now() - started;
  const observed = await page.evaluate(() => ({
    report: window.__MANY_FACES_VERIFY__, runtime: window.__MANY_FACES_RUNTIME__, search: window.__cleanResult,
    inputBuild: window.__cleanInput?.build, worker: window.__cleanWorkerUrl,
    frames: JSON.stringify(window.__cleanInput?.frames, (_key, value) => ArrayBuffer.isView(value) ? {__typed: value.constructor.name, data: Array.from(value)} : value),
    frameCount: window.__cleanInput?.frames.length, duration: document.querySelector('[data-testid="input-video"]').duration,
  }));
  row.video = observed.report; row.runtime = observed.runtime; row.worker = observed.worker; row.durationSeconds = observed.duration;
  assert.equal(observed.report?.passed, true, JSON.stringify(observed.runtime));
  assert(Math.abs(observed.duration - 23.3) < 0.001, 'The fixture was truncated or changed');
  assert.equal(observed.report.plannedFrames, 466); assert.equal(observed.report.faceFrames, observed.frameCount);
  assert.equal(observed.report.sequenceFrames, observed.frameCount); assert.equal(observed.search.choices.length, observed.frameCount);
  assert(observed.frameCount > 0 && observed.report.faceCoverage >= 0.7); assert.equal(observed.report.imageFailures, 0); assert.equal(observed.report.canvasNonBlank, true);
  for (const build of [observed.report.build, observed.runtime?.build, observed.inputBuild, observed.search.build]) assert.equal(build, row.identity.build, 'Client, server or worker build mismatch');
  assert.equal(observed.report.inputBuild, row.identity.version);
  assert.deepEqual(observed.search.choices.map(choice => choice.id), observed.report.sequenceIds);
  if (name === 'candidate') verifyAdmittedChoices(observed.search.choices, catalog, base);
  row.framesHash = hash(observed.frames); row.choicesHash = hash(observed.search.choices); row.performance = observed.search.metrics;
  row.acquiredFrameCount = observed.frameCount; row.timeline = observed.search.choices.map(choice => choice.time); row.timelineHash = hash(row.timeline);
  row.firstChoice = observed.search.choices[0];
  row.builds = {client: observed.report.build, runtime: observed.runtime.build, input: observed.inputBuild, worker: observed.search.build, version: observed.report.inputBuild};
  if (name === 'candidate') {
    const wink = observed.search.metrics?.wink;
    assert(wink && Number.isSafeInteger(wink.requestedFrames), 'Candidate wink-index metrics are missing');
    assert.equal(wink.addedPhotos, 0, 'Candidate loaded external wink photographs');
    assert.equal(wink.indexError, null, 'Candidate wink index failed to load or bind');
    if (wink.requestedFrames > 0) assert.equal(wink.indexedOriginals, row.boundWinkIndex.items, 'Candidate did not load its complete admitted specialist index');
    row.boundWinkIndex.requestedFrames = wink.requestedFrames;
    assert.equal(row.legacyQualityOverlayRequests.length, 0, 'Admitted candidate requested the legacy runtime exclusion overlay');
  }
  await Promise.all(shardChecks);
  assert.equal(shardFailures.length, 0, shardFailures.join('\n'));
  check(checkedShards.size > 0, 'Every downloaded candidate shard and core photo matches the inventoried physical catalog', row);
  row.downloadedShardCount = checkedShards.size;
  await fs.writeFile(path.join(out, name + '-input-frames.json'), observed.frames + '\n');
  await save(name + '-choices.json', observed.search.choices);
  check(true, 'Complete 23.3s/20fps input, every detected frame returned, nonblank output, zero image failures and aligned build IDs', row);
  row.verificationStages.completeVideo = true;
  await verifyPresentation(row, observed.search.choices);
  row.verificationStages.presentation = true;
  await verifyLayout(row);
  row.verificationStages.layout = true;
  const selectionBeforePlayback = await selectionSignature();
  row.playback = {stepAnchorSeconds: 1, frameStepSeconds: 0.05, frameStepToleranceSeconds: 0.005,
    pauseAfterPlayback: null, paused: null, stepped: null, seekSeconds: null};
  const recordPlayback = async key => {
    const {playbackControls: ui, ...canvas} = await canvasState(true);
    const state = {time: canvas.videoTime, paused: canvas.paused, seeking: canvas.seeking, reviewTime: ui.reviewTime, ui, canvas};
    row.playback[key] = state;
    await save(name + '-playback.json', row.playback);
    return state;
  };
  await seek(0); await page.getByTestId('play-pause').click();
  await page.waitForFunction(() => {const video = document.querySelector('[data-testid="input-video"]'); return !video.paused && video.currentTime > 0.25;}, null, {timeout: 8000});
  await page.getByTestId('play-pause').click(); await settle();
  const stopped = await recordPlayback('pauseAfterPlayback');
  assert(stopped.paused && !stopped.seeking, 'Playback did not stop: ' + JSON.stringify(stopped));
  assert.equal(stopped.ui.playPause?.label, '再生', 'Paused playback UI does not offer Play');
  // range.value is rounded to 50 ms, while playbackTime follows the continuous
  // rAF clock. Synchronize both through the real seek UI before measuring a
  // precise frame step; arbitrary pause timing must not become its time base.
  await seek(1);
  const paused = await recordPlayback('paused');
  assert(paused.paused && !paused.seeking && Math.abs(paused.time - 1) < 0.005, 'Frame-step anchor did not settle: ' + JSON.stringify(paused));
  assert.equal(paused.reviewTime, 1, 'Frame-step slider is not at the exact one-second anchor');
  assert.equal(Number(paused.ui.slider?.step), 0.05, 'Frame-step UI is not configured for 20 fps');
  assert.equal(paused.ui.playPause?.label, '再生');
  await page.getByTestId('step-forward').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="input-video"]').seeking, null, {timeout: 15000});
  await settle();
  const stepped = await recordPlayback('stepped');
  const stepEvidence = JSON.stringify({paused, stepped});
  assert(stepped.paused && !stepped.seeking, 'Frame step did not remain paused and finish seeking: ' + stepEvidence);
  assert(stepped.time > paused.time && Math.abs(stepped.time - paused.time - 0.05) < 0.005, 'Frame step did not advance the actual video by 50 ms: ' + stepEvidence);
  assert(stepped.time > paused.reviewTime && Math.abs(stepped.time - paused.reviewTime - 0.05) < 0.005, 'Frame step did not reach 1.05 seconds: ' + stepEvidence);
  assert.equal(stepped.reviewTime, 1.05, 'Frame-step slider did not reach 1.05 seconds');
  assert.equal(stepped.ui.playPause?.label, '再生');
  await seek(22); row.playback.seekSeconds = 22;
  await save(name + '-playback.json', row.playback);
  assert.deepEqual(await selectionSignature(), selectionBeforePlayback);
  check(true, 'Playback, pause, 20fps frame stepping and seek beyond 20s work without changing the selected sequence', row);
  row.verificationStages.playback = true;
  progress('fresh-pixels', {name, photos: observed.report.selectedImages});
  const inspection = await page.evaluate(async () => {
    const {inspect} = await import('/__clean_catalog_pixel_probe.js');
    const rows = [...new Map(window.__cleanResult.choices.map(choice => [choice.id, {id: choice.id, url: choice.url}])).values()];
    if (rows.length > 466) throw new Error('Unexpected output photo count');
    return inspect(rows, window.__cleanInput.frames);
  });
  const fresh = freshMetrics(observed.search.choices, inspection);
  row.freshPixels = {...fresh, frames: undefined, winks: {...fresh.winks, rows: undefined}};
  await save(name + '-fresh-output-pixels.json', {inspection, metrics: fresh});
  assert.equal(fresh.errors.length, 0, 'Fresh output pixel inspection failed');
  assert(fresh.photosDetected > 0, 'Fresh output inspection detected no faces');
  if (name === 'candidate') {
    assert.equal(fresh.storedContradictions.length, 0, 'Candidate selected photos still contradict their stored yaw');
    assert.equal(fresh.reversedInputYawFrames.length, 0, 'Candidate selected photos clearly reverse the input yaw');
  }
  row.verificationStages.freshPixels = true;
  // This worker metric counts entries in a loaded overlay, not actual discarded
  // catalog candidates. A nonzero value alone cannot establish runtime reliance.
  row.runtimeQualityOverlayEntries = Number(observed.search.metrics?.qualityExcluded ?? 0);
  await page.getByTestId('mode-camera').click(); await page.getByTestId('camera-start').waitFor();
  assert.equal(await page.getByTestId('call-stage').getAttribute('data-mode'), 'camera');
  await page.getByTestId('mode-video').click(); await page.getByTestId('sample-video').waitFor();
  check(true, 'Both current modes remain accessible; camera capture was not started', row);
  row.verificationStages.modeSwitch = true;
  assert.deepEqual(await readJson(base + '/api/runtime'), row.identity, 'Production build changed during the trial');
  assert.deepEqual(await readJson(base + '/api/catalog/manifest?source=seed', catalog.manifestHash), catalog.manifest, 'Served catalog changed during the trial');
  await Promise.all(shardChecks); assert.equal(shardFailures.length, 0, shardFailures.join('\n'));
  row.downloadedCoreImages = checkedImages.size;
  row.verificationStages.downloadedAssets = true;
  if (name === 'candidate') check(row.legacyQualityOverlayRequests.length === 0, 'Admitted candidate made zero legacy runtime exclusion requests during the entire trial', row);
  assert.equal(row.pageErrors.length, 0, row.pageErrors.join('\n'));
  row.runtimeIdentityAndManifestStable = true; row.verificationStages.runtimeAndCatalogStable = true;
  row.remainingChecksPassed = true; row.passed = row.initialPresentationPassed;
  await save(name + '-report.json', row);
  await browser.close(); browser = null; page = null;
  progress('trial-complete', {name, frames: observed.frameCount, selectedImages: observed.report.selectedImages, wallMs: row.wallMs});
  return {row, frames: observed.frames, choices: observed.search.choices, fresh};
}

try {
  await fs.mkdir(out, {recursive: true});
  const trialTimeout = duration('CLEAN_TRIAL_TIMEOUT_MS', 600000, 900000);
  const totalTimeout = duration('CLEAN_TOTAL_TIMEOUT_MS', 1800000, 3600000);
  report.timeouts = {trialMs: trialTimeout, totalMs: totalTimeout};
  totalTimer = setTimeout(() => {signal.abort(new Error('Clean catalog verification exceeded its total deadline')); void browser?.close().catch(() => undefined);}, totalTimeout);
  assert(process.env.CLEAN_BASELINE_CATALOG_ROOT, 'Set CLEAN_BASELINE_CATALOG_ROOT to the exact baseline server catalog; the harness will not guess');
  assert(process.env.CLEAN_BASELINE_APP_ROOT, 'Set CLEAN_BASELINE_APP_ROOT to the unmodified accepted baseline checkout');
  baselineAppRoot = await fs.realpath(path.resolve(process.env.CLEAN_BASELINE_APP_ROOT));
  const roots = {baseline: path.resolve(process.env.CLEAN_BASELINE_CATALOG_ROOT), candidate: path.resolve(process.env.CLEAN_CANDIDATE_CATALOG_ROOT || path.join(repo, 'public/seed-catalog'))};
  assert.equal(await fs.realpath(path.join(baselineAppRoot, 'public/seed-catalog')), await fs.realpath(roots.baseline), 'Baseline source and physical catalog come from different checkouts');
  report.baselineSource = await baselineSourceIdentity(baselineAppRoot);
  assert.notEqual(await fs.realpath(roots.baseline), await fs.realpath(roots.candidate), 'Baseline and candidate physical catalogs must be isolated');
  const urls = {baseline: localUrl(process.env.CLEAN_BASELINE_URL || 'http://127.0.0.1:4185'), candidate: localUrl(process.env.CLEAN_CANDIDATE_URL || 'http://127.0.0.1:4183')};
  assert.notEqual(urls.baseline, urls.candidate, 'Baseline and candidate servers must be distinct');
  report.fixtureSha256 = hash(await fs.readFile(fixture, {signal: signal.signal}));
  assert.equal(report.fixtureSha256, fixtureHash, 'The complete original MP4 fixture changed');
  progress('physical-inventory');
  const catalogs = {};
  for (const name of ['baseline', 'candidate']) {catalogs[name] = await physicalCatalog(roots[name]); await save(name + '-physical-catalog.json', {...catalogs[name], coreReferences: undefined, imageHashes: undefined});}
  check(true, 'Both local catalogs contain exactly 70,000 unique IDs and distinct complete WebP image references');
  assert.notEqual(catalogs.baseline.imageBytesHash, catalogs.candidate.imageBytesHash, 'The candidate has the same physical image inventory as the baseline');
  chromium = dependency('playwright').chromium;
  probeCode = await compileProbe();
  const before = await trial('baseline', urls.baseline, catalogs.baseline, trialTimeout);
  const after = await trial('candidate', urls.candidate, catalogs.candidate, trialTimeout);
  signal.signal.throwIfAborted();
  assert.equal(before.frames, after.frames, 'Acquired input descriptors differ; this is not a same-input catalog comparison');
  assert.equal(before.row.video.faceFrames, after.row.video.faceFrames);
  assert.deepEqual(before.choices.map(choice => choice.time), after.choices.map(choice => choice.time));
  check(true, 'Baseline and candidate received exactly the same complete acquired frame arrays and timeline');
  const metricKeys = ['meanYawErrorDegrees', 'meanPitchErrorDegrees', 'meanMouthError', 'meanEyeError', 'meanProjectionError'];
  const matching = Object.fromEntries(metricKeys.map(key => {
    const baseline = before.row.video.matching[key], candidate = after.row.video.matching[key];
    assert(Number.isFinite(baseline) && Number.isFinite(candidate), `Missing matching metric: ${key}`);
    return [key, {baseline, candidate, change: candidate - baseline}];
  }));
  const comparable = before.fresh.frames.filter((frame, index) => frame.detected && after.fresh.frames[index].detected).map(frame => ({index: frame.index, before: frame, after: after.fresh.frames[frame.index]}));
  const freshComparison = Object.fromEntries(['yawErrorDegrees', 'pitchErrorDegrees'].map(key => {
    const mean = variant => comparable.length ? comparable.reduce((sum, frame) => sum + frame[variant][key], 0) / comparable.length : null;
    const baseline = mean('before'), candidate = mean('after');
    return [key, {baseline, candidate, change: baseline !== null ? candidate - baseline : null}];
  }));
  report.comparison = {sameAcquiredFrames: true, sameTimeline: true, selectedIdChanges: before.choices.reduce((sum, choice, index) => sum + Number(choice.id !== after.choices[index].id), 0), selectedImages: {baseline: before.row.video.selectedImages, candidate: after.row.video.selectedImages}, storedDescriptorMetrics: matching, freshPixelPose: {comparableFrames: comparable.length, totalFrames: before.choices.length, metrics: freshComparison}, timing: {baselineWallMs: before.row.wallMs, candidateWallMs: after.row.wallMs, deltaMs: after.row.wallMs - before.row.wallMs, repeatedSpeedBenchmark: false}};
  assert.equal(hash(await fs.readFile(fixture, {signal: signal.signal})), fixtureHash, 'The original fixture changed during verification');
  assert.deepEqual(await baselineSourceIdentity(baselineAppRoot), report.baselineSource, 'Baseline source changed during comparison');
  report.comparisonContract = {
    schemaVersion: 1, status: 'complete', candidatePassed: after.row.passed, candidateInitialPresentationPassed: after.row.initialPresentationPassed,
    baselinePassed: before.row.passed, baselineInitialPresentationPassed: before.row.initialPresentationPassed,
    baselineRemainingChecksPassed: before.row.remainingChecksPassed, baselineKnownInitialFailureAccepted: before.row.knownInitialFailure !== null,
    sameAcquiredFrames: true, sameTimeline: true, acquiredFramesSha256: before.row.framesHash,
    timelineSha256: before.row.timelineHash, comparedFaceFrames: before.row.video.faceFrames,
  };
  report.passed = true;
  assertComparisonContract(report);
} catch (error) {
  report.passed = false;
  report.failures.push(error.stack || String(error));
  if (page && !page.isClosed()) {
    report.failureState = await page.evaluate(() => ({runtime: window.__MANY_FACES_RUNTIME__, video: window.__MANY_FACES_VERIFY__, realtime: window.__MANY_FACES_REALTIME__, text: document.body.innerText.slice(0, 4000)})).catch(() => null);
    report.failureCanvas = await canvasState().catch(() => null);
    await screenshot('failure.png').catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  clearTimeout(totalTimer);
  await browser?.close().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(out, {recursive: true});
  await save('report.json', report);
  progress('finished', {passed: report.passed, reportPath: path.join(out, 'report.json'), failures: report.failures.map(value => value.split('\n')[0])});
}
