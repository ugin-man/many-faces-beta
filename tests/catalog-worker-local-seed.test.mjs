import assert from "node:assert/strict";
import test from "node:test";

function cleanSeedManifest(overrides = {}) {
  return {
    schemaVersion: 3,
    catalogId: "many-faces-clean-core-v3-local",
    generatedAt: "2026-09-03T00:00:00.000Z",
    shapeVersion: "mediapipe-projection-468-v4",
    totalFaces: 70_000,
    searchableFaces: 70_000,
    shardsContainGeometry: true,
    cells: {
      "0:0": {
        count: 1,
        shards: ["clean_v3_yaw_p000_pitch_p000_000.json"],
      },
    },
    stats: {
      cleanCore: {
        runtimeImagePolicy: "real-photo-only-v1",
        knownSyntheticFaces: 0,
      },
    },
    ...overrides,
  };
}

function assetFetcher(objects) {
  return async (request) => {
    let body = objects.get(new URL(request.url).pathname);
    if (body === undefined) return new Response("Not found", { status: 404 });
    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      body = body.slice(Number(range[1]), Number(range[2]) + 1);
      return new Response(body, { status: 206 });
    }
    return new Response(body);
  };
}

async function loadWorker(label) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(label, `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

function context() {
  return { waitUntil() {}, passThroughOnException() {} };
}

test("a local preview with no R2 binding serves the bundled seed", async () => {
  const worker = await loadWorker("local-seed-no-r2");
  const manifest = cleanSeedManifest();
  const assets = new Map([
    ["/seed-catalog/manifest.json", JSON.stringify(manifest)],
    [
      "/seed-catalog/shards/clean_v3_yaw_p000_pitch_p000_000.json",
      JSON.stringify({ items: [{ id: "local-seed-face" }] }),
    ],
    ["/seed-catalog/packs/pack_00000.bin", "abcdefgh"],
  ]);
  const env = { ASSETS: { fetch: assetFetcher(assets) } };

  const manifestResponse = await worker.fetch(
    new Request("http://localhost/api/catalog/manifest?source=seed"),
    env,
    context(),
  );
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).catalogId, manifest.catalogId);

  const shardResponse = await worker.fetch(
    new Request(
      "http://localhost/api/catalog/shard?source=seed&file=clean_v3_yaw_p000_pitch_p000_000.json",
    ),
    env,
    context(),
  );
  assert.equal(shardResponse.status, 200);
  assert.equal((await shardResponse.json()).items[0].id, "local-seed-face");

  const imageResponse = await worker.fetch(
    new Request(
      "http://localhost/api/catalog/image?source=seed&pack=pack_00000.bin&offset=2&length=3",
    ),
    env,
    context(),
  );
  assert.equal(imageResponse.status, 200);
  assert.equal(await imageResponse.text(), "cde");
});

test("explicit seed mode ignores a newer remote catalog", async () => {
  const worker = await loadWorker("explicit-seed-over-remote");
  const seedManifest = cleanSeedManifest({ catalogId: "safe-git-seed" });
  const remoteManifest = cleanSeedManifest({
    catalogId: "newer-remote",
    generatedAt: "2026-09-04T00:00:00.000Z",
  });
  const assets = new Map([
    ["/seed-catalog/manifest.json", JSON.stringify(seedManifest)],
    [
      "/seed-catalog/shards/clean_v3_yaw_p000_pitch_p000_000.json",
      JSON.stringify({ items: [{ id: "seed-only-face" }] }),
    ],
  ]);
  const remoteObjects = new Map([
    ["face-catalog/manifest.json", new TextEncoder().encode(JSON.stringify(remoteManifest))],
    [
      "face-catalog/shards/clean_v3_yaw_p000_pitch_p000_000.json",
      new TextEncoder().encode(JSON.stringify({ items: [{ id: "remote-face" }] })),
    ],
  ]);
  const env = {
    ASSETS: { fetch: assetFetcher(assets) },
    BUCKET: {
      async get(key) {
        const source = remoteObjects.get(key);
        if (!source) return null;
        return {
          body: source,
          async text() { return new TextDecoder().decode(source); },
        };
      },
      async put() {},
    },
  };

  const manifestResponse = await worker.fetch(
    new Request("http://localhost/api/catalog/manifest?source=seed"),
    env,
    context(),
  );
  assert.equal((await manifestResponse.json()).catalogId, "safe-git-seed");

  const shardResponse = await worker.fetch(
    new Request(
      "http://localhost/api/catalog/shard?source=seed&file=clean_v3_yaw_p000_pitch_p000_000.json",
    ),
    env,
    context(),
  );
  assert.equal((await shardResponse.json()).items[0].id, "seed-only-face");
});

test("catalog upload is rejected when no persistent bucket exists", async () => {
  const worker = await loadWorker("upload-without-r2");
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const response = await worker.fetch(
    new Request("http://localhost/api/catalog/upload?path=manifest.json", {
      method: "POST",
      body: JSON.stringify(cleanSeedManifest()),
    }),
    env,
    context(),
  );
  assert.equal(response.status, 403);
});
