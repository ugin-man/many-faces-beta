#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const execFile = promisify(execFileCallback);
const SCAN_LIMIT = 70_000;
const POSE_STEP = 3;
const YAW_MIN = -45;
const YAW_MAX = 45;
const PITCH_MIN = -36;
const PITCH_MAX = 36;
const OUTPUT_SIZE = 256;
const PACK_TARGET_BYTES = 2 * 1024 * 1024;
const EXPRESSION_PATTERN = ["neutral", "smile", "surprise", "frown", "smile", "neutral"];
const DATASET_PAGE = "https://huggingface.co/datasets/nuwandaa/ffhq128";
const FFHQ_PAGE = "https://github.com/NVlabs/ffhq-dataset";
const LICENSE_URL = "https://github.com/NVlabs/ffhq-dataset/blob/master/LICENSE.txt";

function parseArgs() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index], process.argv[index + 1]);
  }
  const features = values.get("--features");
  const metadata = values.get("--metadata");
  const archive = values.get("--archive");
  const catalog = values.get("--catalog");
  const target = Number(values.get("--target") ?? 15_000);
  if (!features || !metadata || !archive || !catalog || !Number.isSafeInteger(target)) {
    throw new Error(
      "Usage: expand_seed_catalog.mjs --features <json dir> --metadata <ffhq json> --archive <zip> --catalog <seed-catalog dir> --target <total>",
    );
  }
  return {
    features: path.resolve(features),
    metadata: path.resolve(metadata),
    archive: path.resolve(archive),
    catalog: path.resolve(catalog),
    target,
  };
}

function poseCell(headPose) {
  const yaw = Math.round(Number(headPose?.yaw ?? 999) / POSE_STEP) * POSE_STEP;
  const pitch = Math.round(Number(headPose?.pitch ?? 999) / POSE_STEP) * POSE_STEP;
  if (yaw < YAW_MIN || yaw > YAW_MAX || pitch < PITCH_MIN || pitch > PITCH_MAX) return null;
  return { key: `${yaw}:${pitch}`, yaw, pitch };
}

function candidateQuality(attributes, faceRectangle) {
  const blur = Number(attributes.blur?.value ?? 1);
  const noise = Number(attributes.noise?.value ?? 1);
  const exposure = attributes.exposure?.exposureLevel === "goodExposure" ? 0 : 1;
  const occlusion = attributes.occlusion ?? {};
  const occlusionPenalty = [
    occlusion.foreheadOccluded,
    occlusion.eyeOccluded,
    occlusion.mouthOccluded,
  ].filter(Boolean).length;
  const faceArea = Number(faceRectangle?.width ?? 0) * Number(faceRectangle?.height ?? 0);
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
  return smile >= 0.35 ? "smile" : "neutral";
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
  const legacy = [
    surprise * 0.8, 0, surprise * 0.2, pucker, smile, smile,
    negative * 0.8, negative * 0.8, surprise * 0.25, surprise * 0.25,
    0, 0, Math.max(smile, negative) * 0.28, Math.max(smile, negative) * 0.28,
    surprise * 0.6, negative * 0.65, negative * 0.65, surprise * 0.5, surprise * 0.5,
  ].map((value) => Number(Math.max(0, Math.min(1, value)).toFixed(5)));
  return [...legacy, ...Array(33).fill(0)];
}

function balancedCandidates(entries) {
  const buckets = new Map(
    ["neutral", "smile", "surprise", "frown"].map((expression) => [
      expression,
      entries
        .filter((candidate) => candidate.expression === expression)
        .sort((left, right) => left.quality - right.quality || left.index - right.index),
    ]),
  );
  const cursors = new Map([...buckets.keys()].map((key) => [key, 0]));
  const balanced = [];
  while (balanced.length < entries.length) {
    let added = 0;
    for (const expression of EXPRESSION_PATTERN) {
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
  return balanced;
}

async function loadExisting(catalog) {
  const manifestPath = path.join(catalog, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const existingIds = new Set();
  const existingCellCounts = new Map();
  for (const [key, cell] of Object.entries(manifest.cells ?? {})) {
    existingCellCounts.set(key, Number(cell.count ?? 0));
    for (const filename of cell.shards ?? []) {
      const payload = JSON.parse(await readFile(path.join(catalog, "shards", filename), "utf8"));
      for (const entry of payload.items ?? []) existingIds.add(entry.id);
    }
  }
  return { manifest, manifestPath, existingIds, existingCellCounts };
}

async function selectCandidates(featuresDir, existingIds, existingCellCounts, needed) {
  const cells = new Map();
  for (let index = 0; index < SCAN_LIMIT; index += 1) {
    if (existingIds.has(`seed-ffhq-${index}`)) continue;
    const filename = `${String(index).padStart(5, "0")}.json`;
    const payload = JSON.parse(await readFile(path.join(featuresDir, filename), "utf8"));
    const attributes = payload?.[0]?.faceAttributes;
    const cell = poseCell(attributes?.headPose);
    if (!attributes || !cell) continue;
    const entry = {
      index,
      attributes,
      expression: expressionClass(attributes),
      quality: candidateQuality(attributes, payload?.[0]?.faceRectangle),
      ...cell,
    };
    const cellEntries = cells.get(cell.key);
    if (cellEntries) cellEntries.push(entry);
    else cells.set(cell.key, [entry]);
  }

  for (const [key, entries] of cells) cells.set(key, balancedCandidates(entries));
  const cursors = new Map([...cells.keys()].map((key) => [key, 0]));
  const counts = new Map([...cells.keys()].map((key) => [key, existingCellCounts.get(key) ?? 0]));
  const selected = [];
  while (selected.length < needed) {
    const orderedCells = [...cells.keys()].sort(
      (left, right) => (counts.get(left) ?? 0) - (counts.get(right) ?? 0) || left.localeCompare(right),
    );
    let added = 0;
    for (const key of orderedCells) {
      const cursor = cursors.get(key) ?? 0;
      const candidate = cells.get(key)?.[cursor];
      if (!candidate) continue;
      selected.push(candidate);
      cursors.set(key, cursor + 1);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      added += 1;
      if (selected.length === needed) break;
    }
    if (!added) break;
  }
  if (selected.length !== needed) {
    throw new Error(`Unable to select ${needed} new faces; got ${selected.length}`);
  }
  return selected.sort((left, right) => left.key.localeCompare(right.key) || left.index - right.index);
}

async function extractArchiveImages(selected, archive) {
  const extractionRoot = await mkdtemp(path.join(tmpdir(), "many-faces-expand-"));
  const entries = selected.map(({ index }) =>
    `thumbnails128x128/${String(index).padStart(5, "0")}.png`,
  );
  for (let start = 0; start < entries.length; start += 1_500) {
    await execFile("unzip", ["-qq", archive, ...entries.slice(start, start + 1_500), "-d", extractionRoot], {
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  return new Map(
    selected.map(({ index }) => [
      index,
      path.join(extractionRoot, "thumbnails128x128", `${String(index).padStart(5, "0")}.png`),
    ]),
  );
}

async function encodeImage(filename) {
  const image = await loadImage(await readFile(filename));
  const canvas = createCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return canvas.encode("webp", 78);
}

function cellFilename(yaw, pitch) {
  const token = (value) => value >= 0
    ? `p${String(value).padStart(3, "0")}`
    : `n${String(Math.abs(value)).padStart(3, "0")}`;
  return `seed_yaw_${token(yaw)}_pitch_${token(pitch)}.json`;
}

async function main() {
  const args = parseArgs();
  const { manifest, manifestPath, existingIds, existingCellCounts } = await loadExisting(args.catalog);
  const needed = args.target - Number(manifest.totalFaces ?? existingIds.size);
  if (needed < 0) throw new Error("Target is smaller than the existing catalog");
  if (!needed) {
    console.log(`Catalog already contains ${args.target} faces.`);
    return;
  }
  console.log(`Selecting ${needed.toLocaleString()} new faces for a ${args.target.toLocaleString()}-face catalog...`);
  const selected = await selectCandidates(args.features, existingIds, existingCellCounts, needed);
  console.log(
    `Selected ${selected.length.toLocaleString()} faces; ` +
    `${selected.filter((item) => Math.abs(item.pitch) >= 27).length.toLocaleString()} have |pitch| >= 27° across ` +
    `${new Set(selected.map((item) => item.key)).size.toLocaleString()} pose cells.`,
  );
  const sources = await extractArchiveImages(selected, args.archive);
  const officialMetadata = JSON.parse(await readFile(args.metadata, "utf8"));

  const encodedImages = new Map();
  let nextImage = 0;
  let completed = 0;
  const workers = Array.from({ length: 10 }, async () => {
    while (nextImage < selected.length) {
      const candidate = selected[nextImage];
      nextImage += 1;
      encodedImages.set(candidate.index, await encodeImage(sources.get(candidate.index)));
      completed += 1;
      if (completed % 100 === 0 || completed === selected.length) {
        process.stdout.write(`\rEncoded faces ${completed}/${selected.length}`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");

  const packFiles = (await readdir(path.join(args.catalog, "packs")))
    .filter((filename) => /^seed_pack_[0-9]{3}\.bin$/.test(filename))
    .sort();
  let packIndex = packFiles.length
    ? Number(packFiles.at(-1).match(/[0-9]{3}/)?.[0] ?? -1) + 1
    : 0;
  let packName = `seed_pack_${String(packIndex).padStart(3, "0")}.bin`;
  let packSize = 0;
  let packParts = [];
  const newPackNames = [];
  const flushPack = async () => {
    if (!packParts.length) return;
    await writeFile(path.join(args.catalog, "packs", packName), Buffer.concat(packParts));
    newPackNames.push(packName);
    packIndex += 1;
    packName = `seed_pack_${String(packIndex).padStart(3, "0")}.bin`;
    packSize = 0;
    packParts = [];
  };

  const newCells = new Map();
  for (const candidate of selected) {
    const encoded = encodedImages.get(candidate.index);
    if (packSize && packSize + encoded.byteLength > PACK_TARGET_BYTES) await flushPack();
    const rawMetadata = officialMetadata[String(candidate.index)] ?? {};
    const metadata = rawMetadata.metadata ?? rawMetadata;
    const pose = candidate.attributes.headPose;
    const entry = {
      id: `seed-ffhq-${candidate.index}`,
      name: metadata.photo_title || metadata.title || `FFHQ ${String(candidate.index).padStart(5, "0")}`,
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
      sourceUrl: metadata.photo_url || metadata.url || DATASET_PAGE,
      creator: metadata.author || "Unknown Flickr photographer",
      license: metadata.license || "FFHQ permitted source license",
      licenseUrl: metadata.license_url || LICENSE_URL,
    };
    packParts.push(encoded);
    packSize += encoded.byteLength;
    const entries = newCells.get(candidate.key);
    if (entries) entries.push(entry);
    else newCells.set(candidate.key, [entry]);
  }
  await flushPack();

  const manifestCells = { ...(manifest.cells ?? {}) };
  for (const [key, newEntries] of newCells) {
    const [yaw, pitch] = key.split(":").map(Number);
    const existing = manifestCells[key];
    const filename = existing?.shards?.[0] ?? cellFilename(yaw, pitch);
    const shardPath = path.join(args.catalog, "shards", filename);
    const oldPayload = existing
      ? JSON.parse(await readFile(shardPath, "utf8"))
      : { cell: key, items: [] };
    oldPayload.items.push(...newEntries);
    oldPayload.items.sort((left, right) => left.id.localeCompare(right.id));
    await writeFile(shardPath, JSON.stringify(oldPayload));
    manifestCells[key] = { count: oldPayload.items.length, shards: [filename] };
  }

  const previousDistribution = manifest.stats?.expressionDistribution ?? {};
  const expressionDistribution = Object.fromEntries(
    ["neutral", "smile", "surprise", "frown"].map((expression) => [
      expression,
      Number(previousDistribution[expression] ?? 0) + selected.filter((item) => item.expression === expression).length,
    ]),
  );
  manifest.schemaVersion = 3;
  manifest.catalogId = `seed-ffhq-${args.target}-expression-v3`;
  manifest.generatedAt = new Date().toISOString();
  manifest.totalFaces = args.target;
  manifest.poseStep = POSE_STEP;
  manifest.bounds = { yawMin: YAW_MIN, yawMax: YAW_MAX, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX };
  manifest.cells = Object.fromEntries(Object.entries(manifestCells).sort(([left], [right]) => left.localeCompare(right)));
  const cellCounts = Object.values(manifest.cells).map((cell) => Number(cell.count ?? 0));
  const expectedPoseCells = ((YAW_MAX - YAW_MIN) / POSE_STEP + 1) * ((PITCH_MAX - PITCH_MIN) / POSE_STEP + 1);
  manifest.stats = {
    ...manifest.stats,
    checked: SCAN_LIMIT,
    accepted: args.target,
    poseCells: Object.keys(manifest.cells).length,
    expectedPoseCells,
    missingPoseCells: expectedPoseCells - Object.keys(manifest.cells).length,
    minimumFacesPerCell: Math.min(...cellCounts),
    maximumFacesPerCell: Math.max(...cellCounts),
    packCount: packFiles.length + newPackNames.length,
    expressionDistribution,
    expansion: {
      fromFaces: args.target - needed,
      addedFaces: needed,
      addedPoseCells: [...newCells.keys()].filter((key) => !existingCellCounts.has(key)).length,
      addedExtremePitchFaces: selected.filter((item) => Math.abs(item.pitch) >= 27).length,
    },
  };
  manifest.source = {
    ...manifest.source,
    name: "Flickr-Faces-HQ (FFHQ)",
    url: FFHQ_PAGE,
    mirror: DATASET_PAGE,
    license: "CC BY-NC-SA 4.0; original source licenses retained where available",
    licenseUrl: LICENSE_URL,
    changes: `Selected ${args.target.toLocaleString()} images across pose and expression groups, resized to 256px WebP, packed for range delivery, and preindexed with MediaPipe Face Mesh.`,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(
    `Expanded catalog to ${args.target.toLocaleString()} faces across ${Object.keys(manifest.cells).length} cells; ${newPackNames.length} new packs.`,
  );
}

await main();
