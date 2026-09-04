import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedBody, withDeadline, fetchJson } from "../app/runtime-io.ts";

test("chunked bodies are capped while streaming, not after allocation", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(body, 10), { name: "BodyLimitError" });
  assert.equal(cancelled, true);
});

test("body read cancellation is prompt and preserves its cause", async () => {
  const controller = new AbortController();
  const pending = readBoundedBody(new ReadableStream(), 10, controller.signal);
  controller.abort(new DOMException("reset", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});

test("deadlines fail even when an operation does not settle", async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), undefined, 10), { name: "TimeoutError" });
});

test("JSON deadline covers a stalled body after successful headers", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream(), { headers: { "content-type": "application/json" } });
  try { await assert.rejects(fetchJson("http://localhost/slow", {}, 10), { name: "TimeoutError" }); }
  finally { globalThis.fetch = original; }
});
