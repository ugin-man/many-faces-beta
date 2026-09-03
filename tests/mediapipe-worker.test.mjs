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
  const requestedPaths = [];
  return {
    requestedPaths,
    env: {
      ASSETS: {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          requestedPaths.push(pathname);
          const body = objects.get(pathname);
          if (body === undefined) return new Response("Not found", { status: 404 });
          // Deliberately return the wrong generic MIME. The API proxy must fix it.
          return new Response(body, { headers: { "content-type": "text/plain" } });
        },
      },
    },
  };
}

test("MediaPipe wasm API proxy maps to the bundled asset and is stream-compilable", async () => {
  const worker = await loadWorker("mediapipe-wasm-mime");
  const fixture = environment();
  const response = await worker.fetch(
    new Request("http://localhost/api/mediapipe/vision_wasm_internal.wasm"),
    fixture.env,
    context(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.requestedPaths, ["/mediapipe/vision_wasm_internal.wasm"]);
  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 97, 115, 109]);
});

test("MediaPipe API proxy gives JavaScript and model files explicit safe MIME types", async () => {
  const worker = await loadWorker("mediapipe-js-task-mime");
  const fixture = environment();
  const script = await worker.fetch(
    new Request("http://localhost/api/mediapipe/vision_wasm_internal.js"),
    fixture.env,
    context(),
  );
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");

  const model = await worker.fetch(
    new Request("http://localhost/api/mediapipe/face_landmarker.task"),
    fixture.env,
    context(),
  );
  assert.equal(model.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(fixture.requestedPaths, [
    "/mediapipe/vision_wasm_internal.js",
    "/mediapipe/face_landmarker.task",
  ]);
});

test("the MediaPipe proxy rejects nested and unexpected paths", async () => {
  const worker = await loadWorker("mediapipe-path-rejection");
  const fixture = environment();
  const response = await worker.fetch(
    new Request("http://localhost/api/mediapipe/nested/vision.wasm"),
    fixture.env,
    context(),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(fixture.requestedPaths, []);
});
