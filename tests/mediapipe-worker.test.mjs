import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker(label) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(label, `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

function context() {
  return { waitUntil() {}, passThroughOnException() {} };
}

function environment() {
  const objects = new Map([
    ["/mediapipe/vision_wasm_internal.wasm", new Uint8Array([0, 97, 115, 109])],
    ["/mediapipe/vision_wasm_internal.js", "self.Module = {};"],
    ["/mediapipe/face_landmarker.task", new Uint8Array([1, 2, 3, 4])],
  ]);
  return {
    ASSETS: {
      async fetch(request) {
        const body = objects.get(new URL(request.url).pathname);
        if (body === undefined) return new Response("Not found", { status: 404 });
        // Deliberately return the wrong generic MIME. The Worker must correct it.
        return new Response(body, { headers: { "content-type": "text/plain" } });
      },
    },
  };
}

test("MediaPipe wasm is stream-compilable and immutable", async () => {
  const worker = await loadWorker("mediapipe-wasm-mime");
  const response = await worker.fetch(
    new Request("http://localhost/mediapipe/vision_wasm_internal.wasm"),
    environment(),
    context(),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 97, 115, 109]);
});

test("MediaPipe JavaScript and model files receive explicit safe MIME types", async () => {
  const worker = await loadWorker("mediapipe-js-task-mime");
  const env = environment();
  const script = await worker.fetch(
    new Request("http://localhost/mediapipe/vision_wasm_internal.js"),
    env,
    context(),
  );
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");

  const model = await worker.fetch(
    new Request("http://localhost/mediapipe/face_landmarker.task"),
    env,
    context(),
  );
  assert.equal(model.headers.get("content-type"), "application/octet-stream");
});
