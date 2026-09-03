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
const expectedVideoName = path.basename(videoPath);

await fs.mkdir(outputDir, { recursive: true });

const events = [];
const criticalConsoleErrors = [];
const performanceWarnings = [];
const mediapipeWasmResponses = [];
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

function warn(code, payload = {}) {
  const warning = { code, ...payload };
  performanceWarnings.push(warning);
  record("warning", warning);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-dev-shm-usage",
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
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
  const text = message.text().slice(0, 2_000);
  record("console", { level: message.type(), text });
  if (
    text.includes("wasm streaming compile failed") ||
    text.includes("Incorrect response MIME type")
  ) {
    warn("MEDIAPIPE_WASM_STREAMING_FALLBACK", { text });
  }
});
page.on("pageerror", (error) => {
  const message = String(error?.stack || error).slice(0, 4_000);
  criticalConsoleErrors.push(message);
  record("pageerror", { message });
});
page.on("requestfailed", (request) => {
  const url = request.url();
  const reason = request.failure()?.errorText || "unknown";
  // Loading a file into an existing <video> can abort the previous blob URL.
  // Keep it as evidence, but do not treat this browser behaviour as a failure.
  record("requestfailed", { url, reason });
});
page.on("response", (response) => {
  const url = response.url();
  if (url.includes("/mediapipe/") && url.endsWith(".wasm")) {
    const entry = {
      url,
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
    };
    mediapipeWasmResponses.push(entry);
    record("mediapipe-wasm", entry);
  }
  if (response.status() >= 400) {
    record("http-error", { status: response.status(), url });
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
  record("fixture-submitted", { videoPath, expectedVideoName });

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
  if (finalReport.sourceName !== expectedVideoName) {
    throw new Error(
      `VERIFICATION_SOURCE_MISMATCH_${finalReport.sourceName}_EXPECTED_${expectedVideoName}`,
    );
  }
  if (!finalReport.canvasNonBlank) throw new Error("OUTPUT_CANVAS_IS_BLANK");
  if (Number(finalReport.faceCoverage) < 0.7) {
    throw new Error(`FACE_COVERAGE_TOO_LOW_${finalReport.faceCoverage}`);
  }
  if (Number(finalReport.sequenceFrames) !== Number(finalReport.faceFrames)) {
    throw new Error("SEQUENCE_FRAME_COUNT_MISMATCH");
  }
  if (Number(finalReport.imageFailures) !== 0) {
    throw new Error(`OUTPUT_IMAGE_FAILURES_${finalReport.imageFailures}`);
  }
  if (!Array.isArray(finalReport.sequenceIds) || !finalReport.sequenceIds.length) {
    throw new Error("SEQUENCE_IDS_MISSING");
  }
  if (!finalReport.sequenceFingerprint) {
    throw new Error("SEQUENCE_FINGERPRINT_MISSING");
  }
  if (criticalConsoleErrors.length) {
    throw new Error(`BROWSER_PAGE_ERRORS: ${criticalConsoleErrors.join(" | ")}`);
  }
  if (!mediapipeWasmResponses.length) {
    throw new Error("MEDIAPIPE_WASM_RESPONSE_MISSING");
  }
  const failedWasm = mediapipeWasmResponses.filter((entry) => entry.status !== 200);
  if (failedWasm.length) {
    throw new Error(`MEDIAPIPE_WASM_HTTP_FAILED: ${JSON.stringify(failedWasm)}`);
  }
  const fallbackWasm = mediapipeWasmResponses.filter(
    (entry) => !entry.contentType.startsWith("application/wasm"),
  );
  if (fallbackWasm.length) {
    warn("MEDIAPIPE_WASM_NONSTREAMING_MIME", { responses: fallbackWasm });
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

  const playButton = page.getByRole("button", { name: "再生", exact: true });
  if (!(await playButton.isVisible())) {
    throw new Error("REVIEW_PLAY_BUTTON_MISSING");
  }
  await playButton.click();
  await page.waitForTimeout(1_200);
  const playbackTime = await page.evaluate(() => {
    const videos = [...document.querySelectorAll("video")];
    return Math.max(0, ...videos.map((video) => Number(video.currentTime || 0)));
  });
  if (playbackTime <= 0.05) throw new Error("REVIEW_PLAYBACK_DID_NOT_ADVANCE");
  record("playback-advanced", { playbackTime });

  await page.screenshot({
    path: path.join(outputDir, "live-fixed-video-pass.png"),
    fullPage: true,
  });
  record("pass", {
    finalReport,
    layout,
    mediapipeWasmResponses,
    performanceWarnings,
  });
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
    schemaVersion: 4,
    baseUrl,
    videoPath,
    expectedVideoName,
    durationMs: Date.now() - startedAt,
    passed: !failure,
    failure,
    finalReport,
    criticalConsoleErrors,
    performanceWarnings,
    mediapipeWasmResponses,
    events,
  };
  await fs.writeFile(
    path.join(outputDir, "live-fixed-video-e2e.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await browser.close();
  if (failure) process.exitCode = 1;
}
