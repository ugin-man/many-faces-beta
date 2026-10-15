/** Removed private recordings must not be recoverable through asset proxies. */
export function isRetiredAsset(path: string): boolean {
  try {
    const pathname = decodeURIComponent(new URL(path, "https://local.invalid").pathname);
    return pathname.startsWith("/test-fixtures/") || /(?:reference-face-motion|IMG_3665)/i.test(pathname);
  } catch {
    return true;
  }
}

export function retiredAssetResponse() {
  return new Response("This asset is no longer available.", {
    status: 410,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
