#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const QUERIES = {
  winkLeft: ["person winking portrait", "one eye closed portrait", "wink face portrait"],
  winkRight: ["person winking portrait", "one eye closed portrait", "wink face portrait"],
  blink: ["eyes closed portrait person", "closed eyes face portrait"],
  eyesWide: ["wide eyes portrait closed mouth", "surprised eyes portrait"],
  gazeUp: ["eyes looking up portrait", "upward glance portrait"],
  gazeDown: ["eyes looking down portrait", "downward glance portrait"],
  gazeLeft: ["side glance portrait", "eyes looking sideways portrait"],
  gazeRight: ["side glance portrait", "eyes looking sideways portrait"],
  browsUp: ["raised eyebrows portrait closed mouth", "eyebrows raised face"],
  browsDown: ["furrowed eyebrows portrait closed mouth", "lowered brows portrait"],
  noseSneer: ["nose wrinkle portrait", "sneer closed mouth portrait"],
  mouthRound: ["round mouth portrait", "saying oh portrait"],
  mouthPucker: ["pursed lips portrait", "puckered lips portrait"],
  mouthWide: ["wide stretched mouth portrait"],
  mouthPress: ["pressed lips portrait", "tight lips portrait"],
  mouthRoll: ["rolled lips portrait"],
  mouthLeft: ["asymmetric mouth portrait", "mouth pulled sideways portrait"],
  mouthRight: ["asymmetric mouth portrait", "mouth pulled sideways portrait"],
  mouthFrown: ["frowning mouth portrait closed eyes open"],
  mouthShrug: ["pouting mouth portrait", "uncertain expression portrait"],
  mouthUpperUp: ["upper lip raised portrait"],
  mouthLowerDown: ["lower lip down portrait"],
  cheekPuff: ["puffed cheeks portrait"],
};
const NON_PHOTO = /\b(statue|sculpture|painting|drawing|illustration|cartoon|comic|doll|figurine|poster|engraving|artwork)\b/i;
const MAX_BYTES = 3 * 1024 * 1024;

function args() {
  const map = new Map();
  for (let i = 2; i < process.argv.length; i += 2) map.set(process.argv[i], process.argv[i + 1]);
  const output = map.get("--output");
  if (!output) throw new Error("--output is required");
  const profiles = String(map.get("--profiles") ?? Object.keys(QUERIES).join(",")).split(",").map(v => v.trim()).filter(Boolean);
  return {
    output: path.resolve(output),
    provider: map.get("--provider") ?? "openverse",
    profiles,
    pages: Math.max(1, Math.min(20, Number(map.get("--pages") ?? 6))),
    perPage: Math.max(10, Math.min(50, Number(map.get("--per-page") ?? 40))),
    maxImages: Math.max(1, Number(map.get("--max-images") ?? 6000)),
  };
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function clean(value = "") { return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
async function fetchRetry(url, init = {}, attempts = 5) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
      if (response.ok) return response;
      last = new Error(`${response.status} ${url}`);
      if (![429,500,502,503,504].includes(response.status)) break;
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, Math.min(20000, 1200 * 2 ** attempt)));
  }
  throw last;
}
async function imageBytes(url) {
  const response = await fetchRetry(url, { headers: { Accept: "image/jpeg,image/png,image/webp,image/*", "User-Agent": "Many Faces Clean Core Builder/2" } });
  const type = (response.headers.get("content-type") ?? "").split(";")[0];
  if (!type.startsWith("image/") || type.includes("svg")) throw new Error("unsupported image");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("image too large");
  return { bytes, type };
}
function extension(type) { return type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg"; }

async function searchOpenverse(query, page, perPage) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query); url.searchParams.set("category", "photograph");
  url.searchParams.set("mature", "false"); url.searchParams.set("license_type", "modification");
  url.searchParams.set("license", "by,by-sa,by-nc,by-nc-sa,cc0,pdm");
  url.searchParams.set("page", String(page)); url.searchParams.set("page_size", String(perPage));
  const response = await fetchRetry(url, { headers: { Accept: "application/json", "User-Agent": "Many Faces Clean Core Builder/2" } });
  const payload = await response.json();
  return (payload.results ?? []).flatMap(item => {
    const title = clean(item.title), description = clean(item.description);
    if (!item.id || !item.thumbnail || !item.foreign_landing_url || NON_PHOTO.test(`${title} ${description}`)) return [];
    return [{
      id: `openverse-${item.id}`, title: title || "Targeted portrait", imageUrl: item.thumbnail,
      source_name: "Openverse", source_url: item.foreign_landing_url,
      creator: clean(item.creator) || "Unknown creator",
      license: [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(" ") || "CC0 / PDM",
      license_url: item.license_url || item.foreign_landing_url,
    }];
  });
}

async function searchCommons(query, page, perPage) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query"); url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`); url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(perPage)); url.searchParams.set("gsroffset", String((page-1)*perPage));
  url.searchParams.set("prop", "imageinfo"); url.searchParams.set("iiprop", "url|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "768"); url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2"); url.searchParams.set("origin", "*");
  const response = await fetchRetry(url, { headers: { Accept: "application/json", "User-Agent": "Many Faces Clean Core Builder/2" } });
  const payload = await response.json();
  return (payload.query?.pages ?? []).flatMap(item => {
    const info = item.imageinfo?.[0], meta = info?.extmetadata ?? {};
    const title = clean(meta.ObjectName?.value || item.title), description = clean(meta.ImageDescription?.value);
    const license = clean(meta.LicenseShortName?.value || meta.UsageTerms?.value);
    if (!info?.thumburl || !info?.descriptionurl || NON_PHOTO.test(`${title} ${description}`)) return [];
    if (/no.?deriv|fair use|copyrighted/i.test(license)) return [];
    return [{
      id: `commons-${item.pageid}`, title: title || "Targeted portrait", imageUrl: info.thumburl,
      source_name: "Wikimedia Commons", source_url: info.descriptionurl,
      creator: clean(meta.Artist?.value) || "Unknown creator", license: license || "Public domain / CC",
      license_url: clean(meta.LicenseUrl?.value) || info.descriptionurl,
    }];
  });
}

async function main() {
  const options = args();
  await mkdir(path.join(options.output, "images"), { recursive: true });
  const seen = new Set(), rows = [], failures = {};
  for (const profile of options.profiles) {
    const queries = QUERIES[profile] ?? [`${profile} portrait`];
    for (const query of queries) {
      for (let page = 1; page <= options.pages && rows.length < options.maxImages; page += 1) {
        let results = [];
        try {
          results = options.provider === "commons" ? await searchCommons(query, page, options.perPage) : await searchOpenverse(query, page, options.perPage);
        } catch (error) {
          failures[`search:${profile}`] = (failures[`search:${profile}`] ?? 0) + 1;
          continue;
        }
        for (const item of results) {
          if (rows.length >= options.maxImages) break;
          const key = `${item.source_url}|${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const image = await imageBytes(item.imageUrl);
            const filename = `${String(rows.length).padStart(7,"0")}-${item.id}${extension(image.type)}`;
            await writeFile(path.join(options.output, "images", filename), image.bytes);
            rows.push({
              relative_path: `images/${filename}`, title: item.title,
              source_name: item.source_name, source_url: item.source_url, creator: item.creator,
              license: item.license, license_url: item.license_url,
              target_pose: "", target_configuration: profile, target_query: query, target_pressure: "",
              open_images_id: "", open_images_split: "", open_images_annotation_source: "",
              open_images_annotation_license: "", box_xmin: "", box_xmax: "", box_ymin: "", box_ymax: "",
              original_url: item.imageUrl, author_profile_url: "",
            });
          } catch (error) {
            const name = `image:${profile}`; failures[name] = (failures[name] ?? 0) + 1;
          }
        }
      }
    }
  }
  const columns = ["relative_path","title","source_name","source_url","creator","license","license_url","target_pose","target_configuration","target_query","target_pressure","open_images_id","open_images_split","open_images_annotation_source","open_images_annotation_license","box_xmin","box_xmax","box_ymin","box_ymax","original_url","author_profile_url"];
  const output = [columns.join(","), ...rows.map(row => columns.map(key => csv(row[key])).join(","))].join("\n") + "\n";
  await writeFile(path.join(options.output, "metadata.csv"), output);
  await writeFile(path.join(options.output, "source-report.json"), JSON.stringify({ provider: options.provider, profiles: options.profiles, staged: rows.length, failures }, null, 2));
  console.log(JSON.stringify({ provider: options.provider, staged: rows.length, failures }, null, 2));
  if (!rows.length) process.exitCode = 1;
}

await main();
