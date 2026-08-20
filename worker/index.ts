/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS?: Fetcher;
  BUCKET: R2Bucket;
  DB: D1Database;
  CATALOG_UPLOAD_KEY?: string;
  CATALOG_OWNER_EMAIL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

function canUploadCatalog(request: Request, env: Env) {
  if (!env.CATALOG_UPLOAD_KEY) return true;
  const suppliedKey = request.headers.get("x-catalog-upload-key");
  if (suppliedKey && suppliedKey === env.CATALOG_UPLOAD_KEY) return true;
  const ownerEmail = env.CATALOG_OWNER_EMAIL?.trim().toLowerCase();
  const signedInEmail = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  return Boolean(ownerEmail && signedInEmail && ownerEmail === signedInEmail);
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const CATALOG_PREFIX = "face-catalog/";
const MAX_CATALOG_OBJECT_BYTES = 8 * 1024 * 1024;

function fetchBundledAsset(request: Request, env: Env, path: string, headers?: Headers) {
  const assetRequest = new Request(new URL(path, request.url), { headers });
  return env.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);
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
    path === "manifest.json" || /^index_[0-9]{3}\.json$/i.test(path) ||
    /^shards\/seed_[a-z0-9_.+-]+\.json$/i.test(path) ||
    /^packs\/seed_pack_[0-9]{3}\.bin$/i.test(path) ||
    /^images\/seed_ffhq_[0-9]{5}\.webp$/i.test(path)
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
    body = response.body as ReadableStream;
  } else {
    const source = new Uint8Array(await response.arrayBuffer());
    if (offset + length > source.byteLength) {
      return catalogJson({ error: "Invalid image range" }, 416);
    }
    body = source.slice(offset, offset + length);
  }
  return new Response(body, {
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
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
    immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
  );
  headers.set("content-type", catalogContentType(path));
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { headers });
}

async function catalogRead(
  request: Request,
  env: Env,
  path: string,
  immutable = false,
) {
  const object = await env.BUCKET.get(`${CATALOG_PREFIX}${path}`);
  if (!object) return seedCatalogRead(request, env, path, immutable);
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

type CatalogManifest = {
  schemaVersion?: number;
  shapeVersion?: string;
  totalFaces?: number;
  indexFiles?: string[];
  shardsContainGeometry?: boolean;
  cells?: Record<string, { count?: number; shards?: string[] }>;
};

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

async function preferredRemoteManifest(request: Request, env: Env) {
  const remoteObject = await env.BUCKET.get(`${CATALOG_PREFIX}manifest.json`);
  if (!remoteObject) return null;
  try {
    const remote = JSON.parse(await remoteObject.text()) as CatalogManifest;
    if (!isSearchableCatalog(remote)) return null;
    const seedResponse = await fetchBundledAsset(request, env, "/seed-catalog/manifest.json");
    if (!seedResponse.ok) return remote;
    const seed = await seedResponse.json() as CatalogManifest;
    return Number(remote.totalFaces ?? 0) >= Number(seed.totalFaces ?? 0) ? remote : null;
  } catch {
    return null;
  }
}

async function catalogManifestRead(request: Request, env: Env) {
  const remote = await preferredRemoteManifest(request, env);
  if (remote) return catalogJson(remote);
  return seedCatalogRead(request, env, "manifest.json", false);
}

async function catalogIndexRead(request: Request, env: Env, file: string) {
  if (!/^index_[0-9]{3}\.json$/i.test(file)) {
    return catalogJson({ error: "Invalid index" }, 400);
  }
  if (await preferredRemoteManifest(request, env)) return catalogRead(request, env, file, true);
  return seedCatalogRead(request, env, file, true);
}

async function catalogExportRead(request: Request, env: Env, path: string) {
  if (!isCatalogExportPath(path)) {
    return catalogJson({ error: "Invalid export path" }, 400);
  }
  const response = path === "manifest.json"
    ? await catalogManifestRead(request, env)
    : await catalogRead(request, env, path, true);
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

async function handleCatalog(request: Request, env: Env, url: URL) {
  try {
    if (request.method === "GET" && url.pathname === "/api/catalog/manifest") {
      return catalogManifestRead(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/shard") {
      const file = url.searchParams.get("file") ?? "";
      if (!/^[a-z0-9_.+-]+\.json$/i.test(file)) {
        return catalogJson({ error: "Invalid shard" }, 400);
      }
      return catalogRead(request, env, `shards/${file}`, true);
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/index") {
      return catalogIndexRead(request, env, url.searchParams.get("file") ?? "");
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/export") {
      return catalogExportRead(request, env, url.searchParams.get("path") ?? "");
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/image") {
      const id = url.searchParams.get("id") ?? "";
      if (/^[a-z0-9_.-]+\.(?:avif|jpe?g|png|webp)$/i.test(id)) {
        if (id.startsWith("seed_ffhq_")) {
          return seedCatalogRead(request, env, `images/${id}`, true);
        }
        return catalogRead(request, env, `images/${id}`, true);
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
      const object = await env.BUCKET.get(`${CATALOG_PREFIX}packs/${pack}`, {
        range: { offset, length },
      });
      if (!object) {
        return pack.startsWith("seed_pack_")
          ? seedCatalogPackRange(request, env, pack, offset, length)
          : catalogJson({ error: "Image pack not found" }, 404);
      }
      return new Response(object.body, {
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
      await env.BUCKET.put(`${CATALOG_PREFIX}${path}`, body, {
        httpMetadata: { contentType: catalogContentType(path) },
      });
      return catalogJson({ ok: true, path, bytes: body.byteLength });
    }

    return catalogJson({ error: "Method not allowed" }, 405);
  } catch (error) {
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

    if (url.pathname.startsWith("/api/catalog/")) {
      return handleCatalog(request, env, url);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
          fetchAsset: (path) => {
            const assetRequest = new Request(new URL(path, request.url));
            return env.ASSETS ? env.ASSETS.fetch(assetRequest) : fetch(assetRequest);
          },
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
