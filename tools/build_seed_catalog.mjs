#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const execFile = promisify(execFileCallback);

const TARGET_FACES = 5_000;
const FALLBACK_SCAN_LIMIT = 70_000;
const POSE_STEP = 3;
const YAW_MIN = -30;
const YAW_MAX = 30;
const PITCH_MIN = -24;
const PITCH_MAX = 24;
const EXPECTED_POSE_CELLS =
  ((YAW_MAX - YAW_MIN) / POSE_STEP + 1) *
  ((PITCH_MAX - PITCH_MIN) / POSE_STEP + 1);
const OUTPUT_SIZE = 256;
const PACK_TARGET_BYTES = 2 * 1024 * 1024;
const DATASET_HOST = "datasets-server.huggingface.co";
const DATASET_PAGE = "https://huggingface.co/datasets/nuwandaa/ffhq128";
const FEATURES_PAGE = "https://github.com/DCGM/ffhq-features-dataset";
const FFHQ_PAGE = "https://github.com/NVlabs/ffhq-dataset";
const LICENSE_URL =
  "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt";

function parseArgs() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  const features = values.get("--features");
  const metadata = values.get("--metadata");
  const output = values.get("--output");
  if (!features || !metadata || !output) {
    throw new Error(
      "Usage: build_seed_catalog.mjs --features <json dir> --metadata <ffhq json> --output <seed-catalog dir>",
    );
  }
  const resolvedOutput = path.resolve(output);
  if (path.basename(resolvedOutput) !== "seed-catalog") {
    throw new Error("Output directory must be named seed-catalog");
  }
  return {
    features: path.resolve(features),
    metadata: path.resolve(metadata),
    output: resolvedOutput,
    archive: values.get("--archive") ? path.resolve(values.get("--archive")) : null,
  };
}

function poseCell(headPose) {
  const yaw = Math.round(Number(headPose?.yaw ?? 999) / POSE_STEP) * POSE_STEP;
  const pitch = Math.round(Number(headPose?.pitch ?? 999) / POSE_STEP) * POSE_STEP;
  if (yaw < YAW_MIN || yaw > YAW_MAX || pitch < PITCH_MIN || pitch > PITCH_MAX) {
    return null;
  }
  return { key: `${yaw}:${pitch}`, yaw, pitch };
}

function candidateQuality(attributes) {
  const blur = Number(attributes.blur?.value ?? 1);
  const noise = Number(attributes.noise?.value ?? 1);
  const exposure = attributes.exposure?.exposureLevel === "goodExposure" ? 0 : 1;
  const occlusion = attributes.occlusion ?? {};
  const occlusionPenalty = [
    occlusion.foreheadOccluded,
    occlusion.eyeOccluded,
    occlusion.mouthOccluded,
  ].filter(Boolean).length;
  const faceArea = Number(attributes.faceRectangle?.width ?? 0) * Number(attributes.faceRectangle?.height ?? 0);
  return blur * 3 + noise * 1.5 + exposure * 2 + occlusionPenalty * 4 - faceArea / 50_000;
}

function expressionClass(attributes) {
  const emotion = attributes.emotion ?? {};
  const smile = Math.max(Number(attributes.smile ?? 0), Number(emotion.happiness ?? 0));
  if (Math.max(Number(emotion.surprise ?? 0), Number(emotion.fear ?? 0) * 0.7) >= 0.25) {
    return "surprise";
  }
  if (
    Math.max(
      Number(emotion.sadness ?? 0),
      Number(emotion.anger ?? 0),
      Number(emotion.disgust ?? 0),
    ) >= 0.25
  ) {
    return "frown";
  }
  if (smile >= 0.35) return "smile";
  return "neutral";
}

async function readFeatureCandidate(featuresDir, index) {
  const filename = `${String(index).padStart(5, "0")}.json`;
  const payload = JSON.parse(await readFile(path.join(featuresDir, filename), "utf8"));
  const attributes = payload?.[0]?.faceAttributes;
  const cell = poseCell(attributes?.headPose);
  if (!attributes || !cell) return null;
  return {
    index,
    attributes,
    ...cell,
    expression: expressionClass(attributes),
    quality: candidateQuality({
      ...attributes,
      faceRectangle: payload?.[0]?.faceRectangle,
    }),
  };
}

async function selectCandidates(featuresDir) {
  const cells = new Map();
  for (let index = 0; index < FALLBACK_SCAN_LIMIT; index += 1) {
    const candidate = await readFeatureCandidate(featuresDir, index);
    if (!candidate) continue;
    const entries = cells.get(candidate.key) ?? [];
    entries.push(candidate);
    cells.set(candidate.key, entries);
  }

  if (cells.size < EXPECTED_POSE_CELLS - 1) {
    throw new Error(`Pose coverage is incomplete: ${cells.size}/${EXPECTED_POSE_CELLS}`);
  }
  for (const [key, entries] of cells) {
    if (!entries.length) throw new Error(`Pose cell ${key} has no faces`);
    const buckets = new Map(
      ["neutral", "smile", "surprise", "frown"].map((expression) => [
        expression,
        entries
          .filter((candidate) => candidate.expression === expression)
          .sort((a, b) => a.quality - b.quality || a.index - b.index),
      ]),
    );
    const cursors = new Map([...buckets.keys()].map((key) => [key, 0]));
    const pattern = ["neutral", "smile", "surprise", "frown", "smile", "neutral"];
    const balanced = [];
    while (balanced.length < entries.length) {
      let added = 0;
      for (const expression of pattern) {
        const bucket = buckets.get(expression);
        const cursor = cursors.get(expression);
        const candidate = bucket?.[cursor];
        if (!candidate) continue;
        balanced.push(candidate);
        cursors.set(expression, cursor + 1);
        added += 1;
      }
      if (!added) break;
    }
    cells.set(key, balanced);
  }

  const selected = [];
  const orderedCells = [...cells.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let round = 0; selected.length < TARGET_FACES; round += 1) {
    let added = 0;
    for (const [, entries] of orderedCells) {
      const candidate = entries[round];
      if (!candidate) continue;
      selected.push(candidate);
      added += 1;
      if (selected.length === TARGET_FACES) break;
    }
    if (!added) break;
  }
  if (selected.length !== TARGET_FACES) {
    throw new Error(`Unable to select ${TARGET_FACES} faces; got ${selected.length}`);
  }
  return selected.sort(
    (a, b) => a.key.localeCompare(b.key) || a.expression.localeCompare(b.expression) || a.index - b.index,
  );
}

async function retry(operation, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

async function fetchRows(offset) {
  const query = new URLSearchParams({
    dataset: "nuwandaa/ffhq128",
    config: "default",
    split: "train",
    offset: String(offset),
    length: "100",
  });
  return retry(async () => {
    const response = await fetch(`https://${DATASET_HOST}/rows?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 3);
      await new Promise((resolve) => setTimeout(resolve, Math.max(3, retryAfter) * 1_000));
      throw new Error("FFHQ rows rate limited");
    }
    if (!response.ok) throw new Error(`FFHQ rows ${response.status}`);
    return response.json();
  }, 8);
}

async function mapImageUrls(selected) {
  const selectedIndexes = new Set(selected.map((candidate) => candidate.index));
  const offsets = [...new Set(selected.map((candidate) => Math.floor(candidate.index / 100) * 100))];
  const imageUrls = new Map();
  let nextOffset = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (nextOffset < offsets.length) {
      const offset = offsets[nextOffset];
      nextOffset += 1;
      const payload = await fetchRows(offset);
      for (const entry of payload.rows ?? []) {
        if (!selectedIndexes.has(entry.row_idx)) continue;
        const image = entry.row?.image;
        const imageUrl = typeof image === "string" ? image : image?.src;
        if (imageUrl) imageUrls.set(entry.row_idx, imageUrl);
      }
      process.stdout.write(`\rResolved image URLs ${imageUrls.size}/${selected.length}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  if (imageUrls.size !== selected.length) {
    throw new Error(`Missing image URLs: ${imageUrls.size}/${selected.length}`);
  }
  return imageUrls;
}

async function extractArchiveImages(selected, archive) {
  const extractionRoot = await mkdtemp(path.join(tmpdir(), "many-faces-seed-"));
  const entries = selected.map(({ index }) => {
    const filename = String(index).padStart(5, "0");
    return `thumbnails128x128/${filename}.png`;
  });
  await execFile("unzip", ["-qq", archive, ...entries, "-d", extractionRoot], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    sources: new Map(
      selected.map(({ index }) => {
        const filename = String(index).padStart(5, "0");
        return [index, path.join(extractionRoot, "thumbnails128x128", `${filename}.png`)];
      }),
    ),
    release: () => rm(extractionRoot, { recursive: true, force: true }),
  };
}

async function downloadAndEncode(imageSource) {
  return retry(async () => {
    const source = /^https:\/\//i.test(imageSource)
      ? await (async () => {
          const response = await fetch(imageSource, {
            headers: { Accept: "image/jpeg,image/png,image/webp,image/*" },
          });
          if (!response.ok) throw new Error(`FFHQ image ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        })()
      : await readFile(imageSource);
    const image = await loadImage(source);
    const canvas = createCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    return canvas.encode("webp", 78);
  });
}

function cellFilename(yaw, pitch) {
  const token = (value) =>
    value >= 0
      ? `p${String(value).padStart(3, "0")}`
      : `n${String(Math.abs(value)).padStart(3, "0")}`;
  return `seed_yaw_${token(yaw)}_pitch_${token(pitch)}.json`;
}

function expressionFeature(attributes) {
  const emotion = attributes.emotion ?? {};
  const smile = Number(attributes.smile ?? emotion.happiness ?? 0);
  const surprise = Math.max(Number(emotion.surprise ?? 0), Number(emotion.fear ?? 0) * 0.7);
  const negative = Math.max(
    Number(emotion.sadness ?? 0),
    Number(emotion.anger ?? 0),
    Number(emotion.disgust ?? 0),
    Number(emotion.contempt ?? 0),
  );
  const pucker = Math.max(Number(emotion.contempt ?? 0), Number(emotion.disgust ?? 0)) * 0.45;
  return [
    surprise * 0.8,
    0,
    surprise * 0.2,
    pucker,
    smile,
    smile,
    negative * 0.8,
    negative * 0.8,
    surprise * 0.25,
    surprise * 0.25,
    0,
    0,
    Math.max(smile, negative) * 0.28,
    Math.max(smile, negative) * 0.28,
    surprise * 0.6,
    negative * 0.65,
    negative * 0.65,
    surprise * 0.5,
    surprise * 0.5,
  ].map((value) => Number(Math.max(0, Math.min(1, value)).toFixed(5)));
}

async function main() {
  const args = parseArgs();
  console.log("Selecting a pose- and expression-balanced 5,000-face seed catalog...");
  const selected = await selectCandidates(args.features);
  const officialMetadata = JSON.parse(await readFile(args.metadata, "utf8"));
  const archiveImages = args.archive
    ? await extractArchiveImages(selected, args.archive)
    : null;
  const imageSources = archiveImages?.sources ?? (await mapImageUrls(selected));

  await rm(args.output, { recursive: true, force: true });
  const packDir = path.join(args.output, "packs");
  const shardDir = path.join(args.output, "shards");
  await mkdir(packDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });

  const encodedImages = new Map();
  const cells = new Map();
  let nextImage = 0;
  let completed = 0;
  const workers = Array.from({ length: 10 }, async () => {
    while (nextImage < selected.length) {
      const candidate = selected[nextImage];
      nextImage += 1;
      const encoded = await downloadAndEncode(imageSources.get(candidate.index));
      encodedImages.set(candidate.index, encoded);
      completed += 1;
      process.stdout.write(`\rEncoded faces ${completed}/${selected.length}`);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");

  let packIndex = 0;
  let packName = `seed_pack_${String(packIndex).padStart(3, "0")}.bin`;
  let packSize = 0;
  let packParts = [];
  const packNames = [];
  const flushPack = async () => {
    if (!packParts.length) return;
    await writeFile(path.join(packDir, packName), Buffer.concat(packParts));
    packNames.push(packName);
    packIndex += 1;
    packName = `seed_pack_${String(packIndex).padStart(3, "0")}.bin`;
    packSize = 0;
    packParts = [];
  };

  for (const candidate of selected) {
      const encoded = encodedImages.get(candidate.index);
      if (!encoded) throw new Error(`Missing encoded image ${candidate.index}`);
      if (packSize && packSize + encoded.byteLength > PACK_TARGET_BYTES) await flushPack();
      const metadata = officialMetadata[String(candidate.index)]?.metadata ?? {};
      const pose = candidate.attributes.headPose;
      const entry = {
        id: `seed-ffhq-${candidate.index}`,
        name: metadata.photo_title || `FFHQ ${String(candidate.index).padStart(5, "0")}`,
        pack: packName,
        offset: packSize,
        length: encoded.byteLength,
        feature: [
          Number((candidate.yaw / 90).toFixed(6)),
          Number((candidate.pitch / 90).toFixed(6)),
          Number(((Math.round(Number(pose.roll ?? 0) / POSE_STEP) * POSE_STEP) / 90).toFixed(6)),
          ...expressionFeature(candidate.attributes),
        ],
        sourceName: "FFHQ / Flickr",
        sourceUrl: metadata.photo_url || DATASET_PAGE,
        creator: metadata.author || "Unknown Flickr photographer",
        license: metadata.license || "FFHQ permitted license",
        licenseUrl: metadata.license_url || LICENSE_URL,
      };
      packParts.push(encoded);
      packSize += encoded.byteLength;
      const cellEntries = cells.get(candidate.key);
      if (cellEntries) cellEntries.push(entry);
      else cells.set(candidate.key, [entry]);
  }
  await flushPack();

  const manifestCells = {};
  for (const [key, entries] of [...cells.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    entries.sort((left, right) => left.id.localeCompare(right.id));
    const [yaw, pitch] = key.split(":").map(Number);
    const filename = cellFilename(yaw, pitch);
    await writeFile(
      path.join(shardDir, filename),
      JSON.stringify({ cell: key, items: entries }),
    );
    manifestCells[key] = { count: entries.length, shards: [filename] };
  }

  const manifest = {
    schemaVersion: 1,
    catalogId: "seed-ffhq-5000-expression-v2",
    generatedAt: new Date().toISOString(),
    totalFaces: selected.length,
    poseStep: POSE_STEP,
    bounds: {
      yawMin: YAW_MIN,
      yawMax: YAW_MAX,
      pitchMin: PITCH_MIN,
      pitchMax: PITCH_MAX,
    },
    outputSize: OUTPUT_SIZE,
    cells: manifestCells,
    stats: {
      checked: FALLBACK_SCAN_LIMIT,
      accepted: selected.length,
      poseCells: cells.size,
      expectedPoseCells: EXPECTED_POSE_CELLS,
      missingPoseCells: EXPECTED_POSE_CELLS - cells.size,
      minimumFacesPerCell: Math.min(...[...cells.values()].map((entries) => entries.length)),
      maximumFacesPerCell: Math.max(...[...cells.values()].map((entries) => entries.length)),
      packCount: packNames.length,
      expressionDistribution: Object.fromEntries(
        ["neutral", "smile", "surprise", "frown"].map((expression) => [
          expression,
          selected.filter((candidate) => candidate.expression === expression).length,
        ]),
      ),
    },
    source: {
      name: "Flickr-Faces-HQ (FFHQ)",
      url: FFHQ_PAGE,
      mirror: DATASET_PAGE,
      featureLabels: FEATURES_PAGE,
      license: "CC BY-NC-SA 4.0; per-image licenses retained in shards",
      licenseUrl: LICENSE_URL,
      changes: "Selected 5,000 images across pose and expression groups, resized to 256px WebP, and packed for range delivery on mobile.",
    },
  };
  await writeFile(path.join(args.output, "manifest.json"), JSON.stringify(manifest));

  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  console.log(
    `Seed catalog ready: ${selected.length} faces, ${cells.size} pose cells, manifest ${digest.slice(0, 16)}`,
  );
  await archiveImages?.release();
}

await main();
