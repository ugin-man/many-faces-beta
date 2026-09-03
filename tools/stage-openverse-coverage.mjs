#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const NON_PHOTO_TITLE = /\b(statue|sculpture|figurine|painting|drawing|illustration|icon|mannequin|doll|coin|bust|relief|artwork|poster|engraving)\b/i;

export const CONFIGURATION_SEARCH_TERMS = {
  neutral: ["person portrait", "relaxed face"],
  winkLeft: ["person winking", "wink"],
  winkRight: ["person winking", "wink"],
  blink: ["eyes closed", "blinking"],
  eyesWide: ["wide eyes", "surprised face"],
  gazeUp: ["looking up", "eyes looking upward"],
  gazeDown: ["looking down", "eyes looking downward"],
  gazeLeft: ["looking sideways", "side glance"],
  gazeRight: ["looking sideways", "side glance"],
  browsUp: ["raised eyebrows", "surprised face"],
  browsDown: ["furrowed eyebrows", "serious frown"],
  smileClosed: ["closed mouth smile", "smiling person"],
  smileOpen: ["open mouth smile", "laughing person"],
  smileAsymmetric: ["smirk", "one sided smile"],
  frown: ["frowning person", "sad face"],
  mouthOpen: ["open mouth", "speaking person"],
  mouthRound: ["round mouth", "saying oh"],
  mouthWide: ["wide mouth", "stretched mouth"],
  pucker: ["pursed lips", "puckered lips"],
  mouthLeft: ["sideways mouth", "asymmetric mouth"],
  mouthRight: ["sideways mouth", "asymmetric mouth"],
  mouthPress: ["pressed lips", "tight lips"],
  mouthRoll: ["rolled lips", "biting lips"],
  mouthShrug: ["pouting face", "uncertain expression"],
  sneer: ["sneering person", "nose wrinkle"],
  jawLeft: ["sideways jaw", "grimacing person"],
  jawRight: ["sideways jaw", "grimacing person"],
  jawForward: ["jutting jaw", "grimacing person"],
};

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const plan = values.get("--plan");
  const output = values.get("--output");
  if (!plan || !output) {
    throw new Error(
      "Usage: stage-openverse-coverage.mjs --plan <coverage plan.json> --output <staging dir> " +
      "[--site <url>] [--direct true] [--provider openverse|commons] [--limit 1000] " +
      "[--pages 6] [--gaps 80] [--max-yaw 45] [--max-pitch 36] " +
      "[--min-pose-current 0] [--selection coverage|smoke] " +
      "[--configurations neutral,smileClosed] [--query-delay-ms 350] [--results-per-query 20]",
    );
  }
  const configurations = String(values.get("--configurations") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    plan: path.resolve(plan),
    output: path.resolve(output),
    site: (values.get("--site") ?? "https://many-faces-prototype.uginn-poppo.chatgpt.site").replace(/\/$/, ""),
    direct: String(values.get("--direct") ?? "false").toLowerCase() === "true",
    limit: Math.max(1, Number(values.get("--limit") ?? 1_000)),
    pages: Math.max(1, Math.min(50, Number(values.get("--pages") ?? 6))),
    gaps: Math.max(1, Number(values.get("--gaps") ?? 80)),
    maxYaw: Math.max(0, Math.min(45, Number(values.get("--max-yaw") ?? 45))),
    maxPitch: Math.max(0, Math.min(36, Number(values.get("--max-pitch") ?? 36))),
    minPoseCurrent: Math.max(0, Number(values.get("--min-pose-current") ?? 0)),
    selection: values.get("--selection") === "smoke" ? "smoke" : "coverage",
    configurations: configurations.length ? new Set(configurations) : null,
    queryDelayMs: Math.max(0, Number(values.get("--query-delay-ms") ?? 350)),
    resultsPerQuery: Math.max(1, Math.min(50, Number(values.get("--results-per-query") ?? 20))),
    provider: values.get("--provider") ?? "",
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(response, attempt) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(1_000, date - Date.now());
  }
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

async function fetchWithRetry(url, init, label, attempts = 5) {
  let latestError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response;
      latestError = new Error(`${label} ${response.status}`);
      if (attempt + 1 < attempts) await sleep(retryAfterMilliseconds(response, attempt));
    } catch (error) {
      latestError = error;
      if (attempt + 1 < attempts) await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw latestError;
}

function extensionForDataUrl(dataUrl) {
  const mime = dataUrl.match(/^data:([^;,]+)/)?.[1]?.toLowerCase() ?? "image/jpeg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("avif")) return ".avif";
  return ".jpg";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function usableLicense(value) {
  const license = String(value ?? "").toLowerCase();
  return (
    license.includes("cc0") ||
    license.includes("public domain") ||
    license === "pdm" ||
    license.startsWith("pd-") ||
    (license.includes("cc by") && !license.includes("-nd")) ||
    (license.includes("attribution") && !license.includes("no derivatives"))
  );
}

export function isLikelyPhotoCandidate(title, description = "") {
  return !NON_PHOTO_TITLE.test(`${stripHtml(title)} ${stripHtml(description)}`);
}

function smokeScore(item) {
  const poseEase = 100 - Math.abs(Number(item.yaw)) * 1.4 - Math.abs(Number(item.pitch)) * 1.6;
  return Number(item.poseCurrent ?? 0) * 0.04 + Number(item.pressure ?? 0) * 4 + poseEase;
}

export function selectDiverseGaps(items, limit, maxYaw, maxPitch, options = {}) {
  const allowed = options.configurations ?? null;
  const minimumPoseCount = Number(options.minPoseCurrent ?? 0);
  const eligible = items.filter((item) =>
    item.query &&
    item.recommendedAdditions > 0 &&
    Math.abs(Number(item.yaw)) <= maxYaw &&
    Math.abs(Number(item.pitch)) <= maxPitch &&
    Number(item.poseCurrent ?? 0) >= minimumPoseCount &&
    (!allowed || allowed.has(item.configuration)),
  );
  const groups = new Map();
  for (const item of eligible) {
    const group = groups.get(item.configuration) ?? [];
    group.push(item);
    groups.set(item.configuration, group);
  }
  if (options.selection === "smoke") {
    for (const group of groups.values()) {
      group.sort((left, right) => smokeScore(right) - smokeScore(left));
    }
  }
  const selected = [];
  let depth = 0;
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      if (group[depth]) {
        selected.push(group[depth]);
        added = true;
        if (selected.length >= limit) break;
      }
    }
    if (!added) break;
    depth += 1;
  }
  return selected;
}

function poseSearchTerm(gap) {
  const yaw = Math.abs(Number(gap.yaw));
  const pitch = Number(gap.pitch);
  const horizontal = yaw >= 27 ? "profile" : yaw >= 9 ? "three quarter view" : "front view";
  const vertical = pitch >= 18 ? "looking up" : pitch <= -18 ? "looking down" : "";
  return [horizontal, vertical].filter(Boolean).join(" ");
}

export function searchQueriesForGap(gap) {
  const terms = CONFIGURATION_SEARCH_TERMS[gap.configuration] ?? ["facial expression"];
  const pose = poseSearchTerm(gap);
  const queries = [
    `person ${terms[0]} ${pose} portrait`,
    `person ${terms[0]} portrait`,
    `human face ${pose} portrait`,
    terms[1] ? `person ${terms[1]} portrait` : "",
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

async function imageAsDataUrl(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: "image/avif,image/webp,image/jpeg,image/png,image/*",
      "User-Agent": "Many Faces Dataset Builder/0.4 (open source catalog research)",
    },
    signal: AbortSignal.timeout(20_000),
  }, "image");
  if (!response.ok) throw new Error(`image ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0];
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    throw new Error("unsupported image type");
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error("image too large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function hydrateDirectCandidates(candidates, limit) {
  const hydrated = [];
  for (let index = 0; index < candidates.length && hydrated.length < limit; index += 3) {
    const results = await Promise.allSettled(
      candidates.slice(index, index + 3).map(async (candidate) => ({
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

async function searchOpenverseDirect(query, page, limit = 20) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license", "by,by-sa,by-nc,by-nc-sa,cc0,pdm");
  url.searchParams.set("license_type", "modification");
  url.searchParams.set("category", "photograph");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(Math.min(50, limit * 2)));
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Many Faces Dataset Builder/0.4 (open source catalog research)",
    },
    signal: AbortSignal.timeout(20_000),
  }, "Openverse");
  if (!response.ok) throw new Error(`Openverse ${response.status}`);
  const payload = await response.json();
  const candidates = (payload.results ?? []).flatMap((item) => {
    if (!item.id || !item.thumbnail || !item.foreign_landing_url) return [];
    if (!isLikelyPhotoCandidate(item.title, item.description)) return [];
    const license = [item.license?.toUpperCase(), item.license_version]
      .filter(Boolean)
      .join(" ");
    return [{
      id: `openverse-${item.id}`,
      title: stripHtml(item.title) || "Untitled portrait",
      imageUrl: item.thumbnail,
      sourceName: "Openverse",
      sourceUrl: item.foreign_landing_url,
      creator: stripHtml(item.creator) || "Unknown creator",
      license: license || "CC0 / Public Domain",
      licenseUrl: item.license_url ?? item.foreign_landing_url,
    }];
  });
  return hydrateDirectCandidates(candidates, limit);
}

async function searchCommonsDirect(query, page, limit = 20) {
  const pageSize = Math.min(50, limit * 2);
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(pageSize));
  url.searchParams.set("gsroffset", String((page - 1) * pageSize));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "512");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");
  const response = await fetchWithRetry(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Many Faces Dataset Builder/0.4 (open source catalog research)",
    },
    signal: AbortSignal.timeout(20_000),
  }, "Wikimedia Commons");
  if (!response.ok) throw new Error(`Wikimedia Commons ${response.status}`);
  const payload = await response.json();
  const candidates = (payload.query?.pages ?? []).flatMap((pageItem) => {
    const info = pageItem.imageinfo?.[0];
    const metadata = info?.extmetadata ?? {};
    const license = stripHtml(metadata.LicenseShortName?.value);
    const imageUrl = info?.thumburl ?? info?.url;
    const sourceUrl = info?.descriptionurl;
    const title = stripHtml(metadata.ObjectName?.value) || pageItem.title?.replace(/^File:/, "") || "Untitled portrait";
    const description = stripHtml(metadata.ImageDescription?.value);
    if (
      !pageItem.pageid ||
      !imageUrl ||
      !sourceUrl ||
      !info?.mime?.startsWith("image/") ||
      !usableLicense(license) ||
      !isLikelyPhotoCandidate(title, description)
    ) return [];
    return [{
      id: `commons-${pageItem.pageid}`,
      title,
      imageUrl,
      sourceName: "Wikimedia Commons",
      sourceUrl,
      creator: stripHtml(metadata.Artist?.value) || "Unknown creator",
      license: license || "Public Domain",
      licenseUrl: metadata.LicenseUrl?.value || sourceUrl,
    }];
  });
  return hydrateDirectCandidates(candidates, limit);
}

async function searchDirect(query, page, provider, limit) {
  if (provider !== "commons") {
    try {
      return await searchOpenverseDirect(query, page, limit);
    } catch (error) {
      if (provider === "openverse") throw error;
      console.warn(`warning: ${error}; falling back to Wikimedia Commons`);
    }
  }
  return searchCommonsDirect(query, page, limit);
}

async function searchProxy(site, query, page, provider, limit) {
  const url = new URL("/api/openverse", site);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(Math.min(20, limit)));
  if (provider) url.searchParams.set("provider", provider);
  const response = await fetchWithRetry(url, { signal: AbortSignal.timeout(35_000) }, "site proxy");
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${query} page ${page}: ${response.status}`);
  return (await response.json()).items ?? [];
}

async function main() {
  const options = parseArgs(process.argv);
  const plan = JSON.parse(await readFile(options.plan, "utf8"));
  const queue = selectDiverseGaps(
    plan.collectionQueue ?? [],
    options.gaps,
    options.maxYaw,
    options.maxPitch,
    {
      configurations: options.configurations,
      minPoseCurrent: options.minPoseCurrent,
      selection: options.selection,
    },
  );
  if (!queue.length) throw new Error("Coverage plan contains no eligible collection queue");

  const imageDir = path.join(options.output, "images");
  await mkdir(imageDir, { recursive: true });
  const statePath = path.join(options.output, "state.json");
  let state = { ids: [], sourceUrls: [], rows: [] };
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // First run.
  }
  const ids = new Set(state.ids ?? []);
  const sourceUrls = new Set(state.sourceUrls ?? []);
  const rows = Array.isArray(state.rows) ? state.rows : [];
  if (rows.length >= options.limit) {
    console.log(JSON.stringify({ output: options.output, staged: rows.length, requested: options.limit, complete: true }, null, 2));
    return;
  }

  const cache = new Map();
  let requestCount = 0;
  const querySearch = async (query, page) => {
    const key = `${options.direct}:${options.provider}:${page}:${query}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        if (requestCount > 0 && options.queryDelayMs > 0) await sleep(options.queryDelayMs);
        requestCount += 1;
        return options.direct
          ? searchDirect(query, page, options.provider, options.resultsPerQuery)
          : searchProxy(options.site, query, page, options.provider, options.resultsPerQuery);
      })());
    }
    return cache.get(key);
  };

  outer:
  for (let page = 1; page <= options.pages; page += 1) {
    for (const gap of queue) {
      for (const query of searchQueriesForGap(gap)) {
        let items;
        try {
          items = await querySearch(query, page);
        } catch (error) {
          console.warn(`warning: ${error}`);
          continue;
        }
        let newlyStaged = 0;
        for (const item of items) {
          if (!item.id || !item.dataUrl || !item.sourceUrl || !item.license) continue;
          if (ids.has(item.id) || sourceUrls.has(item.sourceUrl)) continue;
          const extension = extensionForDataUrl(item.dataUrl);
          const filename = `${String(rows.length).padStart(7, "0")}-${item.id.replace(/[^a-zA-Z0-9_-]/g, "_")}${extension}`;
          const relativePath = `images/${filename}`;
          const payload = Buffer.from(item.dataUrl.slice(item.dataUrl.indexOf(",") + 1), "base64");
          await writeFile(path.join(options.output, relativePath), payload);
          rows.push({
            relative_path: relativePath,
            title: item.title ?? "Coverage candidate",
            source_name: item.sourceName ?? "Openverse",
            source_url: item.sourceUrl,
            creator: item.creator ?? "Unknown creator",
            license: item.license,
            license_url: item.licenseUrl ?? item.sourceUrl,
            target_pose: gap.pose,
            target_configuration: gap.configuration,
            target_query: query,
            target_pressure: gap.pressure,
          });
          ids.add(item.id);
          sourceUrls.add(item.sourceUrl);
          newlyStaged += 1;
          if (rows.length % 25 === 0) {
            process.stdout.write(`\rstaged ${rows.length}/${options.limit} unique licensed candidates`);
            await writeFile(statePath, JSON.stringify({ ids: [...ids], sourceUrls: [...sourceUrls], rows }, null, 2));
          }
          if (rows.length >= options.limit) break outer;
        }
        if (newlyStaged > 0) break;
      }
    }
  }
  process.stdout.write("\n");

  const columns = [
    "relative_path", "title", "source_name", "source_url", "creator", "license", "license_url",
    "target_pose", "target_configuration", "target_query", "target_pressure",
  ];
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
  await writeFile(path.join(options.output, "metadata.csv"), csv);
  await writeFile(statePath, JSON.stringify({ ids: [...ids], sourceUrls: [...sourceUrls], rows }, null, 2));
  console.log(JSON.stringify({
    output: options.output,
    mode: options.direct ? `direct-${options.provider || "auto"}` : "site-proxy",
    selection: options.selection,
    selectedGaps: queue.map(({ pose, configuration }) => ({ pose, configuration })),
    requests: requestCount,
    staged: rows.length,
    requested: options.limit,
    complete: rows.length >= options.limit,
    next: "Run tools/curate-coverage-candidates.py before adding any image to the catalog.",
  }, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
