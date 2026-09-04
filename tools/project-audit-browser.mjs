import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.AUDIT_BASE_URL || "http://127.0.0.1:3000";
const fixture = path.resolve(process.env.AUDIT_VIDEO || "work/reference-face-motion.webm");
const output = path.resolve(process.env.AUDIT_OUTPUT || "work/project-audit/browser");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl", "--autoplay-policy=no-user-gesture-required"] });
const result = { schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA || null, runtime: process.env.AUDIT_RUNTIME || "unspecified", browser: browser.version(), fixtureSha256: crypto.createHash("sha256").update(await fs.readFile(fixture)).digest("hex"), cases: [] };
const state = (page) => page.getByTestId("verification-root").getAttribute("data-state");
async function open(page) {
  const response = await page.goto(`${base}/live`, { waitUntil: "domcontentloaded" });
  assert.ok(response.ok());
  await page.getByTestId("verification-root").waitFor({ state: "visible" });
}
async function waitState(page, target, timeout = 300_000) {
  await page.waitForFunction((wanted) => {
    const phase = document.querySelector('[data-testid="verification-root"]')?.getAttribute("data-state");
    return phase === wanted || phase === "error";
  }, target, { timeout, polling: 500 });
  assert.equal(await state(page), target, (await page.locator("body").innerText()).slice(-2000));
}
async function run(name, width, height, fn) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "ja-JP" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const entry = { name, width, height, startedAt: new Date().toISOString(), pageErrors: [], writeRequests: [], wasm: [], passed: false };
  page.on("pageerror", (error) => entry.pageErrors.push(String(error)));
  page.on("request", (request) => { if (["POST", "PUT", "PATCH"].includes(request.method())) entry.writeRequests.push({ method: request.method(), url: request.url() }); });
  page.on("response", (response) => { if (new URL(response.url()).pathname.endsWith(".wasm")) entry.wasm.push({ status: response.status(), mime: response.headers()["content-type"] }); });
  try {
    await fn(page, entry);
    assert.deepEqual(entry.pageErrors, []);
    assert.deepEqual(entry.writeRequests, [], "input video must not be uploaded");
    entry.passed = true;
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  } catch (error) {
    entry.failure = String(error?.stack || error);
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
  } finally {
    entry.finishedAt = new Date().toISOString();
    result.cases.push(entry);
    console.log("BROWSER_CASE", JSON.stringify(entry));
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2));
    await context.close();
  }
  return entry.passed;
}
const positive = async (page, entry, fps) => {
  await open(page);
  await page.getByLabel("解析密度", { exact: true }).selectOption(String(fps));
  await page.getByTestId("verification-file-input").setInputFiles(fixture);
  await waitState(page, "review");
  const report = await page.evaluate(() => window.__MANY_FACES_VERIFY__);
  assert.ok(report?.passed, JSON.stringify(report));
  assert.equal(report.sourceName, path.basename(fixture));
  assert.equal(report.plannedFrames, fps * 5);
  assert.equal(report.sequenceFrames, report.faceFrames);
  assert.equal(report.sequenceIds.length, report.faceFrames);
  assert.equal(report.imageFailures, 0);
  assert.equal(report.outputChanges, report.sequenceFrames - 1);
  assert.ok(report.faceCoverage >= 0.7);
  assert.ok(report.canvasNonBlank);
  assert.ok(entry.wasm.length > 0);
  assert.ok(entry.wasm.every((item) => item.status === 200 && item.mime?.startsWith("application/wasm")), JSON.stringify(entry.wasm));
  assert.equal(await page.getByLabel("再生", { exact: true }).inputValue(), String(fps));
  entry.report = report;
  entry.layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(entry.layout.document <= entry.layout.viewport + 2);
  const pixels = () => page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="verification-output-canvas"]');
    const bytes = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < bytes.length; i += 997) hash = (hash * 31 + bytes[i]) | 0;
    return hash;
  });
  const before = await pixels();
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForTimeout(1200);
  assert.notEqual(await pixels(), before, "rendered output must change, not merely its counters");
  await page.waitForTimeout(4300);
  const playback = await page.evaluate(() => {
    const video = [...document.querySelectorAll("video")].find((v) => Boolean(v.getAttribute("src")));
    return { time: video.currentTime, paused: video.paused, duration: video.duration };
  });
  assert.ok(playback.duration > 6, "fixture must exercise a video longer than the reviewed clip");
  assert.ok(playback.paused && playback.time >= 4.9 && playback.time <= 5.01, JSON.stringify(playback));
  entry.playbackBoundary = playback;
  await page.getByRole("button", { name: "再生", exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "一時停止", exact: true }).click();
  await page.getByRole("button", { name: "+1 frame", exact: true }).click();
  await page.waitForTimeout(250);
};
try {
  await run("invalid-input-and-late-camera-cancel", 1440, 1000, async (page) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => {
        window.__releaseAuditCamera = () => resolve({ getTracks: () => [{ stop() { window.__auditTrackStopped = true; } }] });
      });
    });
    await open(page);
    await page.getByTestId("verification-file-input").setInputFiles({ name: "empty.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(0) });
    await waitState(page, "error", 5_000);
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "リセット", exact: true }).click();
    assert.equal(await state(page), "idle");
    await page.getByRole("button", { name: "カメラで5秒（実験）", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__releaseAuditCamera));
    await page.getByRole("button", { name: "リセット", exact: true }).click();
    await page.evaluate(() => window.__releaseAuditCamera());
    await page.waitForFunction(() => window.__auditTrackStopped === true);
    assert.equal(await state(page), "idle");
    assert.equal(await page.evaluate(() => window.__MANY_FACES_VERIFY__), undefined);
  });
  const first = await run("desktop-12fps", 1440, 1000, (page, entry) => positive(page, entry, 12));
  if (first) {
    await run("desktop-20fps", 1440, 1000, (page, entry) => positive(page, entry, 20));
    await run("desktop-30fps", 1440, 1000, (page, entry) => positive(page, entry, 30));
    await run("mobile-viewport-12fps", 390, 844, (page, entry) => positive(page, entry, 12));
    await run("cancel-image-preload-and-reselect-same-file", 1440, 1000, async (page, entry) => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let intercepted = 0;
      await page.route("**/api/catalog/image?*", async (route) => {
        intercepted++;
        await held;
        await route.continue().catch(() => undefined);
      });
      await open(page);
      await page.getByTestId("verification-file-input").setInputFiles(fixture);
      await waitState(page, "preloading");
      assert.ok(intercepted > 0);
      await page.getByRole("button", { name: "リセット", exact: true }).click();
      release();
      await page.waitForTimeout(1000);
      assert.equal(await state(page), "idle");
      assert.equal(await page.evaluate(() => window.__MANY_FACES_VERIFY__), undefined);
      await page.unroute("**/api/catalog/image?*");
      await page.getByTestId("verification-file-input").setInputFiles(fixture);
      await waitState(page, "review");
      entry.report = await page.evaluate(() => window.__MANY_FACES_VERIFY__);
      assert.ok(entry.report.passed);
    });
  }
} finally {
  result.passed = result.cases.length === 6 && result.cases.every((entry) => entry.passed);
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log("BROWSER_SUMMARY", JSON.stringify({ passed: result.passed, cases: result.cases.map(({ name, passed, failure }) => ({ name, passed, failure })) }));
  await browser.close();
  if (!result.passed) process.exitCode = 1;
}
