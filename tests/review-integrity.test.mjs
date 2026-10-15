import assert from "node:assert/strict";
import test from "node:test";
import { evaluateVerificationGate } from "../app/live/verification-gate.ts";
import { seekDecodedVideoFrame } from "../app/live/video-frame.ts";
const good = { plannedFrames: 60, faceFrames: 60, sequenceFrames: 60, selectedImages: 20, imageFailures: 0, outputChanges: 59, canvasNonBlank: true };

test("runtime integrity rejects invalid counters, failed images and frozen output", () => {
  assert.equal(evaluateVerificationGate(good).passed, true);
  for (const patch of [{ imageFailures: 1 }, { imageFailures: NaN }, { faceFrames: 61, sequenceFrames: 61 }, { selectedImages: 61 }, { outputChanges: 0 }, { faceFrames: 2.5 }, { canvasNonBlank: "true" }]) {
    assert.equal(evaluateVerificationGate({ ...good, ...patch }).passed, false, JSON.stringify(patch));
  }
});

test("presentation listener is armed before seeking and stale callbacks are ignored", async () => {
  class FakeVideo extends EventTarget {
    duration = 5; readyState = 2; seeking = false; time = 0; callback; next = 0;
    get currentTime() { return this.time; }
    set currentTime(time) {
      assert.equal(typeof this.callback, "function", "callback must exist before seek");
      this.time = time;
      queueMicrotask(() => {
        this.callback(0, { mediaTime: 0 });
        queueMicrotask(() => this.callback(0, { mediaTime: time }));
      });
    }
    requestVideoFrameCallback(callback) { this.callback = callback; return ++this.next; }
    cancelVideoFrameCallback() {}
  }
  const video = new FakeVideo();
  await seekDecodedVideoFrame(video, 1);
  assert.equal(video.next, 2);
});

test("cancelled decoding cannot complete a new run", async () => {
  const controller = new AbortController();
  const video = new EventTarget();
  Object.assign(video, { duration: 5, currentTime: 0, readyState: 0, requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {} });
  const pending = seekDecodedVideoFrame(video, 1, controller.signal);
  controller.abort(new DOMException("reset", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});
