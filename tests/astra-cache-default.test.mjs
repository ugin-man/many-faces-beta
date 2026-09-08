import test from 'node:test';
import assert from 'node:assert/strict';
import { ParsedShardCache } from '../app/live/astra/catalog-neighborhood.ts';

test('production default keeps LRU until an alternative wins resource and quality gates', () => {
  const cache = new ParsedShardCache(2);
  cache.set('a', 1); cache.set('b', 2);
  for (let i = 0; i < 20; i++) cache.touch('a');
  cache.touch('b'); cache.set('c', 3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.stats().shardHistoryEntries, 0);
});
