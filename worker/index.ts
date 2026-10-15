import { BodyLimitError, readBoundedBody, withDeadline } from "../app/runtime-io";
/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS?: Fetcher;
  BUCKET?: R2Bucket;
  DB?: D1Database;
  CATALOG_UPLOAD_KEY?: string;
  CATALOG_OWNER_EMAIL?: string;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

function canUploadCatalog(request: Request, env?: Env) {
  if (!env?.BUCKET || !env.CATALOG_UPLOAD_KEY?.trim()) return false;
  const supplied = request.headers.get("x-catalog-upload-key");
  return Boolean(supplied && supplied === env.CATALOG_UPLOAD_KEY);
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const CATALOG_PREFIX = "face-catalog/";
const MAX_CATALOG_OBJECT_BYTES = 8 * 1024 * 1024;
const CATALOG_PREFERENCE_CACHE_MS = 5_000;

function fetchBundledAsset(request: Request, env: Env | undefined, path: string, headers?: Headers) {
  const assetRequest = new Request(new URL(path, request.url), { headers });
  return env?.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);
}

function catalogJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function catalogContentType(path: string) {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".bin")) return "application/octet-stream";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "image/webp";
}

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
  const match = apiPath.match(/^\/api\/mediapipe\/([a-z0-9_.-]+)$/i);
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
  headers.set("cache-control", "public, no-cache");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCatalogUploadPath(path: string) {
  return (
    path === "manifest.json" ||
    /^index_[0-9]{3}\.json$/i.test(path) ||
    /^shards\/[a-z0-9_.+-]+\.json$/i.test(path) ||
    /^packs\/[a-z0-9_.-]+\.bin$/i.test(path) ||
    /^images\/[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i.test(path)
  );
}

function isCatalogExportPath(path: string) {
  return (
    path === "manifest.json" ||
    /^shards\/[a-z0-9_.+-]+\.json$/i.test(path) ||
    /^packs\/[a-z0-9_.-]+\.bin$/i.test(path)
  );
}

function isSeedCatalogPath(path: string) {
  return (
    path === "manifest.json" ||
    /^index_[0-9]{3}\.json$/i.test(path) ||
    /^shards\/[a-z0-9_.+-]+\.json$/i.test(path) ||
    /^packs\/[a-z0-9_.-]+\.bin$/i.test(path) ||
    /^images\/[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i.test(path)
  );
}

async function seedCatalogPackRange(
  request: Request,
  env: Env,
  pack: string,
  offset: number,
  length: number,
) {
  if (!isSeedCatalogPath(`packs/${pack}`)) {
    return catalogJson({ error: "Image pack not found" }, 404);
  }
  const headers = new Headers({ range: `bytes=${offset}-${offset + length - 1}` });
  const response = await fetchBundledAsset(
    request,
    env,
    `/seed-catalog/packs/${pack}`,
    headers,
  );
  if (!response.ok) return catalogJson({ error: "Image pack not found" }, 404);
  let body: BodyInit;
  if (response.status === 206) {
    const bytes = await withDeadline((signal) => readBoundedBody(response.body, length, signal));
    if (bytes.byteLength !== length) return catalogJson({ error: "Invalid image range" }, 416);
    body = bytes;
  } else {
    const source = new Uint8Array(await withDeadline((signal) => readBoundedBody(response.body, MAX_CATALOG_OBJECT_BYTES, signal)));
    if (offset + length > source.byteLength) {
      return catalogJson({ error: "Invalid image range" }, 416);
    }
    body = source.slice(offset, offset + length);
  }
  return new Response(body, {
    headers: {
      "cache-control": "private, no-cache",
      "content-length": String(length),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    },
  });
}

async function seedCatalogRead(
  request: Request,
  env: Env,
  path: string,
  immutable: boolean,
) {
  if (!isSeedCatalogPath(path)) return catalogJson({ error: "Catalog object not found" }, 404);
  const response = await fetchBundledAsset(request, env, `/seed-catalog/${path}`);
  if (!response.ok || !response.body) {
    return catalogJson({ error: "Catalog object not found" }, 404);
  }
  const headers = new Headers(response.headers);
  headers.set(
    "cache-control",
    immutable ? "private, no-cache" : "private, no-cache",
  );
  headers.set("content-type", catalogContentType(path));
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { headers });
}

type CatalogManifest = {
  schemaVersion?: number;
  catalogId?: string;
  generatedAt?: string;
  shapeVersion?: string;
  totalFaces?: number;
  indexFiles?: string[];
  shardsContainGeometry?: boolean;
  cells?: Record<string, { count?: number; shards?: string[] }>;
  stats?: {
    cleanCore?: {
      runtimeImagePolicy?: string;
      knownSyntheticFaces?: number;
    };
  };
};

type CatalogPreferenceCache = {
  expiresAt: number;
  remoteManifest: CatalogManifest | null;
};

const catalogPreferenceCaches = new WeakMap<Env, CatalogPreferenceCache>();

function isSearchableCatalog(payload: CatalogManifest) {
  return (
    payload.schemaVersion === 3 &&
    payload.shapeVersion === "mediapipe-projection-468-v4" &&
    Number.isFinite(payload.totalFaces) &&
    (
      (Array.isArray(payload.indexFiles) && payload.indexFiles.length > 0) ||
      (payload.shardsContainGeometry === true && payload.cells && Object.keys(payload.cells).length > 0)
    )
  );
}

function isRealPhotoOnlyCatalog(payload: CatalogManifest) {
  const cleanCore = payload.stats?.cleanCore;
  return (
    cleanCore?.runtimeImagePolicy === "real-photo-only-v1" &&
    Number(cleanCore.knownSyntheticFaces ?? -1) === 0
  );
}

type CatalogSource = "auto" | "seed" | "remote";

function requestedCatalogSource(url: URL): CatalogSource {
  const source = url.searchParams.get("source");
  return source === "seed" || source === "remote" ? source : "auto";
}

async function preferredRemoteManifest(request: Request, env?: Env) {
  if (!env?.BUCKET) return null;
  const now = Date.now();
  const catalogPreferenceCache = catalogPreferenceCaches.get(env);
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

  catalogPreferenceCaches.set(env, {
    expiresAt: now + CATALOG_PREFERENCE_CACHE_MS,
    remoteManifest: selected,
  });
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
        ? "private, no-cache"
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
  // A missing object is an error, not permission to mix another generation.
  return remote
    ? remoteCatalogRead(env, path, immutable)
    : seedCatalogRead(request, env as Env, path, immutable);
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
      : "public, no-cache",
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
        !Number.isSafeInteger(offset + length) ||
        !url.searchParams.has("offset") ||
        offset < 0 ||
        length < 1 ||
        length > 2 * 1024 * 1024
      ) {
        return catalogJson({ error: "Invalid image range" }, 400);
      }

      const useRemote = source === "remote" || (source === "auto" && Boolean(await preferredRemoteManifest(request, env)));
      if (!useRemote) return seedCatalogPackRange(request, env as Env, pack, offset, length);
      const remoteObject = await remotePackRange(env, pack, offset, length);
      if (!remoteObject) return catalogJson({ error: "Image pack not found" }, 404);
      const bytes = await withDeadline((signal) => readBoundedBody(new Response(remoteObject.body).body, length, signal));
      if (bytes.byteLength !== length) return catalogJson({ error: "Invalid image range" }, 416);

      return new Response(bytes, {
        headers: {
          "cache-control": "private, no-cache",
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
      const body = await withDeadline((signal) => readBoundedBody(request.body, MAX_CATALOG_OBJECT_BYTES, signal), request.signal, 20_000);
      if (!body.byteLength || body.byteLength > MAX_CATALOG_OBJECT_BYTES) {
        return catalogJson({ error: "Invalid object size" }, 413);
      }
      await env?.BUCKET?.put(`${CATALOG_PREFIX}${path}`, body, {
        httpMetadata: { contentType: catalogContentType(path) },
      });
      if (env) catalogPreferenceCaches.delete(env);
      return catalogJson({ ok: true, path, bytes: body.byteLength });
    }

    return catalogJson({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof BodyLimitError) return catalogJson({ error: "Object is too large" }, 413);
    if (error instanceof DOMException && error.name === "TimeoutError") return catalogJson({ error: "Request timed out" }, 408);
    console.error("Catalog request failed.", error);
    return catalogJson({ error: "Catalog is unavailable" }, 503);
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/mediapipe/")) {
      return mediapipeAssetRead(
        request,
        env,
        url.pathname,
        (assetRequest) => handler.fetch(assetRequest, env, ctx),
      );
    }

    if (url.pathname.startsWith("/api/catalog/")) {
      return handleCatalog(request, env, url);
    }

    if (url.pathname === "/_vinext/image") {
      const images = env.IMAGES;
      if (!images) return new Response("Image transformation is unavailable", { status: 503 });
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
          fetchAsset: (path) => {
            const assetRequest = new Request(new URL(path, request.url));
            return env.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);
          },
        transformImage: async (body, { width, format, quality }) => {
          const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
