import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProgressDeadline, readAssetBytes, readAssetJson } from '../app/live/asset-reader.ts';
import { poseWindowCellKeys, shardFilesForCells } from '../app/live/review-local-catalog.ts';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('byte/decode progress survives 90 seconds; repeated heartbeat counters do not', () => {
  const clock = new ProgressDeadline(0);
  for (let second = 0; second <= 150; second++) {
    clock.observe(second, second * 1000);
    assert.equal(clock.expired(second * 1000, 90000), false);
  }
  assert.equal(clock.observe(150, 239000), false);
  assert.equal(clock.expired(240000, 90000), true);
  assert.equal(clock.expired(150000, 90000, 120000), true);
});

test('slow advancing HTTP body can outlive idle timeout without being aborted', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  let timer;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    let n = 0; timer = setInterval(() => { controller.enqueue(new Uint8Array([n++])); if (n === 12) { clearInterval(timer); controller.close(); } }, 15);
  }, cancel() { clearInterval(timer); } }));
  const counts = [];
  const output = await readAssetBytes('http://fixture/shard', { idleMs: 90, maxMs: 2000, onBytes: received => counts.push(received) });
  assert.deepEqual([...output], Array.from({ length: 12 }, (_, i) => i));
  assert.equal(counts.at(-1), 12);
});

test('HTTP headers and empty chunks cannot keep a stuck body alive', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readAssetBytes('http://fixture/hung', { idleMs: 35, maxMs: 500 }), /ASSET_IDLE_TIMEOUT/);
  assert.equal(cancelled, true);
});

test('cancellation interrupts body read immediately and does not call onBytes later', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  const abort = new AbortController(); let cancelled = false, progress = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readAssetBytes('http://fixture/slow', { signal: abort.signal, onBytes: () => progress++ });
  await wait(10); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(progress, 0);
});

test('invalid deployment responses fail explicitly, not as a camera timeout', async t => {
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  globalThis.fetch = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(readAssetJson('http://fixture/api/catalog/manifest'), /ASSET_INVALID_JSON/);
  globalThis.fetch = async () => new Response('missing', { status: 404 });
  await assert.rejects(readAssetBytes('http://fixture/missing'), /ASSET_HTTP_404/);
  globalThis.fetch = async () => new Response(new Uint8Array(100));
  await assert.rejects(readAssetBytes('http://fixture/large', { maxBytes: 50 }), /ASSET_TOO_LARGE/);
});

test('all original 99 frontal pose files remain searchable: no hidden catalog reduction', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/seed-catalog/manifest.json', import.meta.url)));
  const files = shardFilesForCells(manifest, poseWindowCellKeys(manifest, [0,0], 12, 15));
  assert.equal(files.length, 99); assert.equal(manifest.totalFaces, 70000);
});

test('search is cancellable off-thread and camera ready follows CPU warmup', async () => {
  const review = await readFile(new URL('../app/live/review-client-lite.tsx', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../app/live/astra/processor.worker.ts', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../app/live/stable-landmarker.ts', import.meta.url), 'utf8');
  const search = await readFile(new URL('../app/live/review-search.ts', import.meta.url), 'utf8');
  assert.match(review, /searchReviewFrames\(frames, cancellation.signal/);
  assert.match(search, /worker.terminate\(\)/); assert.match(search, /deadline.observe/);
  assert.match(engine, /delegate: "CPU"/); assert.doesNotMatch(worker, /probeCpuIfSlow|createEngine/);
  assert.ok(worker.indexOf('landmarker.detectForVideo(warmCanvas, 0)') < worker.indexOf('type: "ready"'));
});
