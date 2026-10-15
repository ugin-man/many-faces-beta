import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestFrameGate, acquireCurrentStream, qualityBoundedReadyChoice } from '../app/live/astra/runtime.ts';

test('realtime never queues old frames behind a busy processor', () => {
  const gate = new LatestFrameGate();
  const first = gate.reserve(100, 0, 20);
  assert.equal(first, 1);
  for (let i = 0; i < 300; i++) assert.equal(gate.reserve(101 + i, (i + 1) / 30, 20), null);
  assert.equal(gate.inFlight, 1);
  assert.equal(gate.busyDrops, 300);
  assert.equal(gate.complete(first, 420), true);
  assert.equal(gate.inFlight, 0);
  assert.equal(gate.reserve(450, 11, 20), 2);
});

test('late results release the slot but cannot be displayed', () => {
  const gate = new LatestFrameGate();
  const id = gate.reserve(0, 0);
  assert.equal(gate.complete(id, 501), false);
  assert.equal(gate.staleResults, 1);
  assert.equal(gate.inFlight, 0);
  const next = gate.reserve(550, 1);
  assert.equal(gate.complete(id, 560), false);
  assert.equal(gate.inFlight, 1);
  assert.equal(gate.complete(next, 600), true);
});

test('duplicate media frames are not parsed twice; video loops remain valid', () => {
  const gate = new LatestFrameGate();
  const id = gate.reserve(0, 10);
  gate.complete(id, 20);
  assert.equal(gate.reserve(100, 10), null);
  assert.notEqual(gate.reserve(150, 0), null);
  assert.equal(gate.stalled(9000), true);
});

test('a permission grant after cancellation immediately stops every track', async () => {
  let current = true;
  let resolve;
  let stopped = 0;
  const promise = acquireCurrentStream(() => new Promise((done) => { resolve = done; }), () => current, 1000);
  current = false;
  resolve({ getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(stopped, 2);
});

test('a permission grant after timeout also stops the late stream', async () => {
  let resolve;
  let stopped = 0;
  const promise = acquireCurrentStream(() => new Promise((done) => { resolve = done; }), () => true, 5);
  await assert.rejects(promise, /許可待ち/);
  resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(stopped, 1);
});

test('quality bound prevents inflating output FPS with unrelated ready faces', () => {
  const ranked = [{ id: 'best', score: 0.1 }, { id: 'close', score: 0.12 }, { id: 'bad', score: 0.9 }];
  assert.equal(qualityBoundedReadyChoice(ranked, (c) => c.id === 'bad', null, true), null);
  assert.equal(qualityBoundedReadyChoice(ranked, (c) => c.id !== 'best', null, true)?.id, 'close');
  assert.equal(qualityBoundedReadyChoice(ranked, () => true, 'close', false)?.id, 'close');
  assert.equal(qualityBoundedReadyChoice(ranked, () => true, 'close', true)?.id, 'best');
});
