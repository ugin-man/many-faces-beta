import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePreloadCandidates,
  LivePackedImageBuffer,
} from "../app/live-packed-image-buffer.ts";

function candidate(id, pack) {
  return {
    id,
    name: id,
    url: `/api/catalog/image?id=${id}`,
    pack,
    offset: 0,
    length: 10,
    feature: Array(55).fill(0),
    geometry: {
      structure: Array(13).fill(0),
      surface: Array(300).fill(0),
      projection: Array(936).fill(0),
      layout: [0.5, 0.5, 1, 1],
    },
  };
}

test("preload selection bounds new pack fan-out", () => {
  const candidates = [
    candidate("a1", "a.bin"),
    candidate("b1", "b.bin"),
    candidate("c1", "c.bin"),
    candidate("a2", "a.bin"),
    candidate("b2", "b.bin"),
    candidate("c2", "c.bin"),
  ];
  const selected = choosePreloadCandidates(candidates, new Set(), 10, 2);
  assert.deepEqual(selected.map((item) => item.id), ["a1", "b1", "a2", "b2"]);
});

test("already known packs do not consume the new-pack budget", () => {
  const candidates = [
    candidate("known", "known.bin"),
    candidate("a", "a.bin"),
    candidate("b", "b.bin"),
  ];
  const selected = choosePreloadCandidates(
    candidates,
    new Set(["known.bin"]),
    10,
    1,
  );
  assert.deepEqual(selected.map((item) => item.id), ["known", "a"]);
});

test("rapid prime calls keep only the latest queued plan", async () => {
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const fetches = [];
  let objectUrl = 0;

  class InstantImage {
    decoding = "async";
    onload = null;
    onerror = null;

    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }

    decode() {
      return Promise.resolve();
    }
  }

  globalThis.Image = InstantImage;
  URL.createObjectURL = () => `blob:test-${objectUrl += 1}`;
  URL.revokeObjectURL = () => undefined;
  globalThis.fetch = async (url) => {
    fetches.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 12));
    return new Response(new Uint8Array(64), { status: 200 });
  };

  try {
    const buffer = new LivePackedImageBuffer({
      preloadConcurrency: 1,
      maxPackBytes: 1024 * 1024,
      decodeTimeoutMs: 1_000,
    });
    const first = buffer.prime([candidate("a", "a.bin")], {
      maxImages: 1,
      maxNewPacks: 1,
    });
    const second = buffer.prime([candidate("b", "b.bin")], {
      maxImages: 1,
      maxNewPacks: 1,
    });
    const latestCandidate = candidate("c", "c.bin");
    const third = buffer.prime([latestCandidate], {
      maxImages: 1,
      maxNewPacks: 1,
    });

    await Promise.all([first, second, third]);

    assert.equal(buffer.isReady(latestCandidate), true);
    assert.equal(fetches.some((url) => url.endsWith("/b.bin")), false);
    assert.ok(fetches.length <= 2, `expected <=2 pack requests, got ${fetches.length}`);
    const stats = buffer.stats();
    assert.equal(stats.primeRequests, 3);
    assert.ok(stats.primePasses <= 2);
    buffer.clear();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
