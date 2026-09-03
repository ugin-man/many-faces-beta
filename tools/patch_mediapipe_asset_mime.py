#!/usr/bin/env python3
"""Serve MediaPipe assets with deterministic MIME without same-origin recursion.

Cloudflare production exposes static files through env.ASSETS. Local vinext
preview may omit that binding. In local mode we call the already-imported vinext
app handler exactly once, then normalize the returned static response headers.
Calling global fetch() for the same URL would re-enter this Worker recursively.
"""

from pathlib import Path

PATH = Path("worker/index.ts")
text = PATH.read_text(encoding="utf-8")

old_routes = (
    '''    if (url.pathname.startsWith("/mediapipe/")) {
      return mediapipeAssetRead(request, env, url.pathname);
    }
''',
    '''    if (url.pathname.startsWith("/mediapipe/") && env?.ASSETS) {
      return mediapipeAssetRead(request, env, url.pathname);
    }
''',
)
new_route = '''    if (url.pathname.startsWith("/mediapipe/")) {
      return mediapipeAssetRead(
        request,
        env,
        url.pathname,
        () => handler.fetch(request, env, ctx),
      );
    }
'''

old_signatures = (
    '''async function mediapipeAssetRead(
  request: Request,
  env: Env | undefined,
  path: string,
) {''',
    '''async function mediapipeAssetRead(
  request: Request,
  env: Env | undefined,
  path: string,
  fallback?: () => Promise<Response>,
) {''',
)
new_signature = '''async function mediapipeAssetRead(
  request: Request,
  env: Env | undefined,
  path: string,
  fallback?: () => Promise<Response>,
) {'''

old_fetch_blocks = (
    '''  const response = await fetchBundledAsset(request, env, path);
  if (!response.ok || !response.body) return response;
''',
    '''  if (!env?.ASSETS) {
    return new Response("Not found", { status: 404 });
  }
  const assetRequest = new Request(new URL(path, request.url), {
    headers: request.headers,
  });
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok || !response.body) return response;
''',
)
new_fetch_block = '''  const assetRequest = new Request(new URL(path, request.url), {
    headers: request.headers,
  });
  const response = env?.ASSETS
    ? await env.ASSETS.fetch(assetRequest)
    : fallback
      ? await fallback()
      : new Response("Not found", { status: 404 });
  if (!response.ok || !response.body) return response;
'''

if "async function mediapipeAssetRead(" in text:
    changed = False
    for signature in old_signatures:
        if signature in text and signature != new_signature:
            text = text.replace(signature, new_signature, 1)
            changed = True
            break
    for block in old_fetch_blocks:
        if block in text:
            text = text.replace(block, new_fetch_block, 1)
            changed = True
            break
    for route in old_routes:
        if route in text:
            text = text.replace(route, new_route, 1)
            changed = True
            break
    if not changed:
        if new_signature in text and new_fetch_block in text and new_route in text:
            print("MediaPipe app-fallback MIME normalization already applied.")
            raise SystemExit(0)
        raise SystemExit("Existing MediaPipe route did not match a known form")
    PATH.write_text(text, encoding="utf-8")
    print("Repaired MediaPipe static fallback and MIME normalization.")
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
  fallback?: () => Promise<Response>,
) {
  if (!/^\\/mediapipe\\/[a-z0-9_.-]+$/i.test(path)) {
    return new Response("Not found", { status: 404 });
  }
  const assetRequest = new Request(new URL(path, request.url), {
    headers: request.headers,
  });
  const response = env?.ASSETS
    ? await env.ASSETS.fetch(assetRequest)
    : fallback
      ? await fallback()
      : new Response("Not found", { status: 404 });
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
print("Applied MediaPipe app-fallback MIME normalization.")
