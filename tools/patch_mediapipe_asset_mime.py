#!/usr/bin/env python3
"""Proxy MediaPipe assets through an API path with deterministic MIME.

Static middleware can answer /mediapipe/* before the custom Worker sees the
request, especially under `vinext start`, which leaves WASM as
application/octet-stream.  The application therefore requests
/api/mediapipe/*; the Worker maps that path to the bundled /mediapipe/* asset,
then normalizes MIME and caching.  The local fallback calls the imported vinext
handler directly, never a recursive same-origin global fetch.
"""

from __future__ import annotations

import re
from pathlib import Path

WORKER_PATH = Path("worker/index.ts")
APP_PATH = Path("app/live/review-client-lite.tsx")

worker = WORKER_PATH.read_text(encoding="utf-8")
app = APP_PATH.read_text(encoding="utf-8")

app = app.replace('const WASM_URL = "/mediapipe";', 'const WASM_URL = "/api/mediapipe";')
app = app.replace(
    'const MODEL_URL = "/mediapipe/face_landmarker.task";',
    'const MODEL_URL = "/api/mediapipe/face_landmarker.task";',
)
if 'const WASM_URL = "/api/mediapipe";' not in app:
    raise SystemExit("Review client MediaPipe URL marker was not found")

content_type_marker = '''function catalogContentType(path: string) {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".bin")) return "application/octet-stream";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "image/webp";
}
'''

proxy_block = '''
function mediapipeContentType(path: string) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function mediapipeAssetRead(
  request: Request,
  env: Env | undefined,
  apiPath: string,
  fallback?: (assetRequest: Request) => Promise<Response>,
) {
  const match = apiPath.match(/^\\/api\\/mediapipe\\/([a-z0-9_.-]+)$/i);
  if (!match) return new Response("Not found", { status: 404 });

  const staticPath = `/mediapipe/${match[1]}`;
  const assetRequest = new Request(new URL(staticPath, request.url), {
    headers: request.headers,
  });
  const response = env?.ASSETS
    ? await env.ASSETS.fetch(assetRequest)
    : fallback
      ? await fallback(assetRequest)
      : new Response("Not found", { status: 404 });
  if (!response.ok || !response.body) return response;

  const headers = new Headers(response.headers);
  headers.set("content-type", mediapipeContentType(staticPath));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
'''

# Replace any earlier MediaPipe helper variant as a unit. Otherwise insert it
# immediately after catalogContentType.
helper_pattern = re.compile(
    r"\nfunction mediapipeContentType\(path: string\) \{.*?\n\}\n\nasync function mediapipeAssetRead\(.*?\n\}\n(?=\nfunction isCatalogUploadPath)",
    re.DOTALL,
)
if helper_pattern.search(worker):
    worker = helper_pattern.sub("\n" + proxy_block.rstrip() + "\n", worker, count=1)
elif content_type_marker in worker:
    worker = worker.replace(content_type_marker, content_type_marker + proxy_block, 1)
else:
    raise SystemExit("catalogContentType marker not found")

# Remove obsolete direct-static route variants. The API route below is the only
# supported entry point because static middleware may bypass the Worker.
worker = re.sub(
    r'''\n    if \(url\.pathname\.startsWith\("/mediapipe/"\)(?: && env\?\.ASSETS)?\) \{.*?\n    \}\n''',
    "\n",
    worker,
    flags=re.DOTALL,
)
worker = re.sub(
    r'''\n    if \(url\.pathname\.startsWith\("/api/mediapipe/"\)\) \{.*?\n    \}\n''',
    "\n",
    worker,
    flags=re.DOTALL,
)

catalog_route = '''    if (url.pathname.startsWith("/api/catalog/")) {
      return handleCatalog(request, env, url);
    }
'''
api_route = '''    if (url.pathname.startsWith("/api/mediapipe/")) {
      return mediapipeAssetRead(
        request,
        env,
        url.pathname,
        (assetRequest) => handler.fetch(assetRequest, env, ctx),
      );
    }

'''
if catalog_route not in worker:
    raise SystemExit("Worker catalog route marker not found")
worker = worker.replace(catalog_route, api_route + catalog_route, 1)

WORKER_PATH.write_text(worker, encoding="utf-8")
APP_PATH.write_text(app, encoding="utf-8")
print("Applied typed /api/mediapipe proxy and client URLs.")
