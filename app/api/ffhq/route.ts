import { fetchJson } from "../../runtime-io.ts";
import { fetchPublicImageBytes, isAllowedPublicImageUrl } from "../../public-image-policy.ts";

type DatasetRow = { row_idx?: number; row?: { image?: string | { src?: string } } };
const DATASET_HOST = "datasets-server.huggingface.co";
const FFHQ_PAGE = "https://github.com/NVlabs/ffhq-dataset";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: {
    "cache-control": status === 200 ? "private, max-age=60" : "no-store",
    "x-content-type-options": "nosniff",
  } });
}
function isDatasetImage(raw: string) {
  try { return isAllowedPublicImageUrl(raw) && new URL(raw).hostname === DATASET_HOST; }
  catch { return false; }
}
function integer(raw: string | null, fallback: number, min: number, max: number) {
  const value = raw === null ? fallback : Number(raw);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : fallback));
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const image = params.get("image");
  if (image) {
    if (!isDatasetImage(image)) return json({ error: "Invalid image URL" }, 400);
    try {
      const { bytes, mime } = await fetchPublicImageBytes(image, request.signal, 1024 * 1024);
      return new Response(bytes, { headers: {
        "content-type": mime, "cache-control": "private, max-age=600", "x-content-type-options": "nosniff",
      } });
    } catch {
      return json({ error: "FFHQ image unavailable" }, 502);
    }
  }
  const limit = integer(params.get("limit"), 60, 1, 60);
  const offset = integer(params.get("offset"), 0, 0, 69_999);
  const url = new URL(`https://${DATASET_HOST}/rows`);
  for (const [key, value] of Object.entries({ dataset: "nuwandaa/ffhq128", config: "default", split: "train", offset: String(offset), length: String(Math.min(100, limit + 20, 70_000 - offset)) })) url.searchParams.set(key, value);
  try {
    const payload = await fetchJson<{ rows?: DatasetRow[]; num_rows_total?: number }>(url, {
      signal: request.signal, redirect: "error", headers: { Accept: "application/json" },
    }, 10_000, 2 * 1024 * 1024);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const items = rows.flatMap((row) => {
      const source = row.row?.image;
      const imageUrl = typeof source === "string" ? source : source?.src;
      if (!Number.isSafeInteger(row.row_idx) || !imageUrl || !isDatasetImage(imageUrl)) return [];
      return [{
        id: `ffhq-${row.row_idx}`, title: `FFHQ ${String(row.row_idx).padStart(5, "0")}`, imageUrl,
        sourceName: "FFHQ", sourceUrl: "https://huggingface.co/datasets/nuwandaa/ffhq128",
        creator: "NVIDIA FFHQ / Flickr photographers",
        license: "CC BY-NC-SA 4.0; per-image licenses vary",
        licenseUrl: `${FFHQ_PAGE}/blob/master/LICENSE.txt`,
      }];
    }).slice(0, limit);
    if (!items.length) return json({ error: "FFHQ images unavailable" }, 502);
    const total = Number.isSafeInteger(payload.num_rows_total) && Number(payload.num_rows_total) > 0 ? Number(payload.num_rows_total) : 70_000;
    // Signed URLs stay in the response; the input video is never sent here.
    return json({ source: "FFHQ 128", sourceUrl: FFHQ_PAGE, items, nextOffset: (offset + rows.length) % total, total });
  } catch {
    return json({ error: "FFHQ素材パックへ接続できませんでした。少し待ってもう一度試してください。" }, 502);
  }
}
