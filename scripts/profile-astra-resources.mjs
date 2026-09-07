import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve('.browser-tools/node_modules/playwright'));
const base = process.env.MANY_FACES_BASE_URL || 'http://127.0.0.1:4173';
const out = path.resolve(process.env.MANY_FACES_BROWSER_REPORT_DIR || 'work/astra-evidence/production');
await fs.mkdir(out, { recursive: true });

const groups = [
  ['catalogManifest', '/api/catalog/manifest'],
  ['catalogShard', '/api/catalog/shard'],
  ['catalogImage', '/api/catalog/image'],
  ['mediapipe', '/api/mediapipe'],
];

function summarize(entries) {
  const durations = entries.map((entry) => entry.duration).sort((a, b) => a - b);
  const percentile = (fraction) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)] : 0;
  return {
    count: entries.length,
    durationTotalMs: Math.round(entries.reduce((sum, entry) => sum + entry.duration, 0)),
    durationP50Ms: Math.round(percentile(.5)),
    durationP95Ms: Math.round(percentile(.95)),
    transferBytes: entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    encodedBodyBytes: entries.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
    decodedBodyBytes: entries.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
  };
}

let browser;
const report = {
  schemaVersion: 1,
  testedCommit: process.env.GITHUB_SHA || null,
  catalogTarget: 'full-70000',
  route: '/live/astra',
  physicalCameraVerified: false,
  purpose: 'Measure resource/request pressure without changing application behavior.',
};

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`,
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 920 }, permissions: ['camera'] });
  const page = await context.newPage();
  const responseStats = new Map();
  page.on('response', async (response) => {
    const pathname = new URL(response.url()).pathname;
    const group = groups.find(([, prefix]) => pathname.startsWith(prefix))?.[0] || 'other';
    if (group === 'other') return;
    const headers = await response.allHeaders().catch(() => ({}));
    const item = responseStats.get(group) || { responses: 0, statuses: {}, contentLengths: 0, partial206: 0, full200: 0 };
    item.responses += 1;
    item.statuses[response.status()] = (item.statuses[response.status()] || 0) + 1;
    const length = Number(headers['content-length'] || 0);
    if (Number.isFinite(length)) item.contentLengths += length;
    if (response.status() === 206) item.partial206 += 1;
    if (response.status() === 200) item.full200 += 1;
    responseStats.set(group, item);
  });

  await page.goto(base + '/live/astra', { waitUntil: 'networkidle' });
  await page.getByTestId('camera-start').click();
  await page.waitForFunction(() => window.__MANY_FACES_REALTIME__?.phase === 'error' || (window.__MANY_FACES_REALTIME__?.outputChanges > 0 && window.__MANY_FACES_REALTIME__?.frames >= 10), null, { timeout: 65000 });
  const initial = await page.evaluate(() => window.__MANY_FACES_REALTIME__);
  if (initial?.phase !== 'running') throw new Error(`Runtime failed: ${initial?.message || 'unknown'}`);
  await page.waitForTimeout(15000);
  report.runtime = await page.evaluate(() => window.__MANY_FACES_REALTIME__);
  report.performanceResources = await page.evaluate((definitions) => {
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      initiatorType: entry.initiatorType,
    }));
    const output = {};
    for (const [label, prefix] of definitions) {
      output[label] = resources.filter((entry) => new URL(entry.name).pathname.startsWith(prefix));
    }
    return output;
  }, groups);
  report.resourceSummary = Object.fromEntries(Object.entries(report.performanceResources).map(([key, entries]) => [key, summarize(entries)]));
  report.responseSummary = Object.fromEntries(responseStats);
  report.totals = {
    trackedRequests: Object.values(report.resourceSummary).reduce((sum, value) => sum + value.count, 0),
    trackedTransferBytes: Object.values(report.resourceSummary).reduce((sum, value) => sum + value.transferBytes, 0),
    trackedEncodedBodyBytes: Object.values(report.resourceSummary).reduce((sum, value) => sum + value.encodedBodyBytes, 0),
  };
  report.observations = {
    imageRequestsPerOutputChange: report.runtime?.outputChanges ? (report.resourceSummary.catalogImage?.count || 0) / report.runtime.outputChanges : null,
    shardRequestsPerProcessedFrame: report.runtime?.frames ? (report.resourceSummary.catalogShard?.count || 0) / report.runtime.frames : null,
  };
  await page.getByTestId('stop').click();
  await context.close();
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fs.writeFile(path.join(out, 'resource-profile.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
