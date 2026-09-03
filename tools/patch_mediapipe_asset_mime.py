#!/usr/bin/env python3
"""Serve bound MediaPipe assets with deterministic MIME without self-fetch loops.

Cloudflare production exposes static files through env.ASSETS. Local vinext
preview does not always provide that binding, so a Worker-side global fetch to
its own /mediapipe URL recursively re-enters the Worker and eventually returns
500. In that environment the route must fall through to vinext's native static
handler instead of intercepting itself.
"""

from pathlib import Path

PATH = Path("worker/index.ts")
text = PATH.read_text(encoding="utf-8")

old_route = '''    if (url.pathname.startsWith("/mediapipe/")) {
      return mediapipeAssetRead(request, env, url.pathname);
    }
'''
new_route = '''    if (url.pathname.startsWith("/mediapipe/") && env?.ASSETS) {
      return mediapipeAssetRead(request, env, url.pathname);
    }
'''

old_read = '''  const response = await fetchBundledAsset(request, env, path);
  if (!response.ok || !response.body) return response;
'''
new_read = '''  if (!env?.ASSETS) {
    return new Response("Not found", { status: 404 });
  }
  const assetRequest = new Request(new URL(path, request.url), {
    headers: request.headers,
  });
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok || !response.body) return response;
'''

if "async function mediapipeAssetRead(" in text:
    changed = False
    if old_read in text:
        text = text.replace(old_read, new_read, 1)
        changed = True
    if old_route in text:
        text = text.replace(old_route, new_route, 1)
        changed = True
    if not changed:
        if new_read in text and new_route in text:
            print("Non-recursive MediaPipe asset route already applied.")
            raise SystemExit(0)
        raise SystemExit("Existing MediaPipe route did not match a known form")
    PATH.write_text(text, encoding="utf-8")
    print("Repaired recursive MediaPipe asset route.")
    raise SystemExit(0)

marker = '''function catalogContentType(path: string) {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".bin")) return "application/octet-stream";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "image/webp";
}
'''
addition = marker + '''
function mediapipeContentType(path: string) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function mediapipeAssetRead(
  request: Request,
  env: Env | undefined,
  path: string,
) {
  if (!/^\\/mediapipe\\/[a-z0-9_.-]+$/i.test(path)) {
    return new Response("Not found", { status: 404 });
  }
  if (!env?.ASSETS) {
    return new Response("Not found", { status: 404 });
  }
  const assetRequest = new Request(new URL(path, request.url), {
    headers: request.headers,
  });
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", mediapipeContentType(path));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
'''
if marker not in text:
    raise SystemExit("catalogContentType marker not found")
text = text.replace(marker, addition, 1)

route = '''    if (url.pathname.startsWith("/api/catalog/")) {
      return handleCatalog(request, env, url);
    }
'''
route_replacement = new_route + "\n" + route
if route not in text:
    raise SystemExit("worker fetch route marker not found")
text = text.replace(route, route_replacement, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied non-recursive MediaPipe asset MIME route.")
