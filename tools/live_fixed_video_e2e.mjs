#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const baseUrl = process.env.LIVE_E2E_BASE_URL || "http://127.0.0.1:3000";
const videoPath = path.resolve(
  process.env.LIVE_E2E_VIDEO || "work/reference-face-motion.webm",
);
const outputDir = path.resolve(process.env.LIVE_E2E_OUTPUT || "work/live-e2e");
const overallTimeoutMs = Number(process.env.LIVE_E2E_TIMEOUT_MS || 12 * 60_000);
const stallTimeoutMs = Number(process.env.LIVE_E2E_STALL_MS || 120_000);

await fs.mkdir(outputDir, { recursive: true });

const events = [];
const startedAt = Date.now();
let lastProgressAt = startedAt;
let lastSignature = "";
let finalReport = null;
let failure = null;

function record(type, payload = {}) {
  const event = {
    atMs: Date.now() - startedAt,
    type,
    ...payload,
  };
  events.push(event);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-dev-shm-usage",
    "--use-gl=swiftshader",
    "--enable-webgl",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "ja-JP",
});
const page = await context.newPage();

page.on("console", (message) => {
  record("console", { level: message.type(), text: message.text().slice(0, 2_000) });
});
page.on("pageerror", (error) => {
  record("pageerror", { message: String(error?.stack || error).slice(0, 4_000) });
});
page.on("requestfailed", (request) => {
  record("requestfailed", {
    url: request.url(),
    reason: request.failure()?.errorText || "unknown",
  });
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    record("http-error", { status: response.status(), url: response.url() });
  }
});

try {
  record("navigate", { url: `${baseUrl}/live` });
  const response = await page.goto(`${baseUrl}/live`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!response || !response.ok()) {
    throw new Error(`LIVE_ROUTE_HTTP_${response?.status() ?? "NO_RESPONSE"}`);
  }

  const root = page.getByTestId("verification-root");
  await root.waitFor({ state: "visible", timeout: 30_000 });
  const title = await page.title();
  const initialText = (await page.locator("body").innerText()).slice(0, 4_000);
  record("route-ready", { title, initialText });

  const fileInput = page.getByTestId("verification-file-input");
  await fileInput.setInputFiles(videoPath);
  record("fixture-submitted", { videoPath });

  while (Date.now() - startedAt < overallTimeoutMs) {
    const snapshot = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="verification-root"]');
      const report = window.__MANY_FACES_VERIFY__ ?? null;
      const runtime = window.__MANY_FACES_RUNTIME__ ?? null;
      const progress = document.querySelector('[class*="progressBox"]')?.textContent ?? "";
      const bodyText = document.body?.innerText?.slice(0, 1_500) ?? "";
      return {
        state: root?.getAttribute("data-state") ?? "missing",
        verdict: root?.getAttribute("data-verdict") ?? "missing",
        report,
        runtime,
        progress,
        bodyText,
      };
    });

    const signature = JSON.stringify({
      state: snapshot.state,
      verdict: snapshot.verdict,
      progress: snapshot.progress,
      runtime: snapshot.runtime,
      report: snapshot.report,
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
      record("heartbeat", snapshot);
    }

    if (snapshot.report) {
      finalReport = snapshot.report;
      break;
    }
    if (snapshot.state === "error") {
      throw new Error(`LIVE_ROUTE_ERROR: ${snapshot.bodyText}`);
    }
    if (Date.now() - lastProgressAt >= stallTimeoutMs) {
      throw new Error(
        `LIVE_ROUTE_STALLED_${Math.ceil(stallTimeoutMs / 1_000)}S: ${snapshot.progress || snapshot.state}`,
      );
    }
    await page.waitForTimeout(1_000);
  }

  if (!finalReport) throw new Error("LIVE_ROUTE_OVERALL_TIMEOUT");
  if (!finalReport.passed) {
    throw new Error(`VERIFICATION_GATE_FAILED: ${JSON.stringify(finalReport)}`);
  }
  if (!finalReport.canvasNonBlank) throw new Error("OUTPUT_CANVAS_IS_BLANK");
  if (Number(finalReport.faceCoverage) < 0.7) {
    throw new Error(`FACE_COVERAGE_TOO_LOW_${finalReport.faceCoverage}`);
  }
  if (Number(finalReport.sequenceFrames) !== Number(finalReport.faceFrames)) {
    throw new Error("SEQUENCE_FRAME_COUNT_MISMATCH");
  }

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    rootRect: document
      .querySelector('[data-testid="verification-root"]')
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  if (layout.documentWidth > layout.viewportWidth + 2) {
    throw new Error(
      `HORIZONTAL_OVERFLOW_${layout.documentWidth - layout.viewportWidth}px`,
    );
  }

  const playButton = page.getByRole("button", { name: "再生" });
  if (await playButton.isVisible()) {
    await playButton.click();
    await page.waitForTimeout(1_200);
    const playbackTime = await page.evaluate(() => {
      const videos = [...document.querySelectorAll("video")];
      return Math.max(0, ...videos.map((video) => Number(video.currentTime || 0)));
    });
    if (playbackTime <= 0.05) throw new Error("REVIEW_PLAYBACK_DID_NOT_ADVANCE");
    record("playback-advanced", { playbackTime });
  }

  await page.screenshot({
    path: path.join(outputDir, "live-fixed-video-pass.png"),
    fullPage: true,
  });
  record("pass", { finalReport, layout });
} catch (error) {
  failure = String(error?.stack || error);
  record("failure", { failure });
  try {
    await page.screenshot({
      path: path.join(outputDir, "live-fixed-video-failure.png"),
      fullPage: true,
    });
  } catch {}
} finally {
  const result = {
    schemaVersion: 1,
    baseUrl,
    videoPath,
    durationMs: Date.now() - startedAt,
    passed: !failure,
    failure,
    finalReport,
    events,
  };
  await fs.writeFile(
    path.join(outputDir, "live-fixed-video-e2e.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await browser.close();
  if (failure) process.exitCode = 1;
}
