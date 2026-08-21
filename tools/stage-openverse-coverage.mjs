#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const plan = values.get("--plan");
  const output = values.get("--output");
  if (!plan || !output) {
    throw new Error(
      "Usage: stage-openverse-coverage.mjs --plan <coverage plan.json> --output <staging dir> " +
      "[--site <url>] [--limit 1000] [--pages 6] [--gaps 80]",
    );
  }
  return {
    plan: path.resolve(plan),
    output: path.resolve(output),
    site: (values.get("--site") ?? "https://many-faces-prototype.uginn-poppo.chatgpt.site").replace(/\/$/, ""),
    limit: Math.max(1, Number(values.get("--limit") ?? 1_000)),
    pages: Math.max(1, Math.min(50, Number(values.get("--pages") ?? 6))),
    gaps: Math.max(1, Number(values.get("--gaps") ?? 80)),
    provider: values.get("--provider") ?? "",
  };
}

async function retry(operation, attempts = 4) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      latest = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
      }
    }
  }
  throw latest;
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

async function search(site, query, page, provider) {
  const url = new URL("/api/openverse", site);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", "20");
  if (provider) url.searchParams.set("provider", provider);
  const response = await retry(() => fetch(url, { signal: AbortSignal.timeout(35_000) }));
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${query} page ${page}: ${response.status}`);
  return (await response.json()).items ?? [];
}

async function main() {
  const options = parseArgs(process.argv);
  const plan = JSON.parse(await readFile(options.plan, "utf8"));
  const queue = (plan.collectionQueue ?? [])
    .filter((item) => item.query && item.recommendedAdditions > 0)
    .slice(0, options.gaps);
  if (!queue.length) throw new Error("Coverage plan contains no collection queue");

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

  outer:
  for (let gapIndex = 0; gapIndex < queue.length; gapIndex += 1) {
    const gap = queue[gapIndex];
    for (let page = 1; page <= options.pages; page += 1) {
      let items;
      try {
        items = await search(options.site, gap.query, page, options.provider);
      } catch (error) {
        console.warn(`warning: ${error}`);
        continue;
      }
      for (const item of items) {
        if (!item.id || !item.dataUrl || !item.sourceUrl || !item.license) continue;
        if (ids.has(item.id) || sourceUrls.has(item.sourceUrl)) continue;
        const extension = extensionForDataUrl(item.dataUrl);
        const filename = `${String(rows.length).padStart(7, "0")}-${item.id.replace(/[^a-zA-Z0-9_-]/g, "_")}${extension}`;
        const relativePath = `images/${filename}`;
        const payload = Buffer.from(item.dataUrl.slice(item.dataUrl.indexOf(",") + 1), "base64");
        await writeFile(path.join(options.output, relativePath), payload);
        const row = {
          relative_path: relativePath,
          title: item.title ?? "Coverage candidate",
          source_name: item.sourceName ?? "Openverse",
          source_url: item.sourceUrl,
          creator: item.creator ?? "Unknown creator",
          license: item.license,
          license_url: item.licenseUrl ?? item.sourceUrl,
          target_pose: gap.pose,
          target_configuration: gap.configuration,
          target_query: gap.query,
          target_pressure: gap.pressure,
        };
        rows.push(row);
        ids.add(item.id);
        sourceUrls.add(item.sourceUrl);
        if (rows.length % 25 === 0) {
          process.stdout.write(`\rstaged ${rows.length}/${options.limit} unique licensed candidates`);
          await writeFile(statePath, JSON.stringify({ ids: [...ids], sourceUrls: [...sourceUrls], rows }, null, 2));
        }
        if (rows.length >= options.limit) break outer;
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
    staged: rows.length,
    requested: options.limit,
    complete: rows.length >= options.limit,
    next: "Run tools/curate-coverage-candidates.py before adding any image to the catalog.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
