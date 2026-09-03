#!/usr/bin/env node

/**
 * Stage openly licensed real photographs for weak Clean Core v3 profiles.
 *
 * Search terms are hints only. Every downloaded image must later pass the
 * MediaPipe single-factor curator. This stage deliberately excludes known CG,
 * illustration and synthetic-human markers before any image reaches runtime.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const QUERIES = {
  winkLeft: [
    "winking man portrait closed mouth photograph",
    "winking woman portrait closed mouth photograph",
    "person winking selfie closed mouth",
    "one eye closed portrait neutral mouth",
    "wink close up face photograph",
    "winking person serious portrait",
  ],
  winkRight: [
    "winking man portrait closed mouth photograph",
    "winking woman portrait closed mouth photograph",
    "person winking selfie closed mouth",
    "one eye closed portrait neutral mouth",
    "wink close up face photograph",
    "winking person serious portrait",
  ],
  eyesWide: [
    "wide eyed man portrait closed mouth photograph",
    "wide eyed woman portrait closed mouth photograph",
    "astonished eyes portrait mouth closed",
    "surprised eyes close up portrait photograph",
    "person eyes wide open neutral mouth photograph",
  ],
  noseSneer: [
    "sneering person portrait photograph",
    "wrinkled nose portrait photograph",
    "disgusted face close up photograph",
    "upper lip raised disgust portrait photograph",
    "snarling person portrait photograph",
  ],
  mouthRound: [
    "round lips portrait photograph",
    "person saying oh portrait photograph",
    "whistling person close up portrait",
    "o shaped mouth portrait photograph",
    "blowing air lips portrait photograph",
  ],
  mouthSlightOpen: [
    "slightly open mouth portrait neutral eyes photograph",
    "parted lips portrait photograph",
    "person lips slightly parted portrait",
    "neutral portrait mouth slightly open photograph",
  ],
  mouthOpen: [
    "open mouth portrait neutral eyes not smiling photograph",
    "person saying ah portrait photograph",
    "open mouth close up face neutral expression",
  ],
  smileOpen: [
    "open mouth smile portrait photograph",
    "smiling person teeth portrait photograph",
    "happy open smile close up photograph",
  ],
  mouthWide: [
    "stretched mouth portrait photograph",
    "wide mouth grimace portrait photograph",
    "person grimacing mouth wide photograph",
    "horizontal mouth stretch portrait photograph",
  ],
  mouthFrown: [
    "downturned mouth portrait photograph",
    "sad frown face closed mouth photograph",
    "frowning lips portrait neutral eyes photograph",
    "person mouth corners down portrait photograph",
  ],
  mouthUpperUp: [
    "upper lip raised portrait photograph",
    "disgusted expression upper lip portrait photograph",
    "snarl face portrait photograph",
  ],
  mouthLowerDown: [
    "lower lip pulled down portrait photograph",
    "sad lower lip portrait photograph",
    "pout lower lip face close up photograph",
  ],
  mouthLeft: [
    "crooked mouth portrait photograph",
    "mouth pulled sideways portrait photograph",
    "one sided mouth grimace portrait photograph",
  ],
  mouthRight: [
    "crooked mouth portrait photograph",
    "mouth pulled sideways portrait photograph",
    "one sided mouth grimace portrait photograph",
  ],
};

const NON_PHOTO = /\b(?:3d|3-d|render(?:ed|ing)?|cgi|computer[- ]generated|synthetic|virtual human|metahuman|avatar|video game|game character|statue|sculpture|painting|drawing|illustration|illustrated|cartoon|comic|anime|manga|doll|figurine|poster|engraving|artwork|digital art|concept art|wax figure|mannequin)\b/i;
const UNSAFE_LICENSE = /\b(?:no derivatives|no-deriv|nd|fair use|copyrighted|all rights reserved)\b/i;
const ALLOWED_LICENSE = /(?:public domain|\bpdm\b|\bcc0\b|cc by(?:-sa)?\b|creative commons attribution(?:-share alike)?)/i;
const MAX_BYTES = 4 * 1024 * 1024;

function parseArgs() {
  const map = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    map.set(process.argv[index], process.argv[index + 1]);
  }
  const output = map.get("--output");
  if (!output) throw new Error("--output is required");
  const profiles = String(map.get("--profiles") ?? Object.keys(QUERIES).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const profile of profiles) {
    if (!QUERIES[profile]) throw new Error(`unsupported profile: ${profile}`);
  }
  return {
    output: path.resolve(output),
    provider: map.get("--provider") ?? "openverse",
    profiles,
    pages: Math.max(1, Math.min(20, Number(map.get("--pages") ?? 8))),
    perPage: Math.max(10, Math.min(50, Number(map.get("--per-page") ?? 50))),
    maxImages: Math.max(1, Number(map.get("--max-images") ?? 4000)),
  };
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function clean(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(tags) {
  if (!Array.isArray(tags)) return "";
  return tags
    .map((tag) => (typeof tag === "string" ? tag : tag?.name ?? ""))
    .filter(Boolean)
    .join(" ");
}

async function fetchRetry(url, init = {}, attempts = 5) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return response;
      last = new Error(`${response.status} ${url}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 1500 * 2 ** attempt)));
  }
  throw last;
}

async function imageBytes(url) {
  const response = await fetchRetry(url, {
    headers: {
      Accept: "image/jpeg,image/png,image/webp,image/*",
      "User-Agent": "Many Faces real-photo collector/3",
    },
  });
  const type = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  if (!type.startsWith("image/") || type.includes("svg") || type.includes("gif")) {
    throw new Error(`unsupported image type: ${type}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("invalid image size");
  return { bytes, type };
}

function extension(type) {
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  return ".jpg";
}

async function searchOpenverse(query, page, perPage) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("category", "photograph");
  url.searchParams.set("mature", "false");
  url.searchParams.set("license_type", "modification");
  url.searchParams.set("license", "by,by-sa,cc0,pdm");
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(perPage));
  const response = await fetchRetry(url, {
    headers: { Accept: "application/json", "User-Agent": "Many Faces real-photo collector/3" },
  });
  const payload = await response.json();
  return (payload.results ?? []).flatMap((item) => {
    const title = clean(item.title);
    const description = clean(item.description);
    const tags = clean(tagText(item.tags));
    const category = clean(item.category).toLowerCase();
    const combined = `${title} ${description} ${tags} ${category}`;
    if (category && category !== "photograph") return [];
    if (!item.id || !item.thumbnail || !item.foreign_landing_url || NON_PHOTO.test(combined)) return [];
    const license = [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(" ") || "CC0 / PDM";
    if (UNSAFE_LICENSE.test(license) || !ALLOWED_LICENSE.test(license)) return [];
    return [{
      id: `openverse-${item.id}`,
      title: title || "Targeted real-person portrait",
      imageUrl: item.thumbnail,
      source_name: "Openverse photograph",
      source_url: item.foreign_landing_url,
      creator: clean(item.creator) || "Unknown creator",
      creator_url: clean(item.creator_url),
      license,
      license_url: item.license_url || item.foreign_landing_url,
      provider: clean(item.provider),
      source: clean(item.source),
      category: category || "photograph",
    }];
  });
}

async function searchCommons(query, page, perPage) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(perPage));
  url.searchParams.set("gsroffset", String((page - 1) * perPage));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "900");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");
  const response = await fetchRetry(url, {
    headers: { Accept: "application/json", "User-Agent": "Many Faces real-photo collector/3" },
  });
  const payload = await response.json();
  return (payload.query?.pages ?? []).flatMap((item) => {
    const info = item.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const title = clean(meta.ObjectName?.value || item.title);
    const description = clean(meta.ImageDescription?.value);
    const categories = clean(meta.Categories?.value);
    const combined = `${title} ${description} ${categories}`;
    const license = clean(meta.LicenseShortName?.value || meta.UsageTerms?.value);
    if (!info?.thumburl || !info?.descriptionurl || NON_PHOTO.test(combined)) return [];
    if (UNSAFE_LICENSE.test(license) || !ALLOWED_LICENSE.test(license)) return [];
    return [{
      id: `commons-${item.pageid}`,
      title: title || "Targeted real-person portrait",
      imageUrl: info.thumburl,
      source_name: "Wikimedia Commons photograph",
      source_url: info.descriptionurl,
      creator: clean(meta.Artist?.value) || "Unknown creator",
      creator_url: "",
      license,
      license_url: clean(meta.LicenseUrl?.value) || info.descriptionurl,
      provider: "Wikimedia Commons",
      source: "commons",
      category: "photograph",
    }];
  });
}

async function main() {
  const options = parseArgs();
  if (!new Set(["openverse", "commons"]).has(options.provider)) {
    throw new Error(`unsupported provider: ${options.provider}`);
  }
  await mkdir(path.join(options.output, "images"), { recursive: true });
  const seen = new Set();
  const rows = [];
  const failures = {};
  const stagedByProfile = {};

  for (const profile of options.profiles) {
    for (const query of QUERIES[profile]) {
      for (let page = 1; page <= options.pages && rows.length < options.maxImages; page += 1) {
        let results = [];
        try {
          results = options.provider === "commons"
            ? await searchCommons(query, page, options.perPage)
            : await searchOpenverse(query, page, options.perPage);
        } catch (error) {
          const key = `search:${profile}:${error?.name ?? "Error"}`;
          failures[key] = (failures[key] ?? 0) + 1;
          continue;
        }
        for (const item of results) {
          if (rows.length >= options.maxImages) break;
          const key = `${item.source_url}|${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const image = await imageBytes(item.imageUrl);
            const filename = `${String(rows.length).padStart(7, "0")}-${item.id}${extension(image.type)}`;
            await writeFile(path.join(options.output, "images", filename), image.bytes);
            rows.push({
              relative_path: `images/${filename}`,
              title: item.title,
              source_name: item.source_name,
              source_url: item.source_url,
              creator: item.creator,
              creator_url: item.creator_url,
              license: item.license,
              license_url: item.license_url,
              target_pose: "",
              target_configuration: profile,
              target_query: query,
              target_pressure: "",
              source_kind: "real-photo-targeted",
              provider: item.provider,
              source_collection: item.source,
              media_category: item.category,
              original_url: item.imageUrl,
              author_profile_url: item.creator_url,
            });
            stagedByProfile[profile] = (stagedByProfile[profile] ?? 0) + 1;
          } catch (error) {
            const name = `image:${profile}:${error?.name ?? "Error"}`;
            failures[name] = (failures[name] ?? 0) + 1;
          }
        }
      }
    }
  }

  const columns = [
    "relative_path", "title", "source_name", "source_url", "creator", "creator_url",
    "license", "license_url", "target_pose", "target_configuration", "target_query",
    "target_pressure", "source_kind", "provider", "source_collection", "media_category",
    "original_url", "author_profile_url",
  ];
  const metadata = [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csv(row[key])).join(",")),
  ].join("\n") + "\n";
  await writeFile(path.join(options.output, "metadata.csv"), metadata);
  const report = {
    schemaVersion: 1,
    provider: options.provider,
    profiles: options.profiles,
    pages: options.pages,
    perPage: options.perPage,
    staged: rows.length,
    stagedByProfile,
    failures,
    runtimeImagePolicy: "real-photo-only-v1",
    allowedLicenses: ["CC BY", "CC BY-SA", "CC0", "Public Domain Mark"],
  };
  await writeFile(path.join(options.output, "source-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!rows.length) process.exitCode = 1;
}

await main();
