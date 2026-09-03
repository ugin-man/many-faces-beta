import assert from "node:assert/strict";
import test from "node:test";
import { DirectImageReadyCache } from "../app/live-responsive-image-buffer.ts";

function candidate(id) {
  return {
    id,
    name: id,
    url: `/api/catalog/image?pack=pack_00000.bin&offset=${id.length}&length=12`,
    feature: Array(55).fill(0),
    geometry: {
      structure: Array(13).fill(0),
      surface: Array(300).fill(0),
      projection: Array(936).fill(0),
      layout: [0.5, 0.5, 0.8, 0.9],
    },
  };
}

function installFakeImage(delay = 0) {
  const previous = globalThis.Image;
  class FakeImage {
    decoding = "auto";
    onload = null;
    onerror = null;
    _src = "";

    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.(), delay);
    }

    get src() {
      return this._src;
    }

    decode() {
      return new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  globalThis.Image = FakeImage;
  return () => {
    if (previous === undefined) delete globalThis.Image;
    else globalThis.Image = previous;
  };
}

function wait(milliseconds = 0) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("direct image fast lane marks the highest-ranked candidate ready", async () => {
  const restore = installFakeImage();
  try {
    const cache = new DirectImageReadyCache({ maxReady: 8, concurrency: 2 });
    const top = candidate("top");
    cache.prime([top]);
    await wait(5);
    assert.equal(cache.urlFor(top), top.url);
  } finally {
    restore();
  }
});

test("latest prime plan replaces queued stale frames", async () => {
  const restore = installFakeImage(12);
  try {
    const cache = new DirectImageReadyCache({ maxReady: 8, concurrency: 1 });
    const first = candidate("first");
    const stale = candidate("stale");
    const latest = candidate("latest");
    cache.prime([first, stale]);
    cache.prime([latest]);
    await wait(45);
    assert.equal(cache.urlFor(first), first.url);
    assert.equal(cache.urlFor(latest), latest.url);
    assert.equal(cache.urlFor(stale), null);
  } finally {
    restore();
  }
});

test("clear invalidates an in-flight decode", async () => {
  const restore = installFakeImage(15);
  try {
    const cache = new DirectImageReadyCache({ maxReady: 8, concurrency: 1 });
    const item = candidate("late");
    cache.prime([item]);
    cache.clear();
    await wait(30);
    assert.equal(cache.urlFor(item), null);
  } finally {
    restore();
  }
});
