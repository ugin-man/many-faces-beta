import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve('.browser-tools/node_modules/playwright'));
const base = process.env.MANY_FACES_BASE_URL || 'http://127.0.0.1:4173';
const out = path.resolve(process.env.MANY_FACES_BROWSER_REPORT_DIR || 'work/astra-evidence');
await fs.mkdir(out, { recursive:true });
const report = { testedCommit:process.env.GITHUB_SHA || null, route:'/live/astra', input:'native-getUserMedia-with-file-backed-virtual-camera', physicalCameraVerified:false, privateUserVideoUsed:false, measurements:[], checks:{}, pageErrors:[], consoleErrors:[] };
let browser;
let activePage;
function assert(value, message) { if (!value) throw new Error(message); }
const snapshot = (page) => page.evaluate(() => window.__MANY_FACES_REALTIME__);
async function waitForOutput(page) {
  await page.waitForFunction(() => window.__MANY_FACES_REALTIME__?.phase === 'error' || (window.__MANY_FACES_REALTIME__?.outputChanges > 0 && window.__MANY_FACES_REALTIME__?.frames >= 10), null, { timeout:65000 });
  const state = await snapshot(page);
  assert(state.phase === 'running', `Runtime failed: ${state.message}`);
  return state;
}
async function trackStreams(context) {
  await context.addInitScript(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__testStreams = [];
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await native(...args);
      window.__testStreams.push(stream);
      return stream;
    };
  });
}
try {
  browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome', headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream',`--use-file-for-fake-video-capture=${path.resolve('work/astra-fixtures/moving.y4m')}`] });
  const context = await browser.newContext({ viewport:{width:1280,height:920}, permissions:['camera'] });
  await trackStreams(context);
  const page = activePage = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(base + '/live/astra', { waitUntil:'networkidle' });
  await page.getByTestId('camera-start').click();
  await waitForOutput(page);
  await page.waitForTimeout(8000);
  const live = await snapshot(page);
  assert(live.frames >= 20 && live.faceFrames >= 15, 'Insufficient real inference frames');
  assert(live.outputChanges >= 2, 'Output did not respond to changing camera input');
  assert(live.maxInFlight === 1, 'Frame pipeline exceeded single-flight bound');
  assert(live.pendingImages <= 3 && live.imageBytes <= 32 * 1024 * 1024, 'Image cache exceeded its bound');
  const pixels = await page.getByTestId('output-canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let visible=0; for (let i=0;i<pixels.length;i+=4) if (pixels[i]+pixels[i+1]+pixels[i+2]>100) visible++;
    return visible / (pixels.length/4);
  });
  assert(pixels > .05, 'Output canvas is blank');
  report.measurements.push({name:'desktop-native-virtual-camera', ...live, visiblePixelRatio:pixels});
  await page.screenshot({path:path.join(out,'desktop-realtime.png'), fullPage:true});
  await page.getByTestId('stop').click();
  await page.waitForTimeout(400);
  assert((await snapshot(page)).phase === 'idle', 'Stop did not return to idle');
  assert(await page.evaluate(() => window.__testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Stop leaked a camera track');
  report.checks.stopReleasesTracks = true;
  await page.getByTestId('camera-start').click();
  await waitForOutput(page);
  report.checks.restartProducesOutput = true;
  await page.getByTestId('stop').click();

  // A real native camera promise is delayed only to inject a late permission
  // result. Neither the model, the landmarks nor the output are mocked.
  await page.evaluate(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => { const stream=await real(...args); await new Promise((resolve)=>setTimeout(resolve,700)); return stream; };
  });
  await page.getByTestId('camera-start').click();
  await page.getByTestId('stop').click();
  await page.waitForTimeout(1500);
  assert((await snapshot(page)).phase === 'idle', 'Late permission restarted a cancelled session');
  assert(await page.evaluate(() => window.__testStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Late permission leaked a track');
  report.checks.latePermissionCancelled = true;
  await context.close();

  const mobile = await browser.newContext({viewport:{width:390,height:844},permissions:['camera']});
  const mp = activePage = await mobile.newPage();
  await mp.goto(base + '/live/astra', {waitUntil:'networkidle'});
  await mp.getByTestId('camera-start').click();
  await waitForOutput(mp);
  const layout = await mp.evaluate(() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
  assert(layout.scrollWidth <= layout.width, 'Mobile layout overflows horizontally');
  report.measurements.push({name:'390x844-native-virtual-camera',...await snapshot(mp),layout});
  await mp.screenshot({path:path.join(out,'mobile-realtime.png'),fullPage:true});
  await mp.getByTestId('stop').click();
  report.checks.mobileViewport = true;
  await mobile.close();

  const denied = await browser.newContext({viewport:{width:800,height:700}});
  const dp = activePage = await denied.newPage();
  await dp.goto(base + '/live/astra');
  await dp.getByTestId('camera-start').click();
  await dp.waitForFunction(() => window.__MANY_FACES_REALTIME__?.phase === 'error',null,{timeout:30000});
  assert((await snapshot(dp)).message.includes('許可'), 'Permission denial was not explained');
  assert(await dp.getByTestId('camera-start').isEnabled(), 'Cannot retry after permission denial');
  report.checks.permissionDeniedRecoverable = true;
  await denied.close();
  report.checks.nonBlankCanvas = true;
  report.checks.boundedInFlight = true;
  report.checks.boundedImageMemory = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  if (activePage && !activePage.isClosed()) {
    report.failureSnapshot = await snapshot(activePage).catch(() => null);
    await activePage.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(() => {});
  }
} finally {
  await fs.writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close();
}
if (!report.passed) process.exitCode = 1;
