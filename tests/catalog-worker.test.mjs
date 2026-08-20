import assert from "node:assert/strict";
import test from "node:test";

function memoryBucket() {
  const objects = new Map();
  return {
    async put(key, value) {
      objects.set(key, new Uint8Array(value));
    },
    async get(key, options = {}) {
      const source = objects.get(key);
      if (!source) return null;
      const range = options.range;
      const body = range
        ? source.slice(range.offset, range.offset + range.length)
        : source;
      return {
        body,
        async text() { return new TextDecoder().decode(source); },
      };
    },
  };
}

test("uploads catalog objects and serves one packed WebP range", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("catalog-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const bucket = memoryBucket();
  const env = {
    BUCKET: bucket,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const upload = await worker.fetch(
    new Request("http://localhost/api/catalog/upload?path=packs%2Ffaces_00000.bin", {
      method: "POST",
      body: new TextEncoder().encode("abcdef"),
    }),
    env,
    ctx,
  );
  assert.equal(upload.status, 200);

  const image = await worker.fetch(
    new Request(
      "http://localhost/api/catalog/image?pack=faces_00000.bin&offset=2&length=3",
    ),
    env,
    ctx,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  assert.equal(await image.text(), "cde");
});

test("catalog writes can be restricted without blocking reads", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("upload-auth-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = {
    BUCKET: memoryBucket(),
    CATALOG_UPLOAD_KEY: "test-secret",
    CATALOG_OWNER_EMAIL: "owner@example.com",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const blocked = await worker.fetch(
    new Request("http://localhost/api/catalog/upload?path=packs%2Ffaces_00000.bin", {
      method: "POST",
      body: new TextEncoder().encode("abc"),
    }),
    env,
    ctx,
  );
  assert.equal(blocked.status, 403);
  const allowed = await worker.fetch(
    new Request("http://localhost/api/catalog/upload?path=packs%2Ffaces_00000.bin", {
      method: "POST",
      headers: { "x-catalog-upload-key": "test-secret" },
      body: new TextEncoder().encode("abc"),
    }),
    env,
    ctx,
  );
  assert.equal(allowed.status, 200);
});

test("serves bundled seed catalog when the remote bucket is empty", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("seed-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const seedObjects = new Map([
    ["/seed-catalog/manifest.json", JSON.stringify({ totalFaces: 5_000 })],
    ["/seed-catalog/index_000.json", JSON.stringify({ items: [{ id: "seed-42" }] })],
    ["/seed-catalog/images/seed_ffhq_00042.webp", "seed-image"],
    ["/seed-catalog/packs/seed_pack_000.bin", "abcdef"],
  ]);
  const env = {
    BUCKET: memoryBucket(),
    ASSETS: {
      fetch: async (request) => {
        let body = seedObjects.get(new URL(request.url).pathname);
        return body === undefined
          ? new Response("Not found", { status: 404 })
          : (() => {
              const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
              if (range) {
                body = body.slice(Number(range[1]), Number(range[2]) + 1);
                return new Response(body, { status: 206 });
              }
              return new Response(body);
            })();
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const manifest = await worker.fetch(
    new Request("http://localhost/api/catalog/manifest"),
    env,
    ctx,
  );
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).totalFaces, 5_000);

  const index = await worker.fetch(
    new Request("http://localhost/api/catalog/index?file=index_000.json"),
    env,
    ctx,
  );
  assert.equal(index.status, 200);
  assert.equal((await index.json()).items[0].id, "seed-42");

  const image = await worker.fetch(
    new Request("http://localhost/api/catalog/image?id=seed_ffhq_00042.webp"),
    env,
    ctx,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  assert.equal(await image.text(), "seed-image");

  const packedImage = await worker.fetch(
    new Request(
      "http://localhost/api/catalog/image?pack=seed_pack_000.bin&offset=2&length=3",
    ),
    env,
    ctx,
  );
  assert.equal(packedImage.status, 200);
  assert.equal(packedImage.headers.get("content-type"), "image/webp");
  assert.equal(await packedImage.text(), "cde");
});

test("accepts a geometry-in-shards remote catalog and prefers its seed-named packs", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("remote-shards-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const bucket = memoryBucket();
  await bucket.put("face-catalog/manifest.json", new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3,
    shapeVersion: "mediapipe-projection-468-v4",
    totalFaces: 70_000,
    shardsContainGeometry: true,
    cells: { "0:0": { count: 1, shards: ["seed_yaw_p000_pitch_p000_000.json"] } },
  })));
  await bucket.put("face-catalog/packs/seed_pack_040.bin", new TextEncoder().encode("remote-pack"));
  const env = {
    BUCKET: bucket,
    ASSETS: {
      fetch: async (request) => new URL(request.url).pathname === "/seed-catalog/manifest.json"
        ? new Response(JSON.stringify({ totalFaces: 15_000 }))
        : new Response("Not found", { status: 404 }),
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const manifest = await worker.fetch(
    new Request("http://localhost/api/catalog/manifest"),
    env,
    ctx,
  );
  assert.equal((await manifest.json()).totalFaces, 70_000);

  const image = await worker.fetch(
    new Request("http://localhost/api/catalog/image?pack=seed_pack_040.bin&offset=0&length=6"),
    env,
    ctx,
  );
  assert.equal(await image.text(), "remote");

  const exportedPack = await worker.fetch(
    new Request("http://localhost/api/catalog/export?path=packs%2Fseed_pack_040.bin"),
    env,
    ctx,
  );
  assert.equal(exportedPack.status, 200);
  assert.equal(exportedPack.headers.get("content-type"), "application/octet-stream");
  assert.equal(exportedPack.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await exportedPack.text(), "remote-pack");

  const exportedManifest = await worker.fetch(
    new Request("http://localhost/api/catalog/export?path=manifest.json"),
    env,
    ctx,
  );
  assert.equal(exportedManifest.status, 200);
  assert.equal((await exportedManifest.json()).totalFaces, 70_000);

  const blockedExport = await worker.fetch(
    new Request("http://localhost/api/catalog/export?path=..%2Fsecret"),
    env,
    ctx,
  );
  assert.equal(blockedExport.status, 400);
});
