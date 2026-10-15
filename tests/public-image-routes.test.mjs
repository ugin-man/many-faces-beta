import assert from "node:assert/strict";
import test from "node:test";
import { GET as ffhq } from "../app/api/ffhq/route.ts";
import { GET as openverse } from "../app/api/openverse/route.ts";

test("the FFHQ proxy refuses credentialed and non-dataset URLs", async () => {
  for (const image of ["https://127.0.0.1/image", "https://user:pass@datasets-server.huggingface.co/image"]) {
    const response = await ffhq(new Request(`https://local/api/ffhq?image=${encodeURIComponent(image)}`));
    assert.equal(response.status, 400);
  }
});
test("Openverse ingestion rejects missing license metadata instead of inventing it", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ results: [{ id: "unsafe", thumbnail: "https://api.openverse.org/image", foreign_landing_url: "https://example.org/photo", creator: "Alice" }] }); };
  try {
    const response = await openverse(new Request("https://local/api/openverse?q=face&provider=openverse"));
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { globalThis.fetch = original; }
});
test("valid attributed Openverse images retain the existing response contract", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/v1/images/") ? Response.json({ results: [{ id: "valid", thumbnail: "https://api.openverse.org/thumbnail", foreign_landing_url: "https://example.org/photo", creator: "Alice", license: "by", license_version: "2.0", license_url: "https://creativecommons.org/licenses/by/2.0/" }] }) : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  try {
    const response = await openverse(new Request("https://local/api/openverse?q=face&provider=openverse&limit=1"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items[0].creator, "Alice");
    assert.equal(payload.items[0].license, "BY 2.0");
    assert.equal(payload.items[0].dataUrl, "data:image/jpeg;base64,AQID");
  } finally { globalThis.fetch = original; }
});
