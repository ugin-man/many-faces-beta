import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve('.browser-tools/node_modules/playwright'));
const out = process.env.RECOVERY_REPORT_DIR || 'work/recovery-evidence';
await fs.mkdir(out, { recursive: true });
// A real HTTP response-body throttle, not fake landmarks, fake match results,
// or a modified application watchdog. Each 4-request lane receives real bytes.
function proxy(port, upstream, mode) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const slow = mode === 'catalog' ? req.url.startsWith('/api/catalog/shard') : req.url.includes('/api/mediapipe/') && req.url.endsWith('.wasm');
      const headers = { ...req.headers, host: `127.0.0.1:${upstream}`, 'accept-encoding': 'identity' };
      const remote = http.get({ host: '127.0.0.1', port: upstream, path: req.url, headers }, reply => {
        if (!slow) { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); return; }
        const chunks = [];
        reply.on('data', chunk => chunks.push(chunk));
        reply.on('end', () => {
          const body = Buffer.concat(chunks);
          const clean = { ...reply.headers, 'content-length': String(body.length), 'cache-control': 'no-store' };
          delete clean['transfer-encoding']; delete clean['content-encoding'];
          res.writeHead(reply.statusCode, clean); res.flushHeaders();
          let offset = 0;
          const timer = setInterval(() => {
            if (res.destroyed) { clearInterval(timer); return; }
            res.write(body.subarray(offset, offset + 32768)); offset += 32768;
            if (offset >= body.length) { clearInterval(timer); res.end(); }
          }, mode === 'catalog' ? 170 : 40);
          res.on('close', () => clearInterval(timer));
        });
      });
      remote.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
      res.on('close', () => remote.destroy());
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
const servers = [await proxy(4180, 4173, 'catalog'), await proxy(4181, 4175, 'catalog'), await proxy(4182, 4173, 'model')];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve('work/recovery-fixtures/moving.y4m')}`] });
const report = { currentCommit: process.env.GITHUB_SHA, baselineCommit: 'd9cbc1966a7c38847b231bdc963a0f9c7a0c13b1', physicalCameraVerified: false, hostedSiteVerified: false, cases: {}, passed: false };
const errors = [];
let active;
try {
  async function videoRun(port, name) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/live`, { waitUntil: 'networkidle' });
    await page.getByTestId('settings').click(); await page.getByTestId('analysis-fps').selectOption('12'); await page.getByRole('button', { name: '閉じる', exact: true }).click();
    const began = Date.now(); const samples = [];
    await page.getByTestId('video-input').setInputFiles(path.resolve('work/recovery-fixtures/one-second.mp4'));
    for (;;) {
      await page.waitForTimeout(1000);
      const state = await page.evaluate(() => ({ runtime: window.__MANY_FACES_RUNTIME__, result: window.__MANY_FACES_VERIFY__, alert: document.querySelector('[role="alert"]')?.textContent }));
      samples.push({ elapsed: Date.now() - began, ...state.runtime });
      if (state.result || state.runtime?.phase === 'error') {
        await page.screenshot({ path: `${out}/${name}.png` });
        const value = { seconds: (Date.now() - began) / 1000, runtime: state.runtime, alert: state.alert, result: state.result, samples };
        await context.close(); return value;
      }
      if (Date.now() - began > 330000) throw new Error(`${name}: verification exceeded bounded test duration`);
    }
  }
  const [baseline, current] = await Promise.all([videoRun(4181, 'baseline-slow-body'), videoRun(4180, 'repaired-slow-body')]);
  report.cases.baseline = baseline; report.cases.slowBody = current;
  assert.equal(baseline.runtime.phase, 'error'); assert.match(baseline.alert ?? "", /90秒/);
  assert.equal(current.result?.passed, true);
  assert.ok(current.samples.some(s => s.elapsed > 95000 && s.phase === 'searching' && s.completedFrames === 0 && s.receivedBytes > 0), 'Must exercise 90+ seconds of real loading before the first matched frame');
  assert.ok(current.result.searchTraffic.files >= 90, 'No silent shrink of the first-frame search neighborhood');
  assert.equal(current.result.sequenceFrames, current.result.faceFrames); assert.equal(current.result.imageFailures, 0);

  const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__streams = [];
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); window.__streams.push(stream); return stream; };
  });
  active = await context.newPage(); active.on('pageerror', error => errors.push(`camera: ${error.message}`));
  await active.goto('http://127.0.0.1:4182/live/astra');
  const began = Date.now(), startup = [];
  await active.getByTestId('camera-start').click();
  for (;;) {
    await active.waitForTimeout(500);
    const snapshot = await active.evaluate(() => window.__MANY_FACES_REALTIME__); startup.push({ elapsed: Date.now() - began, ...snapshot });
    assert.notEqual(snapshot.phase, 'error', JSON.stringify(snapshot));
    if (snapshot.outputChanges >= 3 && snapshot.frames >= 30) break;
    assert.ok(Date.now() - began < 120000, 'Camera test exceeded its deadline');
  }
  assert.ok(startup.some(s => s.elapsed > 8000 && s.phase === 'starting' && s.inFlight === 0 && s.receivedBytes > 0), 'Startup model work must stay outside the live frame watchdog');
  const camera = startup.at(-1); assert.equal(camera.delegate, 'CPU'); assert.equal(camera.catalogTotal, 70000); assert.equal(camera.workerBuild, camera.build);
  report.cases.camera = { snapshot: camera, startup };
  await active.screenshot({ path: `${out}/repaired-camera.png` });
  await active.getByTestId('stop').click();
  assert.ok(await active.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
  await active.getByTestId('camera-start').click(); await active.waitForFunction(() => window.__MANY_FACES_REALTIME__?.outputChanges > 0 || window.__MANY_FACES_REALTIME__?.phase === 'error', null, { timeout: 120000 });
  assert.equal((await active.evaluate(() => window.__MANY_FACES_REALTIME__)).phase, 'running');
  await active.getByTestId('mode-video').click(); await active.getByTestId('sample-video').waitFor();
  assert.ok(await active.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
  report.cases.lifecycle = 'stop/restart/mode-change track cleanup passed';
  await active.getByTestId('settings').click(); await active.getByRole('button', { name: '画像情報・診断', exact: true }).click();
  await active.getByTestId('runtime-identity').filter({ hasText: '一致' }).waitFor();
  report.cases.identity = await active.getByTestId('runtime-identity').textContent();
  await context.close();
  assert.equal(errors.length, 0, errors.join('\n')); report.passed = true;
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  if (active && !active.isClosed()) await active.screenshot({ path: `${out}/failure.png` }).catch(() => {});
} finally {
  report.pageErrors = errors;
  await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, (key, value) => key === 'samples' || key === 'startup' || key === 'sequenceIds' ? undefined : value, 2));
  await browser.close(); for (const server of servers) server.close();
}
