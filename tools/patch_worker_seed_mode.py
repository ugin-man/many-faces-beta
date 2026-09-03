#!/usr/bin/env python3
"""Make catalog delivery safe in local/serverless preview and explicit seed mode.

The production Worker receives bindings, but `vinext start` can invoke the same
entry point with `env` undefined. The previous implementation dereferenced
`env.BUCKET` before serving the bundled seed, turning `/api/catalog/manifest`
into a permanent 500 and leaving the review UI waiting forever.
"""

from __future__ import annotations

from pathlib import Path

PATH = Path("worker/index.ts")
text = PATH.read_text(encoding="utf-8")

# The branch can already contain the fully patched runtime because a successful
# verification workflow commits it back. Re-running the old replacement over
# that source used to duplicate CatalogSource/requestedCatalogSource and break
# the next build. Treat the complete marker set as an idempotent success.
if all(
    marker in text
    for marker in (
        'type CatalogSource = "auto" | "seed" | "remote";',
        "async function catalogRead(",
        "async function catalogManifestRead(",
        "const source = requestedCatalogSource(url);",
        "env: Env | undefined",
        "if (!env?.BUCKET) return null;",
    )
):
    print("Explicit seed/local catalog runtime already applied.")
    raise SystemExit(0)

text = text.replace("  BUCKET: R2Bucket;", "  BUCKET?: R2Bucket;", 1)
text = text.replace("  DB: D1Database;", "  DB?: D1Database;", 1)
text = text.replace("  IMAGES: {", "  IMAGES?: {", 1)
text = text.replace(
    "function canUploadCatalog(request: Request, env: Env) {\n  if (!env.CATALOG_UPLOAD_KEY) return true;",
    "function canUploadCatalog(request: Request, env?: Env) {\n  if (!env?.BUCKET) return false;\n  if (!env.CATALOG_UPLOAD_KEY) return true;",
    1,
)
text = text.replace(
    "function fetchBundledAsset(request: Request, env: Env, path: string, headers?: Headers) {\n  const assetRequest = new Request(new URL(path, request.url), { headers });\n  return env.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);\n}",
    "function fetchBundledAsset(request: Request, env: Env | undefined, path: string, headers?: Headers) {\n  const assetRequest = new Request(new URL(path, request.url), { headers });\n  return env?.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);\n}",
    1,
)

start = text.find("async function preferredRemoteManifest(")
end = text.find("\n// Image security config.", start)
if start < 0 or end < 0:
    raise SystemExit("Catalog runtime section markers were not found")

replacement = r'''type CatalogSource = "auto" | "seed" | "remote";

function requestedCatalogSource(url: URL): CatalogSource {
  const source = url.searchParams.get("source");
  return source === "seed" || source === "remote" ? source : "auto";
}

async function preferredRemoteManifest(request: Request, env?: Env) {
  if (!env?.BUCKET) return null;
  const now = Date.now();
  if (catalogPreferenceCache && catalogPreferenceCache.expiresAt > now) {
    return catalogPreferenceCache.remoteManifest;
  }

  let selected: CatalogManifest | null = null;
  const remoteObject = await env.BUCKET.get(`${CATALOG_PREFIX}manifest.json`);
  if (remoteObject) {
    try {
      const remote = JSON.parse(await remoteObject.text()) as CatalogManifest;
      if (isSearchableCatalog(remote) && isRealPhotoOnlyCatalog(remote)) {
        const seedResponse = await fetchBundledAsset(
          request,
          env,
          "/seed-catalog/manifest.json",
        );
        if (!seedResponse.ok) {
          selected = remote;
        } else {
          const seed = await seedResponse.json() as CatalogManifest;
          if (!isSearchableCatalog(seed) || !isRealPhotoOnlyCatalog(seed)) {
            selected = remote;
          } else {
            const remoteFaces = Number(remote.totalFaces ?? 0);
            const seedFaces = Number(seed.totalFaces ?? 0);
            if (remoteFaces > seedFaces) {
              selected = remote;
            } else if (remoteFaces === seedFaces) {
              const remoteGeneratedAt = Date.parse(remote.generatedAt ?? "");
              const seedGeneratedAt = Date.parse(seed.generatedAt ?? "");
              if (
                Number.isFinite(remoteGeneratedAt) &&
                Number.isFinite(seedGeneratedAt) &&
                remoteGeneratedAt > seedGeneratedAt
              ) {
                selected = remote;
              }
            }
          }
        }
      }
    } catch {
      selected = null;
    }
  }

  catalogPreferenceCache = {
    expiresAt: now + CATALOG_PREFERENCE_CACHE_MS,
    remoteManifest: selected,
  };
  return selected;
}

function remoteCatalogResponse(
  object: { body: ReadableStream },
  path: string,
  immutable: boolean,
) {
  return new Response(object.body, {
    headers: {
      "cache-control": immutable
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
      "content-type": catalogContentType(path),
      "x-content-type-options": "nosniff",
    },
  });
}

async function remoteCatalogRead(
  env: Env | undefined,
  path: string,
  immutable = false,
) {
  if (!env?.BUCKET) {
    return catalogJson({ error: "Remote catalog is unavailable" }, 404);
  }
  const object = await env.BUCKET.get(`${CATALOG_PREFIX}${path}`);
  return object
    ? remoteCatalogResponse(object, path, immutable)
    : catalogJson({ error: "Catalog object not found" }, 404);
}

async function catalogRead(
  request: Request,
  env: Env | undefined,
  path: string,
  immutable = false,
  source: CatalogSource = "auto",
) {
  if (source === "seed") {
    return seedCatalogRead(request, env as Env, path, immutable);
  }
  if (source === "remote") {
    return remoteCatalogRead(env, path, immutable);
  }

  const remote = await preferredRemoteManifest(request, env);
  if (!remote) {
    const seed = await seedCatalogRead(request, env as Env, path, immutable);
    if (seed.ok || !env?.BUCKET) return seed;
    const stagedObject = await env.BUCKET.get(`${CATALOG_PREFIX}${path}`);
    return stagedObject
      ? remoteCatalogResponse(stagedObject, path, immutable)
      : seed;
  }
  const object = await env?.BUCKET?.get(`${CATALOG_PREFIX}${path}`);
  if (!object) return seedCatalogRead(request, env as Env, path, immutable);
  return remoteCatalogResponse(object, path, immutable);
}

async function catalogManifestRead(
  request: Request,
  env: Env | undefined,
  source: CatalogSource = "auto",
) {
  if (source === "seed") {
    return seedCatalogRead(request, env as Env, "manifest.json", false);
  }
  if (source === "remote") {
    return remoteCatalogRead(env, "manifest.json", false);
  }
  const remote = await preferredRemoteManifest(request, env);
  if (remote) return catalogJson(remote);
  return seedCatalogRead(request, env as Env, "manifest.json", false);
}

async function catalogIndexRead(
  request: Request,
  env: Env | undefined,
  file: string,
  source: CatalogSource,
) {
  if (!/^index_[0-9]{3}\.json$/i.test(file)) {
    return catalogJson({ error: "Invalid index" }, 400);
  }
  return catalogRead(request, env, file, true, source);
}

async function catalogExportRead(
  request: Request,
  env: Env | undefined,
  path: string,
  source: CatalogSource,
) {
  if (!isCatalogExportPath(path)) {
    return catalogJson({ error: "Invalid export path" }, 400);
  }
  const response = path === "manifest.json"
    ? await catalogManifestRead(request, env, source)
    : await catalogRead(request, env, path, true, source);
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    path === "manifest.json"
      ? "public, no-cache"
      : "public, max-age=31536000, immutable",
  );
  headers.set("content-type", catalogContentType(path));
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

async function remotePackRange(
  env: Env | undefined,
  pack: string,
  offset: number,
  length: number,
) {
  if (!env?.BUCKET) return null;
  return env.BUCKET.get(`${CATALOG_PREFIX}packs/${pack}`, {
    range: { offset, length },
  });
}

async function handleCatalog(request: Request, env: Env | undefined, url: URL) {
  try {
    const source = requestedCatalogSource(url);

    if (request.method === "GET" && url.pathname === "/api/catalog/manifest") {
      return catalogManifestRead(request, env, source);
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/shard") {
      const file = url.searchParams.get("file") ?? "";
      if (!/^[a-z0-9_.+-]+\.json$/i.test(file)) {
        return catalogJson({ error: "Invalid shard" }, 400);
      }
      return catalogRead(request, env, `shards/${file}`, true, source);
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/index") {
      return catalogIndexRead(
        request,
        env,
        url.searchParams.get("file") ?? "",
        source,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/export") {
      return catalogExportRead(
        request,
        env,
        url.searchParams.get("path") ?? "",
        source,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/image") {
      const id = url.searchParams.get("id") ?? "";
      if (/^[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i.test(id)) {
        return catalogRead(request, env, `images/${id}`, true, source);
      }
      const pack = url.searchParams.get("pack") ?? "";
      const offset = Number(url.searchParams.get("offset"));
      const length = Number(url.searchParams.get("length"));
      if (
        !/^[a-z0-9_.-]+\.bin$/i.test(pack) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > 2 * 1024 * 1024
      ) {
        return catalogJson({ error: "Invalid image range" }, 400);
      }

      if (source !== "remote") {
        const seed = await seedCatalogPackRange(
          request,
          env as Env,
          pack,
          offset,
          length,
        );
        if (seed.ok || source === "seed" || !env?.BUCKET) return seed;
      }

      const remoteObject = await remotePackRange(env, pack, offset, length);
      if (!remoteObject) {
        return source === "remote"
          ? catalogJson({ error: "Image pack not found" }, 404)
          : seedCatalogPackRange(request, env as Env, pack, offset, length);
      }
      return new Response(remoteObject.body, {
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": String(length),
          "content-type": "image/webp",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/catalog/upload") {
      if (!canUploadCatalog(request, env)) {
        return catalogJson({ error: "Catalog upload is restricted" }, 403);
      }
      const path = url.searchParams.get("path") ?? "";
      if (!isCatalogUploadPath(path)) {
        return catalogJson({ error: "Invalid path" }, 400);
      }
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_CATALOG_OBJECT_BYTES) {
        return catalogJson({ error: "Object is too large" }, 413);
      }
      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_CATALOG_OBJECT_BYTES) {
        return catalogJson({ error: "Invalid object size" }, 413);
      }
      await env?.BUCKET?.put(`${CATALOG_PREFIX}${path}`, body, {
        httpMetadata: { contentType: catalogContentType(path) },
      });
      catalogPreferenceCache = null;
      return catalogJson({ ok: true, path, bytes: body.byteLength });
    }

    return catalogJson({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("Catalog request failed.", error);
    return catalogJson({ error: "Catalog is unavailable" }, 503);
  }
}
'''

text = text[:start] + replacement + text[end:]
PATH.write_text(text, encoding="utf-8")
print("Applied explicit seed/local catalog runtime patch.")
