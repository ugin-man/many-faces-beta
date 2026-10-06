import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {facePresentationTransform} from '../app/face-presentation.ts';
import {quantizeReviewTime, reviewItemAtTime} from '../app/live/review-timeline.ts';

// Execute the production callbacks at their async boundary. The model/search and
// DOM are deliberately outside this unit test; the Actions browser gate covers
// the complete component and checks its first canvas before any seek.
const clientSource = readFileSync(new URL('../app/live/review-client-lite.tsx', import.meta.url), 'utf8');
const client = ts.createSourceFile('review-client-lite.tsx', clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const probeSource = readFileSync(new URL('../scripts/verify-clean-catalog.mjs', import.meta.url), 'utf8');
const probe = ts.createSourceFile('verify-clean-catalog.mjs', probeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function findAll(node, predicate) {
  const matches = [];
  function visit(child) {if (predicate(child)) matches.push(child); ts.forEachChild(child, visit);}
  visit(node); return matches;
}
function one(nodes, description) {assert.equal(nodes.length, 1, description); return nodes[0];}
function declaration(name) {
  return one(findAll(client, node => ts.isVariableDeclaration(node) && node.name.getText(client) === name), name);
}
function expression(source, bindings) {
  const script = ts.transpileModule(`const extracted = (${source});`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext(script + '\nextracted;', bindings);
}
function probeFunction(name, bindings) {
  const node = one(probe.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
  return expression(node.getText(probe), bindings);
}
const drawCallback = declaration('drawReviewAt').initializer.arguments[0];
const processingCallback = declaration('processRecording').initializer.arguments[0];
const completionDraw = one(findAll(processingCallback, node => ts.isCallExpression(node)
  && ['drawReviewAt', 'drawReviewAtRef.current'].includes(node.expression.getText(client))
  && node.arguments.length === 1 && node.arguments[0].getText(client) === '0'), 'one imperative completion draw');
const committedDrawEffects = findAll(client, node => ts.isCallExpression(node)
  && node.expression.getText(client) === 'useLayoutEffect'
  && node.arguments[0]?.getText(client).includes('drawReviewAtRef.current = drawReviewAt'));

// The actual first candidate/target layouts from QA run 37484611339. Fresh
// metadata differs slightly from the old catalog; its portrait correction does
// not: ratio=512/910 produced 55.9056px, while the stale ratio=1 produced 180.8183px.
const portraitAspect = 512 / 910;
const candidateLayout = [0.47750353068113327, 0.48007645457983017, 0.6713885217905045, 0.6937031298875809];
const inputLayout = [0.43637673556804657, 0.4636842757463455, 0.4445714056491852, 0.31805619597435];
const geometry = layout => ({layout});
const choice = {candidate: {id: 'first-photo', name: 'first', geometry: geometry(candidateLayout)}, frame: {time: 0, geometry: geometry(inputLayout)}, error: {total: 0}};
const browserChoice = {id: choice.candidate.id, time: 0, url: 'http://127.0.0.1:4183/api/catalog/image?first', candidateLayout, inputLayout};
function drawFixture() {
  const draws = [];
  const refs = {
    outputCanvasRef: {current: {width: 768, height: 768}},
    sequenceRef: {current: [{time: 0, choice}]},
    replayFpsRef: {current: 20}, outputImagesRef: {current: new Map([[choice.candidate.id, {width: 256, height: 256}]])},
    lastOutputIdRef: {current: null},
  };
  function callback({sourceAspectRatio = 1, faceTracking = true, faceOnly = false, clipDuration = 5} = {}) {
    return expression(drawCallback.getText(client), {
      ...refs, sourceAspectRatio, faceTracking, faceOnly, clipDuration, reviewItemAtTime, quantizeReviewTime,
      setCurrentOutputName() {}, setCurrentOutputSource() {}, setCurrentError() {},
      drawFacePresentation(canvas, image, selected, options) {
        draws.push({canvas, image, selected, options, transform: facePresentationTransform(selected.candidate.geometry, selected.frame.geometry, options.sourceAspectRatio, options.trackFace)});
      },
    });
  }
  return {draws, callback};
}
async function completeAcrossRender(currentOptions, passiveEffectBeforeCompletion = true) {
  const fixture = drawFixture(), startedDraw = fixture.callback(), drawRef = {current: startedDraw};
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const finish = expression(`async () => {await pending; ${completionDraw.getText(client)};}`, {
    pending, drawReviewAt: startedDraw, drawReviewAtRef: drawRef,
  });
  const completion = finish();
  const committedDraw = fixture.callback(currentOptions);
  for (const effect of committedDrawEffects) expression(`() => {${effect.getText(client)};}`, {
    drawReviewAt: committedDraw, drawReviewAtRef: drawRef, useLayoutEffect: effect => effect(),
  })();
  // This is the observed bad ordering: the current review-phase effect has
  // already drawn when the old async task resumes and draws once more.
  if (passiveEffectBeforeCompletion) committedDraw(0);
  release(); await completion;
  return {...fixture, committedDraw};
}
function near(actual, expected, label) {assert(Math.abs(actual - expected) < 1e-10, `${label}: ${actual} != ${expected}`);}

test('async processing completion preserves the committed portrait transform before any seek', async () => {
  const {draws} = await completeAcrossRender({sourceAspectRatio: portraitAspect, clipDuration: 23.3});
  assert.equal(draws.length, 2);
  const last = draws.at(-1);
  assert.equal(last.options.sourceAspectRatio, portraitAspect);
  assert.equal(last.selected, choice);
  near(last.transform.scale, 0.7690766166455458, 'portrait scale');
  near(844 * (0.5 + last.transform.yPercent / 100 - last.transform.scale / 2), 55.90563079954953, 'first photo top in the 844px stage');
});

test('async completion reads tracking and face-only controls changed while processing', async () => {
  const {draws} = await completeAcrossRender({sourceAspectRatio: portraitAspect, faceTracking: false, faceOnly: true, clipDuration: 23.3});
  assert.equal(draws.at(-1).options.faceOnly, true);
  assert.equal(draws.at(-1).options.trackFace, false);
  assert.deepEqual(draws.at(-1).transform, {xPercent: 0, yPercent: 0, scale: 1});
  assert.equal(draws.at(-1).selected, choice, 'Display controls must not select another photo');
});

test('completion also uses committed metadata when no passive review redraw has happened yet', async () => {
  const {draws} = await completeAcrossRender({sourceAspectRatio: 16 / 9, clipDuration: 23.3}, false);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].options.sourceAspectRatio, 16 / 9);
  assert.deepEqual(draws[0].transform, facePresentationTransform(choice.candidate.geometry, choice.frame.geometry, 16 / 9, true));
});

test('the original square-aspect closure reproduces the saved 181px failure edge without changing layout', () => {
  const fixture = drawFixture(); fixture.callback()(0);
  const transform = fixture.draws[0].transform;
  near(transform.scale, 0.519593386995635, 'stale scale');
  near(844 * (0.5 + transform.yPercent / 100 - transform.scale / 2), 180.81832764203597, 'stale top');
});

function drawingState(transform, extra = {}) {
  return {width: 768, height: 768, drawCount: 2, pixelHash: 'fixed-pixels', videoTime: 0,
    lastDraw: {matrix: [transform.scale, 0, 0, transform.scale, 768 * (0.5 + transform.x), 768 * (0.5 + transform.y)], sourceImage: {url: browserChoice.url, width: 256, height: 256, naturalWidth: 256, naturalHeight: 256}, args: [-384, -384]}, ...extra};
}
const expectedTransform = probeFunction('expectedTransform', {});
const assertDrawing = probeFunction('assertDrawing', {assert});

test('presentation QA saves the bad initial matrix and checks it before invoking any seek', async () => {
  const state = drawingState(expectedTransform(browserChoice, 1)), trial = {name: 'candidate', checks: []}, calls = [];
  const verify = probeFunction('verifyPresentation', {
    page: {getByTestId: () => ({evaluate: async () => portraitAspect}), waitForFunction: async () => undefined},
    selectionSignature: async () => ({ids: [browserChoice.id]}), expectedTransform, assertDrawing, assert,
    check: (value, label) => assert(value, label), canvasState: async () => state,
    seek: async () => {calls.push('seek');}, settle: async () => {calls.push('settle');},
    screenshot: async name => {calls.push(name);},
  });
  await assert.rejects(verify(trial, [browserChoice]), /Actual face transform differs at matrix component 0/);
  assert.equal(calls.includes('seek'), false, 'A seek can hide the stale completion draw by forcing a current callback');
  assert.equal(trial.presentation.initial.beforeAnySeek, true);
  assert.deepEqual(trial.presentation.initial.lastDraw.matrix, state.lastDraw.matrix);
  near(trial.presentation.initial.expected.scale, 0.7690766166455458, 'saved expected scale');
  assert(calls.includes('candidate-initial.png'));
});

test('matrix gate retains its 0.0001 tolerance and includes actual/expected evidence on failure', () => {
  const expected = expectedTransform(browserChoice, portraitAspect), state = drawingState(expected);
  assert.doesNotThrow(() => assertDrawing(state, expected, browserChoice));
  state.lastDraw.matrix[0] += 0.00009;
  assert.doesNotThrow(() => assertDrawing(state, expected, browserChoice));
  state.lastDraw.matrix[0] += 0.00002;
  assert.throws(() => assertDrawing(state, expected, browserChoice), error => {
    assert.match(error.message, /matrix component 0/);
    assert.match(error.message, /actual/); assert.match(error.message, /expected/);
    assert.match(error.message, /videoTime/); assert.match(error.message, /sourceImage/);
    return true;
  });
});

test('canvas evidence freezes pixels, draw metadata, dimensions and video time before hashing awaits', async () => {
  const before = drawingState(expectedTransform(browserChoice, portraitAspect));
  const capture = {__cleanDrawCount: before.drawCount, __cleanDraws: [structuredClone(before.lastDraw)]};
  const pixels = new Uint8ClampedArray([11, 22, 33, 255]);
  const canvas = {width: 768, height: 768, getContext: () => ({getImageData: () => ({data: pixels})})};
  const video = {currentTime: 0, videoWidth: 512, videoHeight: 910, paused: true, seeking: false};
  let finishHash, hashStarted;
  const hashing = new Promise(resolve => {hashStarted = resolve;});
  const readCanvas = probeFunction('canvasState', {page: {evaluate: callback => callback()}, window: capture,
    document: {querySelector: selector => selector.includes('output-canvas') ? canvas : video},
    crypto: {subtle: {digest: (_algorithm, snapshot) => {
      assert.equal(snapshot, pixels); hashStarted(); return new Promise(resolve => {finishHash = resolve;});
    }}}, structuredClone, Uint8Array,
  });
  const pending = readCanvas(); await hashing;
  canvas.width = 1280; video.currentTime = 1; capture.__cleanDrawCount = 3;
  capture.__cleanDraws[0].matrix[0] = 99;
  capture.__cleanDraws.push({matrix: [9, 0, 0, 9, 0, 0]});
  finishHash(new Uint8Array([1, 2, 3]).buffer);
  const result = await pending;
  assert.equal(result.width, 768); assert.equal(result.height, 768);
  assert.equal(result.videoTime, 0); assert.equal(result.drawCount, 2);
  assert.deepEqual(result.lastDraw, before.lastDraw);
  assert.equal(result.pixelHash, '010203');
});

test('test-only draw capture carries the decoded photo through the presentation layer and counts successful draws only', () => {
  class ImageElement {}
  class Context {
    constructor(canvas) {this.canvas = canvas; this.fail = false;}
    getTransform() {return {a: 0.769, b: 0, c: 0, d: 0.769, e: 348, f: 346};}
    drawImage() {if (this.fail) throw new Error('native draw failed'); return 'native-result';}
  }
  const capture = {Worker: class {}};
  const install = probeFunction('installCapture', {window: capture, CanvasRenderingContext2D: Context,
    HTMLImageElement: ImageElement, performance: {now: () => 12}, WeakMap, URL, structuredClone});
  install();
  const photo = Object.assign(new ImageElement(), {src: browserChoice.url, currentSrc: browserChoice.url, width: 256, height: 256, naturalWidth: 256, naturalHeight: 256, complete: true});
  const layer = {width: 768, height: 768}, output = {width: 768, height: 768, getAttribute: () => 'output-canvas'};
  new Context(layer).drawImage(photo, 0, 0, 768, 768);
  const context = new Context(output);
  assert.equal(context.drawImage(layer, -384, -384), 'native-result');
  assert.equal(capture.__cleanDrawCount, 1);
  const observed = capture.__cleanDraws.at(-1);
  assert.equal(observed.sourceImage.url, browserChoice.url);
  assert.equal(observed.sourceImage.naturalWidth, 256); assert.equal(observed.sourceImage.naturalHeight, 256);
  assert.equal(observed.sourceWidth, 768); assert.equal(observed.sourceHeight, 768);
  context.fail = true;
  assert.throws(() => context.drawImage(layer, -384, -384), /native draw failed/);
  assert.equal(capture.__cleanDrawCount, 1, 'A failed native call is not evidence of drawn pixels');
});
