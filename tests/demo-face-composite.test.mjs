import assert from "node:assert/strict";
import test from "node:test";
import { demoFrameIsSafe, demoMaskGeometry } from "../app/demo-face-composite.ts";

test("demo never reveals input without a fresh matching face frame", () => {
  assert.equal(demoFrameIsSafe(false, 1, 1, 1, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, Number.NaN, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, .7, 20), false);
  assert.equal(demoFrameIsSafe(true, .8, 1, 1, 20), false);
  assert.equal(demoFrameIsSafe(true, 1, 1, 1, 20), true);
  assert.equal(demoFrameIsSafe(true, 1.04, 1.04, 1, 20), true);
});

test("opaque backing is always larger than feathered replacement mask", () => {
  for (const layout of [[.5,.5,.3,.4],[.15,.2,.15,.2],[.9,.8,.7,.9]]) {
    const mask = demoMaskGeometry(layout);
    assert.ok(mask.coverRx > mask.imageRx);
    assert.ok(mask.coverRy > mask.imageRy);
  }
});

test("one or three missing frames reuse a complete protected frame, never the raw video", async () => {
  const { drawDemoFaceComposite, resetDemoFaceComposite } = await import("../app/demo-face-composite.ts");
  const previousDocument = globalThis.document;
  const previousMedia = globalThis.HTMLMediaElement;
  const draws = [];
  class FakeCanvas {
    constructor() {
      this.width = 128; this.height = 128;
      this.ctx = {
        save() {}, restore() {}, setTransform() {}, translate() {}, scale() {},
        fillRect() {}, beginPath() {}, ellipse() {}, arc() {}, fill() {},
        createRadialGradient() { return { addColorStop() {} }; },
        drawImage(image) { draws.push(image); },
        fillText() {}, clearRect() {},
        globalCompositeOperation: "source-over",
      };
    }
    getContext(type) { return type === "2d" ? this.ctx : null; }
  }
  try {
    globalThis.document = { createElement: () => new FakeCanvas() };
    globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
    const canvas = new FakeCanvas();
    const video = { readyState: 3, seeking: false, currentTime: 1, videoWidth: 100, videoHeight: 100 };
    const photo = { width: 100, height: 100 };
    const geometry = layout => ({
      structure: Array(13).fill(0),
      surface: Array(300).fill(0),
      projection: Array(936).fill(0),
      layout,
    });
    const choice = {
      frame: { time: 1, geometry: geometry([.5, .5, .3, .4]) },
      candidate: { geometry: geometry([.5, .5, .3, .4]) },
    };
    assert.equal(drawDemoFaceComposite(canvas, video, photo, choice,
      { time: 1, fps: 20, sourceAspectRatio: 1 }), true);
    const originalDraws = draws.filter(x => x === video).length;
    assert.equal(originalDraws, 1, "only safe matched frames may draw the raw source");
    for (let i = 1; i <= 3; i++) {
      video.currentTime = 1 + i / 20;
      const priorDraws = draws.length;
      assert.equal(drawDemoFaceComposite(canvas, video, undefined, choice,
        { time: video.currentTime, fps: 20, sourceAspectRatio: 1 }), false);
      assert.equal(draws.filter(x => x === video).length, originalDraws);
      const fallbackDraws = draws.slice(priorDraws);
      assert.equal(fallbackDraws.length, 1, "missing frame should draw one cached composite");
      assert.notEqual(fallbackDraws[0], video, "fallback must never draw raw video");
      assert.notEqual(fallbackDraws[0], canvas, "fallback must copy from an independent protected cache");
    }
    resetDemoFaceComposite(canvas);
    assert.equal(drawDemoFaceComposite(canvas, video, undefined, null,
      { time: 1.5, fps: 20, sourceAspectRatio: 1 }), false);
    assert.equal(draws.filter(x => x === video).length, originalDraws);
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLMediaElement = previousMedia;
  }
});
