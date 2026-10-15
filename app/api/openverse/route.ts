import { fetchJson, throwIfAborted, withDeadline } from "../../runtime-io.ts";
import { fetchPublicImageBytes, isAllowedPublicImageUrl, safeHttpLink, usableOpenverseLicense } from "../../public-image-policy.ts";

type OpenverseResult = { id?: string; title?: string; creator?: string; license?: string; license_version?: string; license_url?: string; foreign_landing_url?: string; thumbnail?: string };
type CommonsPage = { pageid?: number; title?: string; imageinfo?: Array<{ thumburl?: string; url?: string; descriptionurl?: string; mime?: string; extmetadata?: Record<string, { value?: string }> }> };
type Candidate = { id: string; title: string; imageUrl: string; sourceName: string; sourceUrl: string; creator: string; license: string; licenseUrl: string };
type Hydrated = Candidate & { dataUrl: string };
type Budget = { attempts: number; retainedBytes: number };
const MAX_RETAINED_BYTES = 12 * 1024 * 1024;

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": status === 200 ? "private, max-age=300" : "no-store", "x-content-type-options": "nosniff" } });
}
function text(value = "") {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 2000);
}
function base64(bytes: ArrayBuffer) {
  const array = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < array.length; i += 0x8000) binary += String.fromCharCode(...array.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function hydrate(candidates: Candidate[], limit: number, signal: AbortSignal, budget: Budget): Promise<Hydrated[]> {
  const output: Hydrated[] = [];
  for (let i = 0; i < candidates.length && output.length < limit && budget.attempts > 0; i += 4) {
    throwIfAborted(signal);
    const batch = candidates.slice(i, i + Math.min(4, budget.attempts));
    budget.attempts -= batch.length;
    const results = await Promise.allSettled(batch.map(async (candidate) => ({ candidate, ...await fetchPublicImageBytes(candidate.imageUrl, signal) })));
    throwIfAborted(signal);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { candidate, bytes, mime } = result.value;
      if (budget.retainedBytes + bytes.byteLength > MAX_RETAINED_BYTES) continue;
      budget.retainedBytes += bytes.byteLength;
      output.push({ ...candidate, dataUrl: `data:${mime};base64,${base64(bytes)}` });
      if (output.length >= limit) break;
    }
  }
  return output;
}
async function openverse(query: string, page: number, limit: number, signal: AbortSignal) {
  const url = new URL("https://api.openverse.org/v1/images/");
  for (const [key, value] of Object.entries({ q: query, license: "by,by-sa,by-nc,by-nc-sa,cc0,pdm", license_type: "modification", category: "photograph", mature: "false", page: String(page), page_size: String(Math.min(40, limit * 2)) })) url.searchParams.set(key, value);
  const payload = await fetchJson<{ results?: OpenverseResult[] }>(url, { signal, redirect: "error" }, 9_000, 2 * 1024 * 1024);
  return (Array.isArray(payload.results) ? payload.results : []).flatMap<Candidate>((item) => {
    const sourceUrl = safeHttpLink(item.foreign_landing_url);
    const licenseUrl = safeHttpLink(item.license_url);
    const creator = text(item.creator);
    if (!item.id || !item.thumbnail || !isAllowedPublicImageUrl(item.thumbnail) || !sourceUrl || !licenseUrl || !creator || !usableOpenverseLicense(item.license, licenseUrl)) return [];
    return [{ id: `openverse-${item.id}`, title: text(item.title) || "Untitled portrait", imageUrl: item.thumbnail, sourceName: "Openverse", sourceUrl, creator, license: [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(" "), licenseUrl }];
  });
}
async function commons(query: string, page: number, limit: number, signal: AbortSignal) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({ action: "query", generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: String(Math.min(40, limit * 2)), gsroffset: String((page - 1) * Math.min(40, limit * 2)), prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: "512", format: "json", formatversion: "2", origin: "*" })) url.searchParams.set(key, value);
  const payload = await fetchJson<{ query?: { pages?: CommonsPage[] } }>(url, { signal, redirect: "error" }, 9_000, 2 * 1024 * 1024);
  return (Array.isArray(payload.query?.pages) ? payload.query.pages : []).flatMap<Candidate>((item) => {
    const info = item.imageinfo?.[0];
    const metadata = info?.extmetadata ?? {};
    const license = text(metadata.LicenseShortName?.value);
    const normalized = license.toLowerCase();
    const permitted = /^(cc0|public domain|pdm|pd-)/.test(normalized) || (/^cc by(?:-sa|-nc|-nc-sa)?(?:\s|$)/.test(normalized) && !normalized.includes("-nd"));
    const imageUrl = info?.thumburl ?? info?.url;
    const sourceUrl = safeHttpLink(info?.descriptionurl);
    const creator = text(metadata.Artist?.value);
    // Some public-domain Commons records state the permission on the landing page.
    const licenseUrl = safeHttpLink(metadata.LicenseUrl?.value) || sourceUrl;
    if (!item.pageid || !imageUrl || !isAllowedPublicImageUrl(imageUrl) || !sourceUrl || !creator || !licenseUrl || !info?.mime?.startsWith("image/") || !permitted) return [];
    return [{ id: `commons-${item.pageid}`, title: text(metadata.ObjectName?.value) || text(item.title?.replace(/^File:/, "")) || "Untitled portrait", imageUrl, sourceName: "Wikimedia Commons", sourceUrl, creator, license, licenseUrl }];
  });
}
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "portrait face").trim().slice(0, 100);
  const provider = params.get("provider");
  const limit = Math.max(1, Math.min(20, Math.floor(Number(params.get("limit")) || 20)));
  const page = Math.max(1, Math.min(50, Math.floor(Number(params.get("page")) || 1)));
  if (query.length < 2) return json({ error: "検索語を2文字以上入力してください。" }, 400);
  try {
    return await withDeadline(async (signal) => {
      const budget: Budget = { attempts: 24, retainedBytes: 0 };
      if (provider !== "commons") {
        try {
          const items = await hydrate(await openverse(query, page, limit, signal), limit, signal, budget);
          if (items.length) return json({ source: "Openverse", items });
        } catch {
          throwIfAborted(signal);
          if (provider === "openverse") return json({ error: "Openverseへ接続できませんでした。" }, 502);
        }
      }
      if (provider === "openverse") return json({ error: "出典と利用条件を確認できる候補がありませんでした。" }, 404);
      const items = await hydrate(await commons(query, page, limit, signal), limit, signal, budget);
      return items.length ? json({ source: "Wikimedia Commons", items }) : json({ error: "出典と利用条件を確認できる候補がありませんでした。" }, 404);
    }, request.signal, 25_000);
  } catch {
    return json({ error: "公開素材サービスへ接続できませんでした。少し待って再試行してください。" }, 502);
  }
}
