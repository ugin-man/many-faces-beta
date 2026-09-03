#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const FACE_ACTION_KEYS = [
  "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker",
  "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthStretchLeft", "mouthStretchRight", "eyeBlinkLeft", "eyeBlinkRight",
  "eyeSquintLeft", "eyeSquintRight", "browInnerUp", "browDownLeft",
  "browDownRight", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
  "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
  "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawRight",
  "mouthDimpleLeft", "mouthDimpleRight", "mouthLeft",
  "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight",
  "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
  "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight", "_neutral",
];

export const FEATURE_INDEX = Object.fromEntries(
  FACE_ACTION_KEYS.map((key, index) => [key, index + 3]),
);

export const CONFIGURATION_WEIGHTS = {
  neutral: 0.55,
  winkLeft: 2.4,
  winkRight: 2.4,
  blink: 1.25,
  eyesWide: 1.35,
  gazeUp: 1.1,
  gazeDown: 1.1,
  gazeLeft: 1.1,
  gazeRight: 1.1,
  browsUp: 1.1,
  browsDown: 1.05,
  smileClosed: 0.9,
  smileOpen: 1.15,
  smileAsymmetric: 1.4,
  frown: 1.1,
  mouthOpen: 1.0,
  mouthRound: 1.6,
  mouthWide: 1.35,
  pucker: 1.45,
  mouthLeft: 1.25,
  mouthRight: 1.25,
  mouthPress: 1.15,
  mouthRoll: 1.15,
  mouthShrug: 1.15,
  sneer: 1.3,
  jawLeft: 1.25,
  jawRight: 1.25,
  jawForward: 1.2,
};

const CONFIGURATION_QUERY = {
  neutral: "neutral relaxed face",
  winkLeft: "left eye wink",
  winkRight: "right eye wink",
  blink: "eyes closed blink",
  eyesWide: "eyes wide open",
  gazeUp: "eyes looking up",
  gazeDown: "eyes looking down",
  gazeLeft: "eyes looking left",
  gazeRight: "eyes looking right",
  browsUp: "raised eyebrows",
  browsDown: "furrowed lowered eyebrows",
  smileClosed: "closed mouth smile",
  smileOpen: "open mouth smile laughing",
  smileAsymmetric: "asymmetric one-sided smile smirk",
  frown: "frowning face",
  mouthOpen: "mouth open",
  mouthRound: "rounded O mouth",
  mouthWide: "wide stretched mouth",
  pucker: "puckered lips",
  mouthLeft: "mouth pulled left",
  mouthRight: "mouth pulled right",
  mouthPress: "pressed lips",
  mouthRoll: "rolled lips inward",
  mouthShrug: "mouth shrug expression",
  sneer: "nose sneer",
  jawLeft: "jaw shifted left",
  jawRight: "jaw shifted right",
  jawForward: "jaw pushed forward",
};

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value ?? 0)));
}

function score(feature, key) {
  return clamp01(feature?.[FEATURE_INDEX[key]]);
}

function decodeProjection(encoded) {
  if (!encoded) return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length % 2) return null;
    const values = new Float32Array(bytes.length / 2);
    for (let index = 0; index < values.length; index += 1) {
      values[index] = bytes.readInt16LE(index * 2) / 4096;
    }
    return values;
  } catch {
    return null;
  }
}

function aperture(projection, top, bottom) {
  if (!projection || bottom * 2 + 1 >= projection.length) return null;
  return Math.abs(Number(projection[top * 2 + 1]) - Number(projection[bottom * 2 + 1]));
}

export function classifyFaceConfigurations(feature, encodedProjection = null) {
  const configurations = new Set();
  const projection = typeof encodedProjection === "string"
    ? decodeProjection(encodedProjection)
    : encodedProjection;
  const leftBlink = score(feature, "eyeBlinkLeft");
  const rightBlink = score(feature, "eyeBlinkRight");
  const leftAperture = aperture(projection, 159, 145);
  const rightAperture = aperture(projection, 386, 374);
  const yaw = Math.abs(Number(feature?.[0] ?? 0) * 90);
  const smileLeft = score(feature, "mouthSmileLeft");
  const smileRight = score(feature, "mouthSmileRight");
  const smile = (smileLeft + smileRight) / 2;
  const jawOpen = score(feature, "jawOpen");
  const funnel = score(feature, "mouthFunnel");
  const pucker = score(feature, "mouthPucker");
  const stretch = (score(feature, "mouthStretchLeft") + score(feature, "mouthStretchRight")) / 2;
  const frown = Math.max(
    (score(feature, "mouthFrownLeft") + score(feature, "mouthFrownRight")) / 2,
    (score(feature, "browDownLeft") + score(feature, "browDownRight")) / 2,
  );

  const winkPass = (delta, closed, opened) => {
    if (opened === null || closed === null) return yaw <= 18 && delta >= 0.34;
    if (opened <= 1e-5) return false;
    const ratio = closed / opened;
    if (yaw <= 18) return delta >= 0.28 && ratio <= 0.76;
    if (yaw <= 30) return delta >= 0.34 && ratio <= 0.62;
    if (yaw <= 45) return delta >= 0.42 && ratio <= 0.5;
    return false;
  };
  // MediaPipe names anatomical sides; image-space landmark groups are mirrored.
  if (winkPass(leftBlink - rightBlink, rightAperture, leftAperture)) configurations.add("winkLeft");
  if (winkPass(rightBlink - leftBlink, leftAperture, rightAperture)) configurations.add("winkRight");
  if (Math.min(leftBlink, rightBlink) >= 0.42) configurations.add("blink");
  if ((score(feature, "eyeWideLeft") + score(feature, "eyeWideRight")) / 2 >= 0.22) configurations.add("eyesWide");
  if ((score(feature, "eyeLookUpLeft") + score(feature, "eyeLookUpRight")) / 2 >= 0.2) configurations.add("gazeUp");
  if ((score(feature, "eyeLookDownLeft") + score(feature, "eyeLookDownRight")) / 2 >= 0.2) configurations.add("gazeDown");
  if ((score(feature, "eyeLookOutLeft") + score(feature, "eyeLookInRight")) / 2 >= 0.2) configurations.add("gazeLeft");
  if ((score(feature, "eyeLookInLeft") + score(feature, "eyeLookOutRight")) / 2 >= 0.2) configurations.add("gazeRight");
  if (Math.max(
    score(feature, "browInnerUp"),
    score(feature, "browOuterUpLeft"),
    score(feature, "browOuterUpRight"),
  ) >= 0.24) configurations.add("browsUp");
  if ((score(feature, "browDownLeft") + score(feature, "browDownRight")) / 2 >= 0.22) configurations.add("browsDown");

  if (smile >= 0.27 && jawOpen < 0.25) configurations.add("smileClosed");
  if (smile >= 0.25 && jawOpen >= 0.25) configurations.add("smileOpen");
  if (Math.abs(smileLeft - smileRight) >= 0.2 && Math.max(smileLeft, smileRight) >= 0.25) {
    configurations.add("smileAsymmetric");
  }
  if (frown >= 0.22) configurations.add("frown");
  if (jawOpen >= 0.31) configurations.add("mouthOpen");
  if (Math.max(funnel, pucker) >= 0.25 && stretch < 0.25) configurations.add("mouthRound");
  if (stretch >= 0.28) configurations.add("mouthWide");
  if (Math.max(pucker, funnel * 0.8) >= 0.28) configurations.add("pucker");
  if (score(feature, "mouthLeft") >= 0.22) configurations.add("mouthLeft");
  if (score(feature, "mouthRight") >= 0.22) configurations.add("mouthRight");
  if ((score(feature, "mouthPressLeft") + score(feature, "mouthPressRight")) / 2 >= 0.22) configurations.add("mouthPress");
  if (Math.max(score(feature, "mouthRollLower"), score(feature, "mouthRollUpper")) >= 0.22) configurations.add("mouthRoll");
  if (Math.max(score(feature, "mouthShrugLower"), score(feature, "mouthShrugUpper")) >= 0.22) configurations.add("mouthShrug");
  if ((score(feature, "noseSneerLeft") + score(feature, "noseSneerRight")) / 2 >= 0.19) configurations.add("sneer");
  if (score(feature, "jawLeft") >= 0.2) configurations.add("jawLeft");
  if (score(feature, "jawRight") >= 0.2) configurations.add("jawRight");
  if (score(feature, "jawForward") >= 0.2) configurations.add("jawForward");

  if (!configurations.size) configurations.add("neutral");
  return [...configurations];
}

export function coarsePose(feature, step = 9) {
  const yaw = Math.round((Number(feature?.[0] ?? 0) * 90) / step) * step;
  const pitch = Math.round((Number(feature?.[1] ?? 0) * 90) / step) * step;
  return { yaw, pitch, key: `${yaw}:${pitch}` };
}

function poseWeight(yaw, pitch) {
  const radial = Math.exp(-0.5 * ((yaw / 38) ** 2 + (pitch / 30) ** 2));
  return 0.32 + radial * 0.68;
}

function targetForConfiguration(configuration, yaw, pitch) {
  const base = {
    neutral: 70,
    winkLeft: 16,
    winkRight: 16,
    blink: 20,
    eyesWide: 24,
    gazeUp: 18,
    gazeDown: 18,
    gazeLeft: 18,
    gazeRight: 18,
    browsUp: 22,
    browsDown: 18,
    smileClosed: 42,
    smileOpen: 30,
    smileAsymmetric: 18,
    frown: 24,
    mouthOpen: 34,
    mouthRound: 24,
    mouthWide: 24,
    pucker: 20,
    mouthLeft: 14,
    mouthRight: 14,
    mouthPress: 16,
    mouthRoll: 14,
    mouthShrug: 14,
    sneer: 14,
    jawLeft: 12,
    jawRight: 12,
    jawForward: 12,
  }[configuration] ?? 12;
  // Rare combinations matter most away from the frontal cluster. Never let an
  // extreme-pose target collapse to zero merely because source data is scarce.
  const extremityBoost = 1 + Math.max(0, Math.abs(yaw) - 18) / 90 + Math.max(0, Math.abs(pitch) - 18) / 72;
  return Math.max(4, Math.round(base * poseWeight(yaw, pitch) * extremityBoost));
}

function largestRemainder(total, weightedItems) {
  if (total <= 0 || !weightedItems.length) return weightedItems.map(() => 0);
  const weightTotal = weightedItems.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (!weightTotal) return weightedItems.map(() => 0);
  const raw = weightedItems.map((item) => total * Math.max(0, item.weight) / weightTotal);
  const floors = raw.map(Math.floor);
  let remaining = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) floors[order[index % order.length].index] += 1;
  return floors;
}

function posePhrase(yaw, pitch) {
  const horizontal = yaw <= -27
    ? "strong left profile"
    : yaw < -9
      ? "three quarter left view"
      : yaw >= 27
        ? "strong right profile"
        : yaw > 9
          ? "three quarter right view"
          : "front facing";
  const vertical = pitch <= -18
    ? "looking down"
    : pitch >= 18
      ? "looking up"
      : "level camera";
  return `${horizontal} ${vertical}`;
}

export function analyzeCoverageEntries(entries, options = {}) {
  const poseStep = Math.max(3, Number(options.poseStep ?? 9));
  const targetTotal = Math.max(entries.length, Number(options.targetTotal ?? 200_000));
  const byPose = new Map();
  const byPoseConfiguration = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry.feature) || entry.feature.length < 22) continue;
    const pose = coarsePose(entry.feature, poseStep);
    byPose.set(pose.key, (byPose.get(pose.key) ?? 0) + 1);
    for (const configuration of classifyFaceConfigurations(entry.feature, entry.projection)) {
      const key = `${pose.key}|${configuration}`;
      byPoseConfiguration.set(key, (byPoseConfiguration.get(key) ?? 0) + 1);
    }
  }

  const yawValues = [];
  for (let yaw = -45; yaw <= 45; yaw += poseStep) yawValues.push(yaw);
  const pitchValues = [];
  for (let pitch = -36; pitch <= 36; pitch += poseStep) pitchValues.push(pitch);
  const poseTargets = [];
  for (const yaw of yawValues) {
    for (const pitch of pitchValues) {
      poseTargets.push({ key: `${yaw}:${pitch}`, yaw, pitch, weight: poseWeight(yaw, pitch) });
    }
  }
  const desiredPoseCounts = largestRemainder(targetTotal, poseTargets);
  poseTargets.forEach((pose, index) => {
    pose.current = byPose.get(pose.key) ?? 0;
    pose.target = desiredPoseCounts[index];
    pose.deficit = Math.max(0, pose.target - pose.current);
  });

  const gaps = [];
  for (const pose of poseTargets) {
    for (const [configuration, importance] of Object.entries(CONFIGURATION_WEIGHTS)) {
      const count = byPoseConfiguration.get(`${pose.key}|${configuration}`) ?? 0;
      const target = targetForConfiguration(configuration, pose.yaw, pose.pitch);
      const deficit = Math.max(0, target - count);
      if (!deficit) continue;
      const pressure = deficit / target * importance * (1 + Math.min(1.5, pose.deficit / Math.max(1, pose.target)));
      gaps.push({
        pose: pose.key,
        yaw: pose.yaw,
        pitch: pose.pitch,
        configuration,
        count,
        target,
        deficit,
        poseCurrent: pose.current,
        poseTarget: pose.target,
        poseDeficit: pose.deficit,
        pressure: Number(pressure.toFixed(6)),
      });
    }
  }
  gaps.sort((left, right) => right.pressure - left.pressure || right.deficit - left.deficit || left.pose.localeCompare(right.pose));

  const neededImages = Math.max(0, targetTotal - entries.length);
  const queueWeights = gaps.map((gap) => ({ weight: gap.pressure * Math.sqrt(gap.deficit) }));
  const allocations = largestRemainder(neededImages, queueWeights);
  const collectionQueue = gaps
    .map((gap, index) => ({
      ...gap,
      recommendedAdditions: allocations[index],
      candidateAttempts: allocations[index] ? Math.max(20, Math.ceil(allocations[index] * 4.5)) : 0,
      query: `single person portrait ${CONFIGURATION_QUERY[gap.configuration] ?? gap.configuration} ${posePhrase(gap.yaw, gap.pitch)}`,
    }))
    .filter((item) => item.recommendedAdditions > 0)
    .sort((left, right) => right.recommendedAdditions - left.recommendedAdditions || right.pressure - left.pressure);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currentFaces: entries.length,
    targetFaces: targetTotal,
    neededImages,
    poseStep,
    poseCells: poseTargets.length,
    configurations: Object.keys(CONFIGURATION_WEIGHTS),
    posePlan: poseTargets.sort((left, right) => right.deficit - left.deficit || left.key.localeCompare(right.key)),
    weakest: gaps.slice(0, Number(options.weakestLimit ?? 500)),
    collectionQueue,
  };
}

async function loadCatalogEntries(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalogRoot = path.dirname(manifestPath);
  const shardNames = [...new Set(Object.values(manifest.cells ?? {}).flatMap((cell) =>
    cell.shards ?? (cell.shard ? [cell.shard] : []),
  ))];
  const entries = [];
  for (let index = 0; index < shardNames.length; index += 1) {
    const shard = JSON.parse(await readFile(path.join(catalogRoot, "shards", shardNames[index]), "utf8"));
    entries.push(...(shard.items ?? []));
    if (index % 100 === 99 || index + 1 === shardNames.length) {
      process.stderr.write(`\rread ${index + 1}/${shardNames.length} shards; ${entries.length.toLocaleString()} entries`);
    }
  }
  process.stderr.write("\n");
  return { manifest, entries };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const manifest = values.get("--manifest");
  if (!manifest) {
    throw new Error("Usage: coverage-200k-plan.mjs --manifest <catalog/manifest.json> [--target 200000] [--output data/coverage-200k-plan.json]");
  }
  return {
    manifest: path.resolve(manifest),
    target: Math.max(1, Number(values.get("--target") ?? 200_000)),
    poseStep: Math.max(3, Number(values.get("--pose-step") ?? 9)),
    output: path.resolve(values.get("--output") ?? "data/coverage-200k-plan.json"),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { entries } = await loadCatalogEntries(args.manifest);
  const plan = analyzeCoverageEntries(entries, {
    targetTotal: args.target,
    poseStep: args.poseStep,
  });
  await writeFile(args.output, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({
    output: args.output,
    currentFaces: plan.currentFaces,
    targetFaces: plan.targetFaces,
    neededImages: plan.neededImages,
    queueItems: plan.collectionQueue.length,
    weakest: plan.weakest.slice(0, 12),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
