import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePoseCells, nearestPoseFiles, ParsedShardCache, PoseNeighborhood } from '../app/live/astra/catalog-neighborhood.ts';

test('sub-three-degree jitter reuses the same catalog neighborhood', () => {
  const cells = {};
  for (let yaw = -9; yaw <= 9; yaw += 3) {
    for (let pitch = -6; pitch <= 6; pitch += 3) cells[`${yaw}:${pitch}`] = { shard: `${yaw}:${pitch}.json` };
  }
  const neighborhood = new PoseNeighborhood(compilePoseCells(cells), 3);
  const first = neighborhood.update(0.1, -0.2);
  assert.equal(first.changed, true);
  const jitter = neighborhood.update(1.3, 1.2);
  assert.equal(jitter.changed, false);
  assert.deepEqual(jitter.files, first.files);
  const crossed = neighborhood.update(1.6, 0);
  assert.equal(crossed.changed, true);
  assert.notDeepEqual(crossed.files, first.files);
});

test('nearest pose selection is bounded and does not require sorting every cell', () => {
  const cells = compilePoseCells(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${index * 3}:0`, { shard: `${index}.json` }])));
  const files = nearestPoseFiles(cells, 150, 0, 9, 18);
  assert.equal(files.length, 9);
  assert.ok(files.includes('50.json'));
});

test('parsed shard cache reuses recent shards while bounding retained entries', () => {
  const cache = new ParsedShardCache(4);
  cache.set('a', [1]); cache.set('b', [2]); cache.set('c', [3]); cache.set('d', [4]);
  assert.deepEqual(cache.get('a'), [1]);
  cache.set('e', [5]);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 4);
  cache.set('f', [6], new Set(['c', 'd', 'a']));
  assert.equal(cache.size, 4);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
  assert.equal(cache.has('a'), true);
});
