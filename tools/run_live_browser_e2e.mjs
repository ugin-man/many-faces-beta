import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

const baseUrl = process.env.MANY_FACES_BASE_URL || "http://127.0.0.1:4173";
const videoPath = process.env.MANY_FACES_TEST_VIDEO;
const screenshotPath = process.env.MANY_FACES_SCREENSHOT || "work/live-browser-e2e.png";
const reportPath = process.env.MANY_FACES_REPORT || "work/live-browser-e2e.json";
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";

if (!videoPath) throw new Error("MANY_FACES_TEST_VIDEO is required");

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--use-gl=swiftshader",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
page.on("console", (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});
page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));

let result;
try {
  await page.goto(`${baseUrl}/live`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const root = page.locator('[data-testid="verification-root"]');
  await root.waitFor({ state: "visible", timeout: 30_000 });
  const bodyText = await page.locator("body").innerText();
  assert.ok(bodyText.trim().length > 80, "Review page rendered as an empty shell");

  const input = page.locator('[data-testid="verification-file-input"]');
  await input.waitFor({ state: "attached", timeout: 30_000 });
  await input.setInputFiles(videoPath);

  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="verification-root"]');
    return Boolean(window.__MANY_FACES_VERIFY__) || root?.getAttribute("data-state") === "error";
  }, undefined, { timeout: 12 * 60_000 });

  const state = await root.getAttribute("data-state");
  const verdict = await root.getAttribute("data-verdict");
  const runtimeReport = await page.evaluate(() => window.__MANY_FACES_VERIFY__ ?? null);
  const errorText = await page.locator('[data-testid="verification-root"]')
    .locator("p")
    .allInnerTexts();
  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyHeight: document.body.getBoundingClientRect().height,
    rootState: document.querySelector('[data-testid="verification-root"]')?.getAttribute("data-state"),
    outputCanvas: (() => {
      const canvas = document.querySelector('[data-testid="verification-output-canvas"]');
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      const data = canvas.getContext("2d")?.getImageData(
        0,
        0,
        Math.min(64, canvas.width),
        Math.min(64, canvas.height),
      ).data;
      let nonBlack = 0;
      if (data) {
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] + data[index + 1] + data[index + 2] > 45) nonBlack += 1;
        }
      }
      return {
        width: rect.width,
        height: rect.height,
        nonBlack,
      };
    })(),
  }));

  await page.screenshot({ path: screenshotPath, fullPage: true });
  result = {
    schemaVersion: 1,
    baseUrl,
    videoPath,
    state,
    verdict,
    runtimeReport,
    layout,
    consoleMessages,
    pageErrors,
    errorText,
  };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  assert.equal(state, "review", `Expected review state, received ${state}`);
  assert.equal(verdict, "passed", `Runtime gate did not pass: ${JSON.stringify(runtimeReport)}`);
  assert.ok(runtimeReport?.passed, "Runtime report is missing or failed");
  assert.ok(runtimeReport.faceCoverage >= 0.7, "Face coverage is below 70%");
  assert.equal(runtimeReport.sequenceFrames, runtimeReport.faceFrames);
  assert.ok(runtimeReport.canvasNonBlank, "Runtime reported a blank output canvas");
  assert.ok(layout.outputCanvas?.width > 100 && layout.outputCanvas?.height > 100);
  assert.ok((layout.outputCanvas?.nonBlack || 0) > 30, "Rendered canvas pixels are blank");
  assert.ok(layout.scrollWidth <= layout.viewportWidth + 2, "Desktop UI has horizontal overflow");
  assert.equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join("\n")}`);
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
