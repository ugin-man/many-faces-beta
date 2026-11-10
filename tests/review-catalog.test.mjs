import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { liveCandidateFromEntry } from '../app/live-matching.ts';
import { reviewCandidateFromEntry, reviewCandidateBytes, isReviewCompactManifest, isReviewCompactShard } from '../app/live/review-catalog.ts';
import { ReviewShardCache } from '../app/live/review-work-cache.ts';
import { buildReviewCatalog } from '../tools/build-review-catalog.mjs';

const encoded = length => {
  const bytes = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) bytes.writeInt16LE((i * 31) % 8192 - 4096, i * 2);
  return bytes.toString('base64');
};
const entry = (overrides = {}) => ({ id: 'face', name: 'Face', feature: Array.from({ length: 55 }, (_, i) => i / 100), shape: encoded(168), mesh: encoded(795), projection: encoded(936), layout: [0.5, 0.6, 0.8, 0.7], pack: 'pack_0.bin', offset: 20, length: 40, sourceName: 'Source', license: 'CC0', ...overrides });
const consumed = candidate => candidate && ({ ...candidate, geometry: { projection: candidate.geometry.projection, layout: candidate.geometry.layout } });

test('video legacy loader preserves original admission, metadata and consumed numbers', () => {
  for (const overrides of [{}, { image: 'image.webp' }, { mesh: 'invalid%%' }, { layout: null }, { feature: [NaN, Infinity, null, ...Array(30).fill(1)] }, { shape: undefined }, { shape: '%%%%' }, { shape: encoded(12) }, { projection: encoded(935) }, { offset: -1 }, { length: 0 }, { feature: Array(21).fill(0) }]) {
    const row = entry(overrides);
    const before = liveCandidateFromEntry(row, 's.json'), after = reviewCandidateFromEntry(row, 's.json');
    assert.deepEqual(consumed(after), consumed(before));
    if (after) { assert.equal(after.geometry.structure.length, 0); assert.strictEqual(after.geometry.surface, after.geometry.projection); }
  }
  const result = reviewCandidateFromEntry(entry(), 's.json');
  assert.ok(reviewCandidateBytes([result]) > result.geometry.projection.byteLength);
});

test('compact generation uses original admission and binds shards to the source manifest', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-catalog-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'), output = path.join(temp, 'compact');
  await fs.mkdir(path.join(source, 'shards'), { recursive: true });
  const rawManifest = Buffer.from(JSON.stringify({ catalogId: 'catalog-v1', cells: { '0:0': { shards: ['s.json'] } } }));
  await fs.writeFile(path.join(source, 'manifest.json'), rawManifest);
  const rows = [entry(), entry({ id: 'bad', shape: encoded(12) }), entry({ id: 'face-2', mesh: undefined })];
  await fs.writeFile(path.join(source, 'shards/s.json'), JSON.stringify({ items: rows }));
  const result = await buildReviewCatalog(source, output);
  assert.equal(result.sourceRecords, 3); assert.equal(result.admittedRecords, 2);
  const hash = createHash('sha256').update(rawManifest).digest('hex');
  const manifest = JSON.parse(await fs.readFile(path.join(output, hash, 'manifest.json')));
  const shard = JSON.parse(await fs.readFile(path.join(output, hash, 'shards/s.json')));
  assert.ok(isReviewCompactManifest(manifest, hash, 'catalog-v1'));
  assert.ok(!isReviewCompactManifest(manifest, '0'.repeat(64), 'catalog-v1'));
  assert.ok(!isReviewCompactManifest(manifest, hash, 'other'));
  assert.ok(isReviewCompactShard(shard, manifest, 's.json'));
  assert.ok(!isReviewCompactShard({ ...shard, sourceShardSha256: '0'.repeat(64) }, manifest, 's.json'));
  assert.ok(!isReviewCompactShard({ ...shard, items: [] }, manifest, 's.json'));
  assert.deepEqual(shard.items.map(item => item.id), ['face', 'face-2']);
  for (const row of shard.items) {
    assert.ok(!('shape' in row)); assert.ok(!('mesh' in row));
    assert.deepEqual(consumed(reviewCandidateFromEntry(row, 's.json', true)), consumed(liveCandidateFromEntry(rows.find(item => item.id === row.id), 's.json')));
  }
  assert.ok(result.compactBytes < result.sourceBytes);
});

test('decoded shard LRU has byte/record limits, retains complete sets and invalidates versions', () => {
  const cache = new ReviewShardCache(100, 3);
  cache.setIdentity('one'); const first = [{ id: 1 }, { id: 2 }];
  cache.set('a', first, 60, 2); cache.set('b', [{ id: 3 }], 30, 1);
  assert.strictEqual(cache.get('a'), first);
  cache.set('c', [{ id: 4 }], 30, 1); assert.equal(cache.get('b'), undefined);
  assert.ok(cache.stats().bytes <= 100); assert.ok(cache.stats().records <= 3);
  cache.set('too-large', first, 101, 2); assert.equal(cache.get('too-large'), undefined);
  cache.setIdentity('one'); assert.strictEqual(cache.get('a'), first);
  cache.setIdentity('two'); assert.equal(cache.get('a'), undefined); assert.equal(cache.stats().bytes, 0);
  const disabled = new ReviewShardCache(0, 0); disabled.set('a', first, 60, 2); assert.equal(disabled.get('a'), undefined);
  assert.throws(() => cache.set('invalid', [], NaN, 1), RangeError);
});

test('optional CLI build skips a manifest-only checkout but fails a partially installed catalog', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-catalog-cli-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'), output = path.join(temp, 'compact');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ catalogId: 'catalog-v1', cells: { '0:0': { shards: ['a.json', 'b.json'] } } }));
  const run = () => promisify(execFile)(process.execPath, [
    '--experimental-strip-types', fileURLToPath(new URL('../tools/build-review-catalog.mjs', import.meta.url)), source, output, '--if-present',
  ]);
  const skipped = JSON.parse((await run()).stdout);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /shards.*not installed/i);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  await fs.mkdir(path.join(source, 'shards'));
  await assert.rejects(run(), error => error.code !== 0 && /ENOENT/.test(error.stderr));
  await fs.writeFile(path.join(source, 'shards/a.json'), JSON.stringify({ items: [entry()] }));
  await assert.rejects(run(), error => error.code !== 0 && /ENOENT/.test(error.stderr) && /b\.json/.test(error.stderr));
});
