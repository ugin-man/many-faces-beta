#!/usr/bin/env node

import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const result = {
    baseUrl: "http://127.0.0.1:3000",
    route: "/live",
    video: "",
    output: "work/live-video-verification",
    timeoutMs: 15 * 60 * 1000,
    staleMs: 60 * 1000,
    headless: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--base-url" && next) result.baseUrl = next, index += 1;
    else if (value === "--route" && next) result.route = next, index += 1;
    else if (value === "--video" && next) result.video = next, index += 1;
    else if (value === "--output" && next) result.output = next, index += 1;
    else if (value === "--timeout-ms" && next) result.timeoutMs = Number(next), index += 1;
    else if (value === "--stale-ms" && next) result.staleMs = Number(next), index += 1;
    else if (value === "--headed") result.headless = false;
    else if (value === "--help") {
      console.log("Usage: node scripts/verify-live-video.mjs --video fixture.mp4 [--base-url http://127.0.0.1:3000] [--output work/live-video-verification]");
      process.exit(0);
    }
  }
  if (!result.video) throw new Error("--video is required");
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs < 10_000) {
    throw new Error("--timeout-ms must be at least 10000");
  }
  if (!Number.isFinite(result.staleMs) || result.staleMs < 10_000) {
    throw new Error("--stale-ms must be at least 10000");
  }
  return result;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function safeUrl(baseUrl, route) {
  return new URL(route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

const options = parseArgs(process.argv.slice(2));
const videoPath = path.resolve(options.video);
const outputDir = path.resolve(options.output);
if (!(await fileExists(videoPath))) throw new Error(`Video not found: ${videoPath}`);
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

const startedAt = Date.now();
const consoleLines = [];
const heartbeat = [];
let lastProgress = "";
let lastProgressChangeAt = Date.now();
let finalReport = null;
let failure = null;
let browser = null;

try {
  browser = await chromium.launch({
    headless: options.headless,
    args: ["--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", (message) => {
    consoleLines.push(`${new Date().toISOString()} ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`${new Date().toISOString()} pageerror: ${error.stack || error.message}`);
  });

  await page.goto(safeUrl(options.baseUrl, options.route), {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.locator("[data-live-review-root]").waitFor({
    state: "visible",
    timeout: 120_000,
  });
  const fileInput = page.locator("[data-fixed-video-input]");
  await fileInput.waitFor({ state: "attached", timeout: 120_000 });
  await fileInput.setInputFiles(videoPath);

  while (Date.now() - startedAt < options.timeoutMs) {
    finalReport = await page.evaluate(() => window.__MANY_FACES_VERIFY__ ?? null);
    const snapshot = await page.evaluate(() => {
      const root = document.querySelector("[data-live-review-root]");
      const phase = document.querySelector("[data-verification-phase]")?.textContent?.trim() ?? "";
      const progress = document.querySelector("[data-verification-progress]")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const body = document.body.getBoundingClientRect();
      const canvas = document.querySelector("[data-output-canvas]");
      return {
        phase,
        progress,
        rootVisible: Boolean(root && root.getBoundingClientRect().height > 100),
        bodyWidth: body.width,
        scrollWidth: document.documentElement.scrollWidth,
        canvasMounted: Boolean(canvas),
      };
    });
    const progressKey = `${snapshot.phase}|${snapshot.progress}`;
    if (progressKey !== lastProgress) {
      lastProgress = progressKey;
      lastProgressChangeAt = Date.now();
    }
    heartbeat.push({
      atMs: Date.now() - startedAt,
      ...snapshot,
      reportReady: Boolean(finalReport),
    });

    if (!snapshot.rootVisible) throw new Error("The review root disappeared or the page became blank");
    if (snapshot.scrollWidth > snapshot.bodyWidth + 4) {
      throw new Error(`Horizontal overflow: ${snapshot.scrollWidth}px > ${snapshot.bodyWidth}px`);
    }
    if (finalReport) break;
    if (Date.now() - lastProgressChangeAt > options.staleMs) {
      throw new Error(`Verification stalled for ${Math.round(options.staleMs / 1000)} seconds at: ${lastProgress || "no progress text"}`);
    }
    await page.waitForTimeout(1_000);
  }

  if (!finalReport) throw new Error(`Verification timed out after ${Math.round(options.timeoutMs / 1000)} seconds`);
  await page.screenshot({ path: path.join(outputDir, "final.png"), fullPage: true });

  const hardFailures = [];
  if (!finalReport.passed) hardFailures.push(...(finalReport.reasons ?? ["runtime gate failed"]));
  if (Number(finalReport.faceCoverage) < 0.95) {
    hardFailures.push(`face coverage ${(Number(finalReport.faceCoverage) * 100).toFixed(1)}% is below 95%`);
  }
  if (!finalReport.canvasNonBlank) hardFailures.push("output canvas is blank");
  if (Number(finalReport.sequenceFrames) !== Number(finalReport.faceFrames)) {
    hardFailures.push(`sequence ${finalReport.sequenceFrames} != face frames ${finalReport.faceFrames}`);
  }
  if (Number(finalReport.imageFailures) !== 0) {
    hardFailures.push(`image failures: ${finalReport.imageFailures}`);
  }
  if (hardFailures.length) throw new Error(hardFailures.join("; "));
} catch (error) {
  failure = error instanceof Error ? error.stack || error.message : String(error);
} finally {
  await fs.writeFile(
    path.join(outputDir, "report.json"),
    JSON.stringify({
      schemaVersion: 1,
      video: path.basename(videoPath),
      route: options.route,
      baseUrl: options.baseUrl,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      staleThresholdMs: options.staleMs,
      passed: !failure && Boolean(finalReport?.passed),
      failure,
      runtime: finalReport,
      heartbeat,
    }, null, 2) + "\n",
  );
  await fs.writeFile(path.join(outputDir, "browser.log"), consoleLines.join("\n") + "\n");
  await browser?.close();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log(JSON.stringify(finalReport, null, 2));
