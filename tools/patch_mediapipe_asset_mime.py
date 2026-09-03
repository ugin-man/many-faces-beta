#!/usr/bin/env python3
"""Serve self-hosted MediaPipe assets with deterministic MIME and caching."""

from pathlib import Path

PATH = Path("worker/index.ts")
text = PATH.read_text(encoding="utf-8")

if "async function mediapipeAssetRead(" in text:
    print("MediaPipe asset MIME patch already applied.")
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
  if (!/^\/mediapipe\/[a-z0-9_.-]+$/i.test(path)) {
    return new Response("Not found", { status: 404 });
  }
  const response = await fetchBundledAsset(request, env, path);
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
route_replacement = '''    if (url.pathname.startsWith("/mediapipe/")) {
      return mediapipeAssetRead(request, env, url.pathname);
    }

''' + route
if route not in text:
    raise SystemExit("worker fetch route marker not found")
text = text.replace(route, route_replacement, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied MediaPipe asset MIME patch.")
