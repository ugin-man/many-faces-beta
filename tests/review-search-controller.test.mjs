import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSearchController } from '../app/live/review-search-controller.ts';

class FakeWorker {
  sent = []; terminated = false; onmessage = null; onerror = null;
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  message(data) { this.onmessage?.({ data }); }
}
const result = jobId => ({ type: 'result', jobId, build: 'build', choices: [], performanceMetrics: { cachedFiles: 10 } });

test('finished searches reuse a worker, preserving new input messages and metrics', async t => {
  const workers = [], controller = new ReviewSearchController(() => { const w = new FakeWorker(); workers.push(w); return w; }, 'build');
  t.after(() => controller.dispose());
  const signal = new AbortController().signal, progress = [];
  const one = controller.run([{ time: 1 }], 'http://localhost', signal, event => progress.push(event));
  const worker = workers[0], id = worker.sent[0].jobId;
  worker.message({ type: 'progress', jobId: id, sequence: 1 });
  worker.message({ type: 'progress', jobId: id, sequence: 1 });
  worker.message(result(id)); assert.equal((await one).performanceMetrics.cachedFiles, 10);
  const two = controller.run([{ time: 2 }], 'http://localhost', signal, () => {});
  assert.equal(workers.length, 1); assert.deepEqual(worker.sent.at(-1).frames, [{ time: 2 }]);
  worker.message(result(worker.sent.at(-1).jobId)); await two;
  assert.equal(progress.length, 1); assert.equal(worker.terminated, false);
});

test('cancelled job progress, error and result cannot settle the replacement job', async t => {
  const worker = new FakeWorker(), controller = new ReviewSearchController(() => worker, 'build');
  t.after(() => controller.dispose());
  const abort = new AbortController();
  const first = controller.run([], 'http://localhost', abort.signal, () => assert.fail('cancelled progress'));
  const oldId = worker.sent[0].jobId; const rejected = assert.rejects(first, { name: 'AbortError' });
  abort.abort(); await rejected;
  assert.ok(worker.sent.some(message => message.type === 'cancel' && message.jobId === oldId));
  let finished = false;
  const second = controller.run([], 'http://localhost', new AbortController().signal, () => assert.fail('stale progress')).then(value => { finished = true; return value; });
  const newId = worker.sent.at(-1).jobId;
  worker.message({ type: 'progress', jobId: oldId, sequence: 999 });
  worker.message({ type: 'error', jobId: oldId, message: 'late error' });
  worker.message(result(oldId)); await Promise.resolve(); assert.equal(finished, false);
  worker.message(result(newId)); await second; assert.equal(finished, true);
});

test('supersession cancels the previous run and build mismatch discards the worker', async t => {
  const workers = [], controller = new ReviewSearchController(() => { const w = new FakeWorker(); workers.push(w); return w; }, 'build');
  t.after(() => controller.dispose());
  const first = controller.run([], 'http://localhost', new AbortController().signal, () => {});
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = controller.run([], 'http://localhost', new AbortController().signal, () => {});
  await rejection;
  const worker = workers[0]; const bad = assert.rejects(second, /BUILD_MISMATCH/);
  worker.message({ ...result(worker.sent.at(-1).jobId), build: 'old' }); await bad;
  assert.equal(worker.terminated, true);
  const third = controller.run([], 'http://localhost', new AbortController().signal, () => {});
  assert.equal(workers.length, 2); workers[1].message(result(workers[1].sent.at(-1).jobId)); await third;
});

test('an explicit falsy abort reason rejects instead of resolving an undefined result', async t => {
  const worker = new FakeWorker(), controller = new ReviewSearchController(() => worker, 'build');
  t.after(() => controller.dispose());
  const abort = new AbortController();
  const pending = controller.run([], 'http://localhost', abort.signal, () => {});
  const rejected = assert.rejects(pending, reason => reason === 0);
  abort.abort(0);
  await rejected;
});
