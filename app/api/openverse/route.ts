type OpenverseResult = {
  id?: string;
  title?: string;
  creator?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  foreign_landing_url?: string;
  thumbnail?: string;
};

type CommonsValue = { value?: string };

type CommonsPage = {
  pageid?: number;
  title?: string;
  imageinfo?: Array<{
    thumburl?: string;
    url?: string;
    descriptionurl?: string;
    mime?: string;
    extmetadata?: Record<string, CommonsValue>;
  }>;
};

type Candidate = {
  id: string;
  title: string;
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 9_000;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function stripHtml(value = "") {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function imageAsDataUrl(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "image/avif,image/webp,image/jpeg,image/png,image/*",
      "User-Agent": "Many Faces Prototype/0.2 (Openverse client)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`image ${response.status}`);

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0];
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    throw new Error("unsupported image type");
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error("image too large");

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
}

async function hydrateCandidates(candidates: Candidate[], limit: number) {
  const hydrated: Array<Candidate & { dataUrl: string }> = [];
  for (let index = 0; index < candidates.length && hydrated.length < limit; index += 5) {
    const batch = candidates.slice(index, index + 5);
    const results = await Promise.allSettled(
      batch.map(async (candidate) => ({
        ...candidate,
        dataUrl: await imageAsDataUrl(candidate.imageUrl),
      })),
    );
    for (const result of results) {
      if (result.status === "fulfilled") hydrated.push(result.value);
      if (hydrated.length >= limit) break;
    }
  }
  return hydrated;
}

async function searchOpenverse(query: string, page: number, limit: number) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license", "by,by-sa,by-nc,by-nc-sa,cc0,pdm");
  url.searchParams.set("license_type", "modification");
  url.searchParams.set("category", "photograph");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(Math.min(50, limit * 2)));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Many Faces Prototype/0.2 (Openverse client)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Openverse ${response.status}`);

  const payload = (await response.json()) as { results?: OpenverseResult[] };
  const candidates: Candidate[] = (payload.results ?? []).flatMap((item) => {
    if (!item.id || !item.thumbnail || !item.foreign_landing_url) return [];
    const license = [item.license?.toUpperCase(), item.license_version]
      .filter(Boolean)
      .join(" ");
    return [
      {
        id: `openverse-${item.id}`,
        title: stripHtml(item.title) || "Untitled portrait",
        imageUrl: item.thumbnail,
        sourceName: "Openverse",
        sourceUrl: item.foreign_landing_url,
        creator: stripHtml(item.creator) || "Unknown creator",
        license: license || "CC0 / Public Domain",
        licenseUrl: item.license_url ?? item.foreign_landing_url,
      },
    ];
  });
  return hydrateCandidates(candidates, limit);
}

function isUsableLicense(value: string) {
  const license = value.toLowerCase();
  return (
    license.includes("cc0") ||
    license.includes("public domain") ||
    license === "pdm" ||
    license.startsWith("pd-") ||
    (license.includes("cc by") && !license.includes("-nd")) ||
    (license.includes("attribution") && !license.includes("no derivatives"))
  );
}

async function searchCommons(query: string, page: number, limit: number) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(Math.min(50, limit * 2)));
  url.searchParams.set("gsroffset", String((page - 1) * Math.min(50, limit * 2)));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "512");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Many Faces Prototype/0.2 (Wikimedia Commons client)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Commons ${response.status}`);

  const payload = (await response.json()) as { query?: { pages?: CommonsPage[] } };
  const candidates: Candidate[] = (payload.query?.pages ?? []).flatMap((pageItem) => {
    const info = pageItem.imageinfo?.[0];
    const metadata = info?.extmetadata ?? {};
    const license = stripHtml(metadata.LicenseShortName?.value);
    const imageUrl = info?.thumburl ?? info?.url;
    const sourceUrl = info?.descriptionurl;
    if (
      !pageItem.pageid ||
      !imageUrl ||
      !sourceUrl ||
      !info?.mime?.startsWith("image/") ||
      !isUsableLicense(license)
    ) {
      return [];
    }
    return [
      {
        id: `commons-${pageItem.pageid}`,
        title: stripHtml(metadata.ObjectName?.value) || pageItem.title?.replace(/^File:/, "") || "Untitled portrait",
        imageUrl,
        sourceName: "Wikimedia Commons",
        sourceUrl,
        creator: stripHtml(metadata.Artist?.value) || "Unknown creator",
        license: license || "Public Domain",
        licenseUrl: metadata.LicenseUrl?.value || sourceUrl,
      },
    ];
  });
  return hydrateCandidates(candidates, limit);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "portrait face").trim().slice(0, 100);
  const provider = params.get("provider");
  const limit = Math.max(1, Math.min(20, Number(params.get("limit") ?? 20) || 20));
  const page = Math.max(1, Math.min(50, Number(params.get("page") ?? 1) || 1));
  if (query.length < 2) return json({ error: "検索語を2文字以上入力してください。" }, 400);

  if (provider !== "commons") {
    try {
      const items = await searchOpenverse(query, page, limit);
      if (items.length) return json({ source: "Openverse", items });
    } catch (error) {
      console.warn("Openverse search failed; trying Commons when allowed.", error);
      if (provider === "openverse") {
        return json({ error: "Openverseへ接続できませんでした。探索を続けます。" }, 502);
      }
    }
  }

  if (provider === "openverse") {
    return json({ error: "Openverseに候補がありませんでした。" }, 404);
  }
  try {
    const items = await searchCommons(query, page, limit);
    if (items.length) return json({ source: "Wikimedia Commons", items });
    return json({ error: "改変利用できるCC・パブリックドメイン候補が見つかりませんでした。" }, 404);
  } catch (error) {
    console.error("Public image search failed.", error);
    return json({ error: "公開素材サービスへ接続できませんでした。少し待って再試行してください。" }, 502);
  }
}
