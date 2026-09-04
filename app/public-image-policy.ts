import { BodyLimitError, readBoundedBody, throwIfAborted, withDeadline } from "./runtime-io.ts";

const EXACT_HOSTS = new Set(["api.openverse.org", "upload.wikimedia.org", "images.metmuseum.org", "datasets-server.huggingface.co", "huggingface.co"]);
const CDN_SUFFIXES = [".staticflickr.com", ".hf.co", ".huggingface.co"];
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export function safeHttpLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 4096) return undefined;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function isAllowedPublicImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      (EXACT_HOSTS.has(url.hostname) || CDN_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix)));
  } catch { return false; }
}

export function usableOpenverseLicense(code: string | undefined, licenseUrl: string | undefined): boolean {
  return Boolean(code && new Set(["by", "by-sa", "by-nc", "by-nc-sa", "cc0", "pdm"]).has(code.toLowerCase()) && safeHttpLink(licenseUrl));
}

/** Never follow an unchecked redirect or buffer an unbounded upstream image. */
export async function fetchPublicImageBytes(raw: string, signal?: AbortSignal, maxBytes = 2 * 1024 * 1024) {
  return withDeadline(async (deadline) => {
    let url = raw;
    for (let hop = 0; hop <= 3; hop++) {
      throwIfAborted(deadline);
      if (!isAllowedPublicImageUrl(url)) throw new Error("Unapproved image host");
      const response = await fetch(url, { redirect: "manual", signal: deadline, headers: { Accept: "image/jpeg,image/png,image/webp,image/avif,image/gif" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        void response.body?.cancel();
        if (!location) throw new Error("Image redirect has no destination");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { void response.body?.cancel(); throw new Error(`Image HTTP ${response.status}`); }
      const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(mime)) { void response.body?.cancel(); throw new Error("Unsupported image type"); }
      if (Number(response.headers.get("content-length")) > maxBytes) { void response.body?.cancel(); throw new BodyLimitError(); }
      const bytes = await readBoundedBody(response.body, maxBytes, deadline);
      return { bytes, mime };
    }
    throw new Error("Too many image redirects");
  }, signal, 9_000);
}
