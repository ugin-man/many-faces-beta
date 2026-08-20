type DatasetRow = {
  row_idx?: number;
  row?: {
    image?:
      | string
      | {
          src?: string;
        };
  };
};

type FfhqCandidate = {
  id: string;
  title: string;
  imageUrl: string;
  sourceName: string;
  sourceUrl: string;
  creator: string;
  license: string;
  licenseUrl: string;
};

const DATASET_ID = "nuwandaa/ffhq128";
const DATASET_PAGE = "https://huggingface.co/datasets/nuwandaa/ffhq128";
const FFHQ_PAGE = "https://github.com/NVlabs/ffhq-dataset";
const FFHQ_LICENSE =
  "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt";
const DATASET_HOST = "datasets-server.huggingface.co";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 1024 * 1024;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}

function getImageUrl(row: DatasetRow) {
  const image = row.row?.image;
  if (typeof image === "string") return image;
  return image?.src;
}

function isAllowedImageUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === DATASET_HOST;
  } catch {
    return false;
  }
}

async function proxyImage(rawUrl: string) {
  if (!isAllowedImageUrl(rawUrl)) return json({ error: "Invalid image URL" }, 400);
  try {
    const response = await fetch(rawUrl, {
      headers: { Accept: "image/jpeg,image/png,image/webp,image/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`image ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0];
    if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
      throw new Error("unsupported image type");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
    return new Response(buffer, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("FFHQ image proxy failed.", error);
    return json({ error: "FFHQ image unavailable" }, 502);
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedImage = params.get("image");
  if (requestedImage) return proxyImage(requestedImage);
  const limit = Math.max(1, Math.min(60, Number(params.get("limit") ?? 60) || 60));
  const offset = Math.max(
    0,
    Math.min(69_999, Number(params.get("offset") ?? 0) || 0),
  );
  const fetchLength = Math.min(100, limit + 20, 70_000 - offset);

  const apiUrl = new URL(`https://${DATASET_HOST}/rows`);
  apiUrl.searchParams.set("dataset", DATASET_ID);
  apiUrl.searchParams.set("config", "default");
  apiUrl.searchParams.set("split", "train");
  apiUrl.searchParams.set("offset", String(offset));
  apiUrl.searchParams.set("length", String(fetchLength));

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Many Faces Prototype/0.3 (non-commercial FFHQ demo)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`FFHQ mirror ${response.status}`);

    const payload = (await response.json()) as {
      rows?: DatasetRow[];
      num_rows_total?: number;
    };
    const rows = payload.rows ?? [];
    const candidates: FfhqCandidate[] = rows.flatMap((row) => {
      const rowIndex = row.row_idx;
      const imageUrl = getImageUrl(row);
      if (rowIndex === undefined || !imageUrl || !isAllowedImageUrl(imageUrl)) return [];
      return [
        {
          id: `ffhq-${rowIndex}`,
          title: `FFHQ ${String(rowIndex).padStart(5, "0")}`,
          imageUrl,
          sourceName: "FFHQ",
          sourceUrl: DATASET_PAGE,
          creator: "NVIDIA FFHQ / Flickr photographers",
          license: "CC BY-NC-SA 4.0; per-image licenses vary",
          licenseUrl: FFHQ_LICENSE,
        },
      ];
    });
    // Signed image URLs are intentionally returned to the browser. Downloading and
    // base64-encoding 60 files inside one Worker request regularly exceeds the
    // hosted request window; the browser can stream and process them one at a time.
    const items = candidates.slice(0, limit);
    if (!items.length) throw new Error("FFHQ images unavailable");

    return json({
      source: "FFHQ 128",
      sourceUrl: FFHQ_PAGE,
      items,
      nextOffset: (offset + rows.length) % (payload.num_rows_total ?? 70_000),
      total: payload.num_rows_total ?? 70_000,
    });
  } catch (error) {
    console.error("FFHQ pack fetch failed.", error);
    return json(
      {
        error:
          "FFHQ素材パックへ接続できませんでした。少し待ってもう一度試してください。",
      },
      502,
    );
  }
}
