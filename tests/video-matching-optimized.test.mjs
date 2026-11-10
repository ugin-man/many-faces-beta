import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProjectionDescriptorCache,
  projectionError,
  optimizeDistinctProjectionSequence,
  optimizeDistinctProjectionSequenceAsync,
} from '../app/projection-matching.ts';
import {ReviewStrictRanker} from '../app/live/review-strict-ranker.ts';
import * as original from './helpers/projection-matching-baseline.ts';

let seed = 14327;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const base = Array.from({length: 936}, (_, i) => i % 2 ? Math.floor(i / 2) / 468 : Math.sin(i * .17));
function face(id, typed = false) {
  const data = base.map(x => x + (random() - .5) * .12);
  const projection = typed ? new Float32Array(data) : data;
  return {id, feature: Array.from({length: 55}, () => random() * .8),
    geometry: {projection, structure: [], surface: [], layout: [.5, .5, .6, .8]}};
}
const input = (candidate, i = 0) => ({time: i / 30, geometry: candidate.geometry,
  feature: candidate.feature.slice(), compensateRoll: i % 2 === 0});
const sequenceOptions = {beamWidth: 24, cooldown: 5, residualCoherence: .46,
  expressionMotionWeight: 6.2, motionWeights: {mouth: .43, eyes: .39, brows: .18}};

test('prepared descriptors preserve every original numeric error and uncached mutable callers', () => {
  const cache = new ProjectionDescriptorCache();
  const queries = Array.from({length: 6}, (_, i) => input(face(`q${i}`, i % 2 === 0), i));
  const candidates = Array.from({length: 64}, (_, i) => face(`c${i}`, i % 2 === 0));
  for (const frame of queries) for (const candidate of candidates) {
    const expected = original.projectionError(frame, candidate);
    const actual = projectionError(frame, candidate, cache);
    for (const key of Object.keys(expected)) assert.ok(Object.is(actual[key], expected[key]), key);
  }
  assert.equal(cache.stats().builds, queries.length + candidates.length);
  const frame = queries[0], candidate = candidates[0];
  frame.geometry.projection[13 * 2 + 1] += .5;
  assert.deepEqual(projectionError(frame, candidate), original.projectionError(frame, candidate));
  cache.invalidate(frame.geometry.projection);
  assert.deepEqual(projectionError(frame, candidate, cache), original.projectionError(frame, candidate));
  candidate.geometry.projection[14 * 2 + 1] -= .4;
  cache.clear();
  assert.deepEqual(projectionError(frame, candidate, cache), original.projectionError(frame, candidate));
});

test('ranker refreshes a reused query buffer and clears edited catalog projections', () => {
  const ranker = new ReviewStrictRanker();
  const frame = input(face('query'));
  const candidates = Array.from({length: 300}, (_, i) => face(`c${i}`, i % 2 === 0));
  const compare = () => assert.deepEqual(ranker.rank(frame, candidates, 12, 128),
    original.rankProjectionCandidateModesTwoStage(frame, candidates, 12, 128).strict);
  compare();
  frame.geometry.projection[13 * 2 + 1] += .4;
  frame.geometry.projection[159 * 2 + 1] -= .3;
  compare();
  candidates[0].geometry.projection[14 * 2 + 1] += .7;
  ranker.clear();
  compare();
});

test('sync and cooperative sequence preserve the frozen oracle across duplicates and cooldowns', async () => {
  const frames = Array.from({length: 7}, (_, i) => input(face(`frame${i}`, i % 2 === 0), i));
  const candidates = Array.from({length: 33}, (_, i) => face(`id${i % 19}`, i % 2 === 0));
  const beams = frames.map((frame, i) => (i % 2 ? candidates.toReversed() : candidates)
    .map(candidate => ({candidate, error: original.projectionError(frame, candidate)})));
  for (const allowRepeats of [true, false]) {
    const options = {...sequenceOptions, allowRepeats};
    const expected = original.optimizeDistinctProjectionSequence(frames, beams, options);
    assert.deepEqual(optimizeDistinctProjectionSequence(frames, beams, options), expected);
    const progress = [];
    let yields = 0;
    const actual = await optimizeDistinctProjectionSequenceAsync(frames, beams, options, {
      budgetMs: 0, onProgress: (done, total) => progress.push([done, total]),
      checkpoint: async () => { yields++; },
    });
    assert.deepEqual(actual, expected);
    assert.deepEqual(progress, frames.map((_, i) => [i + 1, frames.length]));
    assert.equal(yields, frames.length);
  }
});

test('candidate aggregation retains winning transition order after a later replacement', async () => {
  const make = (id, dx) => ({id, feature: Array(55).fill(0), geometry: {
    projection: base.map((x, i) => x + (i % 2 ? 0 : dx)), structure: [], surface: [], layout: [.5, .5, .6, .8],
  }});
  const a = make('a', 0), b = make('b', 1);
  const frames = [input(a), input(a, 1)];
  const error = original.projectionError(frames[0], a);
  const beams = [[a, b], [b, a]].map(items => items.map(candidate => ({candidate, error})));
  const options = {...sequenceOptions, allowRepeats: true};
  const expected = original.optimizeDistinctProjectionSequence(frames, beams, options);
  assert.equal(expected[1].candidate.id, 'a');
  assert.deepEqual(optimizeDistinctProjectionSequence(frames, beams, options), expected);
  assert.deepEqual(await optimizeDistinctProjectionSequenceAsync(frames, beams, options), expected);
});

test('non-finite costs retain the original stable-sort fallback', () => {
  const a = face('a'), b = face('b');
  const frames = [input(a), input(b, 1), input(a, 2)];
  const beams = frames.map((frame, index) => [a, b].map((candidate, i) => ({candidate,
    error: {...original.projectionError(frame, candidate), total: index === 1 && i === 1 ? NaN : Infinity},
  })));
  const options = {...sequenceOptions, allowRepeats: true};
  assert.deepEqual(optimizeDistinctProjectionSequence(frames, beams, options),
    original.optimizeDistinctProjectionSequence(frames, beams, options));
});

test('cooperative sequence observes cancellation and propagates scheduler failures', async () => {
  const candidate = face('only'), frames = Array.from({length: 5}, (_, i) => input(candidate, i));
  const beams = frames.map(frame => [{candidate, error: original.projectionError(frame, candidate)}]);
  const controller = new AbortController();
  const reason = new Error('cancelled at checkpoint');
  const progress = [];
  await assert.rejects(optimizeDistinctProjectionSequenceAsync(frames, beams, {allowRepeats: true}, {
    budgetMs: 0, signal: controller.signal, onProgress: done => progress.push(done),
    checkpoint: async () => controller.abort(reason),
  }), error => error === reason);
  assert.deepEqual(progress, [1]);
  await assert.rejects(optimizeDistinctProjectionSequenceAsync(frames, beams, {}, {
    signal: controller.signal, onProgress: () => assert.fail('pre-cancelled work advanced'),
  }), error => error === reason);
  const schedulerError = new Error('scheduler closed');
  await assert.rejects(optimizeDistinctProjectionSequenceAsync(frames, beams, {}, {
    budgetMs: 0, checkpoint: async () => { throw schedulerError; },
  }), error => error === schedulerError);
  assert.deepEqual(await optimizeDistinctProjectionSequenceAsync([], []), []);
});
