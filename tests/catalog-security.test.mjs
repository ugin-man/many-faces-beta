import assert from "node:assert/strict";
import test from "node:test";
const context = { waitUntil() {}, passThroughOnException() {} };
async function runtime() { return (await import("../dist/server/index.js")).default; }
function bucket(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { values, async get(key, options = {}) {
    const value = values.get(key);
    if (value === undefined) return null;
    const raw = new TextEncoder().encode(value);
    const body = options.range ? raw.slice(options.range.offset, options.range.offset + options.range.length) : raw;
    return { body, size: raw.length, async text() { return value; } };
  }, async put(key, bytes) { values.set(key, new TextDecoder().decode(bytes)); } };
}
function manifest(id, date, synthetic = 0) { return { schemaVersion: 3, shapeVersion: "mediapipe-projection-468-v4", catalogId: id, totalFaces: 70_000, generatedAt: date, shardsContainGeometry: true, cells: { "0:0": { count: 1, shards: ["face.json"] } }, stats: { cleanCore: { runtimeImagePolicy: "real-photo-only-v1", knownSyntheticFaces: synthetic } } }; }
function envFor(remote, seed) { return { BUCKET: bucket(remote), ASSETS: { async fetch(request) {
  const value = seed[new URL(request.url).pathname];
  return value === undefined ? new Response("missing", { status: 404 }) : new Response(value);
} } }; }

test("catalog uploads fail closed and a forged owner header is not authorization", async () => {
  const worker = await runtime();
  for (const extra of [{}, { CATALOG_UPLOAD_KEY: "secret", CATALOG_OWNER_EMAIL: "owner@example.com" }]) {
    const env = { ...envFor({}, {}), ...extra };
    const response = await worker.fetch(new Request("https://local/api/catalog/upload?path=packs/a.bin", { method: "POST", headers: { "oai-authenticated-user-email": "owner@example.com" }, body: "abc" }), env, context);
    assert.equal(response.status, 403);
    assert.equal(env.BUCKET.values.size, 0);
  }
});

test("auto manifest and same-named image pack use the same selected source", async () => {
  const worker = await runtime();
  const env = envFor({ "face-catalog/manifest.json": JSON.stringify(manifest("remote", "2026-09-02")), "face-catalog/packs/shared.bin": "REMOTE" }, { "/seed-catalog/manifest.json": JSON.stringify(manifest("seed", "2026-09-01")), "/seed-catalog/packs/shared.bin": "SEED!!" });
  assert.equal((await (await worker.fetch(new Request("https://local/api/catalog/manifest"), env, context)).json()).catalogId, "remote");
  const image = await worker.fetch(new Request("https://local/api/catalog/image?pack=shared.bin&offset=0&length=6"), env, context);
  assert.equal(await image.text(), "REMOTE");
  assert.ok(!image.headers.get("cache-control").includes("immutable"));
});

test("a rejected remote catalog cannot leak through a missing seed shard", async () => {
  const worker = await runtime();
  const env = envFor({ "face-catalog/manifest.json": JSON.stringify(manifest("unsafe", "2026-09-02", 10)), "face-catalog/shards/missing.json": "UNSAFE" }, { "/seed-catalog/manifest.json": JSON.stringify(manifest("seed", "2026-09-01")) });
  const response = await worker.fetch(new Request("https://local/api/catalog/shard?file=missing.json"), env, context);
  assert.equal(response.status, 404);
});

test("range bounds reject overflow, absent offset and truncated data", async () => {
  const worker = await runtime();
  const env = envFor({ "face-catalog/packs/a.bin": "abc" }, {});
  for (const query of ["offset=9007199254740991&length=2", "length=2"]) {
    assert.equal((await worker.fetch(new Request(`https://local/api/catalog/image?source=remote&pack=a.bin&${query}`), env, context)).status, 400);
  }
  assert.equal((await worker.fetch(new Request("https://local/api/catalog/image?source=remote&pack=a.bin&offset=1&length=4"), env, context)).status, 416);
});

test("chunked upload size is enforced before any bucket write", async () => {
  const worker = await runtime();
  const env = { ...envFor({}, {}), CATALOG_UPLOAD_KEY: "secret" };
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const request = new Request("https://local/api/catalog/upload?path=packs/a.bin", { method: "POST", headers: { "x-catalog-upload-key": "secret" }, body, duplex: "half" });
  assert.equal((await worker.fetch(request, env, context)).status, 413);
  assert.equal(env.BUCKET.values.size, 0);
});
