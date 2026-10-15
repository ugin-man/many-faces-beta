import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedPublicImageUrl, usableOpenverseLicense, safeHttpLink, fetchPublicImageBytes } from "../app/public-image-policy.ts";

test("image fetch targets reject private addresses, credentials and host suffix tricks", () => {
  for (const url of ["http://upload.wikimedia.org/a.jpg", "https://127.0.0.1/a", "https://169.254.169.254/a", "https://api.openverse.org.evil.example/a", "https://user:pass@upload.wikimedia.org/a", "https://upload.wikimedia.org:8080/a"]) assert.equal(isAllowedPublicImageUrl(url), false, url);
  assert.equal(isAllowedPublicImageUrl("https://live.staticflickr.com/a.jpg"), true);
  assert.equal(safeHttpLink("javascript:alert(1)"), undefined);
});

test("missing permission metadata is not re-labelled public domain", () => {
  assert.equal(usableOpenverseLicense(undefined, "https://creativecommons.org"), false);
  assert.equal(usableOpenverseLicense("by-nd", "https://creativecommons.org"), false);
  assert.equal(usableOpenverseLicense("by", undefined), false);
  assert.equal(usableOpenverseLicense("by", "javascript:alert(1)"), false);
  assert.equal(usableOpenverseLicense("by", "https://creativecommons.org/licenses/by/2.0/"), true);
});

test("a redirect to an internal address is blocked before its request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/private" } }); };
  try { await assert.rejects(fetchPublicImageBytes("https://api.openverse.org/thumb"), /Unapproved image host/); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; }
});
