import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { liveCandidateFromEntry } from '../app/live-matching.ts';

test('real search worker reuses decoded data, rejects stale compact identity and recovers after cancellation', { timeout: 20000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-worker-'));
  const bundle = path.join(temp, 'search.mjs');
  await build({ entryPoints: [new URL('../app/live/review-search.worker.ts', import.meta.url).pathname], outfile: bundle, bundle: true, platform: 'browser', format: 'esm', define: { __MF_BUILD_ID__: '"test-build"', __MF_REVISION__: '"test"' }, logLevel: 'silent' });
  const projection = Buffer.alloc(936 * 2);
  for (let i = 0; i < 936; i++) projection.writeInt16LE((i % 32) * 32, i * 2);
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: `face-${i}`, feature: Array(55).fill(0), shape: Buffer.alloc(26).toString('base64'), mesh: projection.toString('base64'), projection: projection.toString('base64'), pack: 'p.bin', offset: i * 10, length: 10 }));
  const source = { items: rows }, sourceSha = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const compactRows = rows.map(row => { const item = { ...row }; delete item.shape; delete item.mesh; return item; });
  let version = 1, broken = false, corruptRow = false, blockNext = false, compactReads = 0, legacyReads = 0;
  let blocked;
  let observeBlocked = () => {};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const manifest = { catalogId: `version-${version}`, totalFaces: 70000, cells: { '0:0': { count: rows.length, shards: ['s.json'] } } };
    const rawManifest = JSON.stringify(manifest), manifestSha = createHash('sha256').update(rawManifest).digest('hex');
    const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/catalog/manifest') return response.end(rawManifest);
    if (url.pathname === '/api/catalog/review-manifest') return json({ schema: 'many-faces-review-catalog-v1', sourceManifestSha256: manifestSha, catalogId: manifest.catalogId, records: rows.length, shards: { 's.json': { sha256: sourceSha, records: rows.length, bytes: 1000 } } });
    if (url.pathname === '/api/catalog/review-shard') {
      compactReads++;
      if (blockNext) { blockNext = false; blocked = response; observeBlocked(); return; }
      const items = corruptRow ? compactRows.map((row, i) => i ? row : { ...row, projection: undefined }) : compactRows;
      return json({ schema: 'many-faces-review-catalog-v1', sourceManifestSha256: manifestSha, sourceShardSha256: broken ? '0'.repeat(64) : sourceSha, catalogId: manifest.catalogId, items });
    }
    if (url.pathname === '/api/catalog/shard') { legacyReads++; return json(source); }
    response.statusCode = 404; response.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entry = path.join(temp, 'entry.mjs');
  await fs.writeFile(entry, `import { parentPort } from 'node:worker_threads';\nglobalThis.self = { onmessage: null, postMessage: message => parentPort.postMessage(message) };\nawait import(${JSON.stringify(pathToFileURL(bundle).href)});\nparentPort.on('message', data => globalThis.self.onmessage({ data }));\nparentPort.postMessage({type:'ready'});\n`);
  const worker = new Worker(entry), messages = [], waiting = [];
  worker.on('message', message => {
    messages.push(message);
    for (const item of [...waiting]) if (item.predicate(message)) { waiting.splice(waiting.indexOf(item), 1); item.resolve(message); }
  });
  const receive = predicate => {
    const found = messages.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker test response timeout')), 10000);
      waiting.push({ predicate, resolve: message => { clearTimeout(timeout); resolve(message); } });
    });
  };
  t.after(async () => { await worker.terminate(); blocked?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  await receive(message => message.type === 'ready');
  const candidate = liveCandidateFromEntry(rows[0]);
  const frames = Array.from({ length: 3 }, (_, i) => ({ time: i / 30, feature: candidate.feature, geometry: candidate.geometry, compensateRoll: true }));
  const search = async id => {
    worker.postMessage({ type: 'search', jobId: id, build: 'test-build', origin, frames });
    const reply = await receive(message => message.jobId === id && ['result', 'error'].includes(message.type));
    assert.equal(reply.type, 'result', reply.message); return reply;
  };
  const first = await search(1);
  assert.equal(first.performanceMetrics.cache.jobActive, 0);
  assert.equal(first.performanceMetrics.cache.jobPinnedBytes, 0);
  assert.equal(first.performanceMetrics.cache.evictionsDuringJob, 0);
  assert.equal(first.performanceMetrics.compactFiles, 1); assert.equal(legacyReads, 0);
  const second = await search(2);
  assert.equal(compactReads, 1); assert.equal(second.performanceMetrics.cachedFiles, 1);
  assert.deepEqual(second.choices, first.choices);
  assert.ok(messages.some(message => message.jobId === 1 && message.phase === 'optimizing' && message.completed === frames.length));
  version = 2; broken = true;
  const fallback = await search(3);
  assert.equal(fallback.performanceMetrics.compactFallbacks, 1); assert.equal(fallback.performanceMetrics.legacyFiles, 1); assert.equal(legacyReads, 1);
  assert.deepEqual(fallback.choices.map(choice => choice.candidate.id), first.choices.map(choice => choice.candidate.id));
  version = 3; broken = false; corruptRow = true;
  const corrupt = await search(4);
  assert.equal(corrupt.performanceMetrics.compactFallbacks, 1); assert.equal(corrupt.performanceMetrics.compactFiles, 0); assert.equal(legacyReads, 2);
  assert.deepEqual(corrupt.choices.map(choice => choice.candidate.id), first.choices.map(choice => choice.candidate.id));
  version = 4; corruptRow = false; blockNext = true;
  const reachedBlockedRequest = new Promise(resolve => { observeBlocked = resolve; });
  worker.postMessage({ type: 'search', jobId: 5, build: 'test-build', origin, frames });
  await reachedBlockedRequest;
  worker.postMessage({ type: 'cancel', jobId: 5 });
  const recovered = await search(6);
  assert.equal(recovered.performanceMetrics.cache.jobActive, 0);
  assert.equal(recovered.performanceMetrics.cache.jobPinnedBytes, 0);
  assert.equal(recovered.performanceMetrics.cache.evictionsDuringJob, 0);
  assert.equal(recovered.choices.length, frames.length);
  assert.equal(messages.some(message => message.jobId === 5 && ['result', 'error'].includes(message.type)), false);
});
