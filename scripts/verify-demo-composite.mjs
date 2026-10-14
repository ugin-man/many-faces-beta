import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(".browser-tools/node_modules/playwright"));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 850 } });
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
try {
  const routes = ["/demo", "/live", "/"];
  for (const route of routes) {
    await page.goto(`http://127.0.0.1:4173${route}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings").click();
    const mode = page.getByTestId("face-display-mode");
    await mode.waitFor();
    assert.equal(await mode.inputValue(), "demo", `${route} must open in face composite mode`);
    assert.equal(await mode.locator("option:checked").textContent(), "動画に顔を合成");
    await page.getByRole("button", { name: "閉じる" }).click();
    assert.equal(await page.getByTestId("source-pip").getAttribute("data-visible"), "false");
  }

  await page.getByTestId("sample-video").click();
  await page.getByTestId("demo-save-image").waitFor({ timeout: 900000 });
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId("source-pip").getAttribute("data-visible"), "false");
  const canvas = page.getByTestId("output-canvas");
  const sample = await canvas.evaluate(element => {
    const c = element, ctx = c.getContext("2d");
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonblack = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 28 || pixels[i + 1] > 28 || pixels[i + 2] > 28) nonblack++;
    return { nonblack, total: pixels.length / 4 };
  });
  assert.ok(sample.nonblack > sample.total * .04, "Composite should show source background and a replacement face");
  const png = page.waitForEvent("download", { timeout: 15000 });
  await page.getByTestId("demo-save-image").click();
  const imageDownload = await png;
  assert.equal(imageDownload.suggestedFilename(), "many-faces-composite.png");

  const reportDownloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.getByTestId("demo-report-photo").click();
  const reportDownload = await reportDownloadPromise;
  assert.equal(reportDownload.suggestedFilename(), "many-faces-wrong-photo.json");
  const reportPath = path.join("work/demo-evidence", "wrong-photo.json");
  await fs.mkdir("work/demo-evidence", { recursive: true });
  await reportDownload.saveAs(reportPath);
  const reported = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.match(reported.imageId, /^clean-v5-/);
  assert.equal(reported.reportReason, "wrong-facing-photo");
  assert.equal(Object.hasOwn(reported, "videoBytes"), false);
  assert.equal(Object.hasOwn(reported, "imageBytes"), false);
  const exportButton = page.getByTestId("demo-export-video");
  const videoDownloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await exportButton.click();
  const videoDownload = await videoDownloadPromise;
  assert.match(videoDownload.suggestedFilename(), /^many-faces-composite\.(webm|mp4)$/);
  const output = path.join("work/demo-evidence", videoDownload.suggestedFilename());
  await fs.mkdir("work/demo-evidence", { recursive: true });
  await videoDownload.saveAs(output);
  assert.ok((await fs.stat(output)).size > 2000);
  await page.screenshot({ path: "work/demo-evidence/demo.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await page.getByRole("group", { name: "操作", exact: true }).getByRole("button").all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844,
      `${await button.textContent()} must remain reachable on a phone`);
  }
  await page.screenshot({ path: "work/demo-evidence/mobile.png" });
  await fs.writeFile("work/demo-evidence/report.json", JSON.stringify({
    routes, exportRoute: "/", mobileControlsInViewport: true,
    sourcePiPHidden: true, defaultMode: "demo", outputNonblackPixels: sample.nonblack,
    savedImage: imageDownload.suggestedFilename(), savedVideo: videoDownload.suggestedFilename(),
    pageErrors: errors,
  }, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("DEMO_QA_PASS", JSON.stringify({ sample, savedVideo: videoDownload.suggestedFilename() }));
} finally {
  await browser.close();
}
