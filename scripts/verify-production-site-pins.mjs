import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// This receipt is separate from the unchanged fullscreen harness's native report.
// No authentication, application mutation, synthetic result, or image transformation.
const PINS = Object.freeze({
  url: 'https://many-faces-prototype.uginn-poppo.chatgpt.site',
  siteVersion: 55,
  deployedSourceCommit: 'da44953c7b671d2826d3ff4b1645a508545b22d6',
  runtimeBuild: '8b57a414f760f03f',
  runtimeVersion: 'camera-arrival-v3',
  manifestSha256: 'fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a',
  catalogId: 'many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1',
  winkIndexSha256: '7282c665512ff514877e78247e1d0647835a333497201cab79fb21c3fe57fa76',
  ordinaryCell: '0:0',
  ordinaryShard: 'clean_v3_yaw_p000_pitch_p000_000.json',
  ordinaryShardSha256: '326a6227e69b528bab4bb64de497e9fef87b2d25fd04800c8953210abe5f09b3',
  ordinaryShardBytes: 2196027,
  ordinaryImageId: 'clean-v5-dab8705c59901d78003f083cd86e',
  harnessSha256: '7f39301a5c655ee8d49549179d4fef9b1de8239f21c4dcf0eb076d6fc3bb9124',
  fixtureSha256: 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b',
  fixtureBytes: 14042765,
});
const phase = process.argv[2];
assert(['pre', 'post', 'receipt'].includes(phase) && process.argv.length === 3,
  'Usage: node scripts/verify-production-site-pins.mjs pre|post|receipt');
const out = path.resolve('work/production-site-v55');
await fs.mkdir(out, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = async (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const readJson = async name => JSON.parse(await fs.readFile(path.join(out, name), 'utf8'));
const sourceFile = async name => {
  const bytes = await fs.readFile(name);
  return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
};
async function sourceEvidence() {
  assert.equal(process.env.MANY_FACES_BASE_URL, PINS.url, 'Unchanged harness targets the exact same public origin');
  assert.equal(path.resolve(process.env.FULLSCREEN_REPORT_DIR), path.join(out, 'harness'));
  assert(!process.env.MANY_FACES_CAMERA_FIXTURE || path.resolve(process.env.MANY_FACES_CAMERA_FIXTURE) === path.resolve('work/fullscreen-fixtures/moving.y4m'));
  const harness = await sourceFile('scripts/verify-fullscreen-ui.mjs');
  const fixture = await sourceFile('public/test-fixtures/reference-face-motion.mp4');
  assert.equal(harness.sha256, PINS.harnessSha256, 'Existing harness must be byte-for-byte unchanged');
  assert.equal(fixture.sha256, PINS.fixtureSha256, 'Original local fixture SHA');
  assert.equal(fixture.bytes, PINS.fixtureBytes, 'Original local fixture length');
  return {
    checkoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harness, fixture, packageLock: await sourceFile('package-lock.json'),
    receiptHelper: await sourceFile('scripts/verify-production-site-pins.mjs'),
    workflow: await sourceFile('.github/workflows/production-site-check.yml'),
    virtualCamera: await sourceFile('work/fullscreen-fixtures/moving.y4m'),
    node: process.version,
    chrome: execFileSync(process.env.CHROME_PATH, ['--version'], { encoding: 'utf8' }).trim(),
    playwright: JSON.parse(await fs.readFile('.browser-tools/node_modules/playwright/package.json', 'utf8')).version,
  };
}
async function snapshot() {
  const record = { phase, pins: PINS, startedAt: new Date().toISOString(), passed: false, responses: [] };
  await fs.mkdir(path.join(out, phase));
  async function get(label, relative, { expectedSha256, expectedBytes, maximumBytes, save = true }) {
    const url = new URL(relative, PINS.url);
    assert.equal(url.origin, PINS.url, 'Only the exact already-published HTTPS origin is allowed');
    const response = await fetch(url, {
      redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'cache-control': 'no-cache', accept: '*/*' },
    });
    assert.equal(response.status, 200, `${label}: HTTP 200 required`);
    assert.equal(response.url, url.href, `${label}: no redirect`);
    let count = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      count += chunk.length;
      assert(count <= maximumBytes, `${label}: bounded response exceeded`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const observed = {
      label, url: url.href, finalUrl: response.url, status: response.status,
      observedAt: new Date().toISOString(), bytes: bytes.length, sha256: sha256(bytes),
      headers: Object.fromEntries(['content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'age', 'cf-cache-status']
        .map(key => [key, response.headers.get(key)])),
    };
    record.responses.push(observed);
    if (save) {
      observed.bodyPath = `${phase}/${label}`;
      await fs.writeFile(path.join(out, observed.bodyPath), bytes, { flag: 'wx' });
    }
    if (expectedSha256 !== undefined) assert.equal(observed.sha256, expectedSha256, `${label}: exact response SHA`);
    if (expectedBytes !== undefined) assert.equal(bytes.length, expectedBytes, `${label}: exact response bytes`);
    return bytes;
  }
  try {
    record.source = await sourceEvidence();
    assert.equal(record.source.playwright, '1.56.1');
    await get('entrypoint.html', '/', { maximumBytes: 4 * 1024 * 1024 });
    const runtimeBytes = await get('runtime.json', '/api/runtime', { maximumBytes: 16384 });
    record.runtime = JSON.parse(runtimeBytes);
    assert.equal(record.runtime.version, PINS.runtimeVersion);
    assert.equal(record.runtime.build, PINS.runtimeBuild);
    assert.equal(record.runtime.revision, PINS.deployedSourceCommit, 'Actual served revision must match v55 source');
    const manifestBytes = await get('manifest-api.json', '/api/catalog/manifest?source=seed', {
      expectedSha256: PINS.manifestSha256, maximumBytes: 2 * 1024 * 1024,
    });
    const manifest = JSON.parse(manifestBytes);
    await get('manifest-static.json', '/seed-catalog/manifest.json', {
      expectedSha256: PINS.manifestSha256, expectedBytes: manifestBytes.length, maximumBytes: 2 * 1024 * 1024,
    });
    assert.equal(manifest.catalogId, PINS.catalogId);
    assert.equal(manifest.totalFaces, 70000);
    assert.equal(manifest.searchableFaces, 70000);
    assert.equal(manifest.qualityAdmission.schemaVersion, 2);
    assert.equal(manifest.qualityAdmission.status, 'complete');
    assert.equal(manifest.qualityAdmission.runtimeExclusionOverlayRequired, false);
    const wink = JSON.parse(await get('wink-index.json', `/wink-support/v1/catalog.json?catalog=${PINS.manifestSha256}`, {
      expectedSha256: PINS.winkIndexSha256, maximumBytes: 2 * 1024 * 1024,
    }));
    assert.equal(wink.schemaVersion, 3);
    assert.equal(wink.baseCatalogId, manifest.catalogId);
    assert.equal(wink.baseCatalogManifestSha256, PINS.manifestSha256);
    assert.equal(wink.policySha256, manifest.qualityAdmission.policySha256);
    assert.equal(wink.winkExpressionReviewSha256, manifest.winkExpressionReview.reviewSha256);
    assert.equal(wink.items.length, 71);
    assert.equal(wink.originalFaces, 70000);
    assert.equal(wink.addedPhotographs, 0);
    assert(wink.items.every(row => row.supportKind === 'core-refresh' && !Object.hasOwn(row, 'image')));
    await get('served-fixture.mp4', '/test-fixtures/reference-face-motion.mp4', {
      expectedSha256: PINS.fixtureSha256, expectedBytes: PINS.fixtureBytes,
      maximumBytes: 16 * 1024 * 1024, save: false,
    });
    assert.equal(manifest.cells[PINS.ordinaryCell].shards[0], PINS.ordinaryShard);
    const shardQuery = new URLSearchParams({ source: 'seed', file: PINS.ordinaryShard, catalog: manifest.catalogId });
    const shard = JSON.parse(await get('ordinary-shard.json', `/api/catalog/shard?${shardQuery}`, {
      expectedSha256: PINS.ordinaryShardSha256, expectedBytes: PINS.ordinaryShardBytes, maximumBytes: 4 * 1024 * 1024,
    }));
    const ordinary = shard.items.find(row => row.id === PINS.ordinaryImageId);
    assert(ordinary && !['winkLeft', 'winkRight'].includes(ordinary.cleanProfile));
    const samples = [
      ['ordinary', ordinary],
      ['wink-left', wink.items.find(row => row.side === 'left')],
      ['wink-right', wink.items.find(row => row.side === 'right')],
    ];
    record.rangedImageProbes = [];
    for (const [label, entry] of samples) {
      assert(entry && /^[a-z0-9_.-]+\.bin$/i.test(entry.pack));
      assert(Number.isSafeInteger(entry.offset) && entry.offset >= 0);
      assert(Number.isSafeInteger(entry.length) && entry.length > 0 && entry.length <= 2 * 1024 * 1024);
      assert(/^[a-f0-9]{64}$/.test(entry.admissionSha256));
      if (label !== 'ordinary') assert.equal(entry.imageSha256, entry.admissionSha256);
      const query = new URLSearchParams({ source: 'seed', pack: entry.pack, offset: String(entry.offset), length: String(entry.length) });
      await get(`${label}.webp`, `/api/catalog/image?${query}`, {
        expectedSha256: entry.admissionSha256, expectedBytes: entry.length, maximumBytes: 2 * 1024 * 1024,
      });
      record.rangedImageProbes.push({ label, id: entry.id, pack: entry.pack, offset: entry.offset,
        length: entry.length, encodedSha256: entry.admissionSha256, sourceCatalogId: entry.sourceCatalogId });
    }
    record.passed = true;
  } catch (error) {
    record.error = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    record.finishedAt = new Date().toISOString();
    await jsonFile(`${phase}/evidence.json`, record);
    console.log(JSON.stringify({ phase, passed: record.passed, responses: record.responses.length, error: record.error }));
  }
}
async function receipt() {
  const value = {
    schemaVersion: 1, documentKind: 'many-faces-published-site-regression',
    pins: PINS, recordedAt: new Date().toISOString(), passed: false,
    workflowRunId: process.env.GITHUB_RUN_ID, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowCommit: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY,
    stepOutcomes: { pre: process.env.PRE_OUTCOME, browser: process.env.BROWSER_OUTCOME, post: process.env.POST_OUTCOME },
    physicalCameraVerified: false, cuaBrowserVerified: false, independentQualityReviewPerformed: false,
    strict20FpsComparisonPerformed: false,
    nativeBrowserFlags: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=<exact source.virtualCamera path>'],
    scope: 'Actual pinned public Site; unchanged full-fixture 12fps fullscreen harness, two modes, virtual camera, paired mirror and cancellation.',
    limitations: [
      'Native harness hostedSiteVerified:false is preserved verbatim; this separate receipt records the actual public origin and fetched evidence.',
      'Site version 55 is the root-authenticated deployment pin; the public runtime independently supplies build and source revision.',
      'Preflight reads can warm remote assets; timings are not a cold-start benchmark.',
      'Only three exact image ranges and one complete shard are probed; this is not another physical 70000-image validation or manual review.',
      'This 12fps run does not repeat the strict 20fps/466-frame comparison, numeric tracking matrix or face-only invariance gates.',
    ],
  };
  try {
    const pre = await readJson('pre/evidence.json'), post = await readJson('post/evidence.json');
    value.pre = await sourceFile(path.join(out, 'pre/evidence.json'));
    value.post = await sourceFile(path.join(out, 'post/evidence.json'));
    const reportPath = path.join(out, 'harness/report.json');
    value.nativeReport = await sourceFile(reportPath);
    const native = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    value.nativeSummary = { passed: native.passed, hostedSiteVerified: native.hostedSiteVerified,
      physicalCameraVerified: native.physicalCameraVerified, error: native.error,
      video: native.video, camera: native.camera, checks: native.checks, pageErrors: native.pageErrors };
    value.nativeExitCode = Number((await fs.readFile(path.join(out, 'harness-exit-code.txt'), 'utf8')).trim());
    assert.equal(value.nativeExitCode, 0, 'Original harness process succeeded');
    assert.deepEqual(value.stepOutcomes, { pre: 'success', browser: 'success', post: 'success' });
    assert(pre.passed === true && post.passed === true);
    assert.deepEqual(pre.pins, PINS); assert.deepEqual(post.pins, PINS);
    assert.deepEqual(pre.runtime, post.runtime, 'Published runtime stayed fixed throughout actual browser execution');
    assert.deepEqual(pre.source, post.source, 'Unchanged local harness, fixture and browser dependency');
    assert.deepEqual(await sourceEvidence(), pre.source);
    assert.equal(native.passed, true);
    assert.equal(native.hostedSiteVerified, false, 'Keep original harness scope flag intact');
    assert.equal(native.physicalCameraVerified, false);
    assert.equal(native.video.build, PINS.runtimeBuild);
    assert.equal(native.video.inputBuild, PINS.runtimeVersion);
    assert.equal(native.camera.build, PINS.runtimeBuild);
    assert.equal(native.camera.workerBuild, PINS.runtimeBuild);
    assert.equal(native.camera.version, PINS.runtimeVersion);
    assert.equal(native.pageErrors.length, 0);
    value.actualProductionRegressionVerified = true;
    value.passed = true;
  } catch (error) {
    value.actualProductionRegressionVerified = false;
    value.error = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    await jsonFile('actual-production-receipt.json', value);
    console.log(JSON.stringify({ passed: value.passed, actualProductionRegressionVerified: value.actualProductionRegressionVerified, error: value.error }));
  }
}
if (phase === 'receipt') await receipt(); else await snapshot();
