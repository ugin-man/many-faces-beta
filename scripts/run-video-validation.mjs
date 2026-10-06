#!/usr/bin/env node
/**
 * Run already-built baseline and candidate servers plus browser verification in
 * one process/session. This is needed when separate exec calls have isolated
 * loopback networks. No build, source edit, catalog promotion or deploy occurs.
 *
 * VIDEO_BASELINE_ROOT=/absolute/path/to/many-faces-baseline \
 *   node scripts/run-video-validation.mjs
 *
 * Optional: VIDEO_CANDIDATE_ROOT (this repository), CHROME_PATH,
 * VIDEO_VALIDATION_REPORT_DIR (work/video-validation),
 * VIDEO_VALIDATION_TIMEOUT_MS (2700000; maximum 3600000).
 * Owns ports 4183/4185 and refuses existing listeners. Requires ffmpeg and the
 * project's existing Playwright/esbuild installation. Always cleans its own
 * process groups, including servers and browser children.
 */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {assertComparisonContract} from './clean-catalog-comparison-contract.mjs';

export const ACCEPTED_BASELINE = '7b6f7f0d42c18e770379bd56577e9608ba2e9f9e';
const FIXTURE_SHA256 = 'd470cf5a8aeb847f9c127ed8f0d567fcadd99e83c185ef60b7a8c9c6236a005b';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function validationMode(manifest) {
  assert.equal(manifest.totalFaces, 70000); assert.equal(manifest.searchableFaces, 70000);
  if (manifest.qualityAdmission === undefined) return 'identical';
  const stamp = manifest.qualityAdmission;
  assert(stamp && stamp.schemaVersion === 2 && stamp.status === 'complete' && stamp.selectedCount === 70000 && stamp.runtimeExclusionOverlayRequired === false && /^[a-f0-9]{64}$/.test(stamp.policySha256), 'An incomplete admission stamp cannot select either verification path');
  return 'admitted';
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trimEnd();
}
function sourceIdentity(root) {
  return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', 'import {buildIdentity} from "./build/runtime-identity.ts"; console.log(JSON.stringify(buildIdentity()));'], {cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024}));
}
async function fileHash(file, signal) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, {signal})) hash.update(bytes);
  return hash.digest('hex');
}
async function exists(file) {
  try {await fs.access(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
function publicCategory(file, mode) {
  if (mode !== 'admitted') return 'immutable';
  if (file.startsWith('public/seed-catalog/')) return 'admitted-core';
  if (['public/wink-support/v1/catalog.json', 'public/wink-support/v1/ATTRIBUTION.html', 'public/wink-support/v1/audit.json'].includes(file)) return 'bound-index';
  if (file.startsWith('public/wink-support/v1/images/')) return 'legacy-wink-image';
  return 'immutable';
}
async function verifyPublicAssets(roots, mode, signal) {
  const files = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, new Set(git(root, 'ls-files', '-z', '--', 'public').split('\0').filter(Boolean))]));
  const rows = [], removedLegacyImages = [];
  for (const file of [...new Set([...files.baseline, ...files.candidate])].sort()) {
    signal.throwIfAborted();
    const category = publicCategory(file, mode);
    if (['admitted-core', 'bound-index'].includes(category)) continue;
    if (category === 'legacy-wink-image' && !await exists(path.join(roots.candidate, file))) {removedLegacyImages.push(file); continue;}
    assert(files.baseline.has(file) && files.candidate.has(file), `Unexpected public asset addition/removal: ${file}`);
    const [before, after] = await Promise.all(['baseline', 'candidate'].map(name => fileHash(path.join(roots[name], file), signal)));
    assert.equal(after, before, `Immutable public asset changed: ${file}`);
    rows.push({file, sha256: before});
  }
  return {mode, files: rows.length, digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), removedLegacyImages, rows};
}
async function assertFreePort(port) {
  const occupied = await new Promise((resolve, reject) => {
    const socket = net.createConnection({host: '127.0.0.1', port});
    socket.setTimeout(1500);
    socket.once('connect', () => {socket.destroy(); resolve(true);});
    socket.once('error', error => {socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(false); else reject(error);});
    socket.once('timeout', () => {socket.destroy(); reject(new Error(`Could not establish whether port ${port} is free`));});
  });
  assert(!occupied, `Port ${port} already has a listener; stop the earlier server before using this launcher`);
}

export async function runVideoValidation() {
  const candidate = path.resolve(process.env.VIDEO_CANDIDATE_ROOT || repo);
  const out = path.resolve(candidate, process.env.VIDEO_VALIDATION_REPORT_DIR || 'work/video-validation');
  const report = {schemaVersion: 1, startedAt: new Date().toISOString(), baselineCommit: ACCEPTED_BASELINE, passed: false, physicalCameraVerified: false, hostedSiteVerified: false, steps: [], failures: []};
  const controller = new AbortController(), children = [], ownedGroups = new Set();
  let stopping = false, heartbeat, deadline;
  const progress = (stage, extra = {}) => console.log('VIDEO_VALIDATION ' + JSON.stringify({stage, ...extra}));
  const rememberGroups = () => {
    for (const child of children) if (child.process.pid) ownedGroups.add(child.process.pid);
    // Playwright gives Chromium another process group. Capture ownership from
    // the live descendant tree before terminating its harness parent.
    try {
      const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,pgid='], {encoding: 'utf8', timeout: 3000, maxBuffer: 3 * 1024 * 1024}).trim().split('\n').filter(Boolean).map(line => {
        const [pid, parent, group] = line.trim().split(/\s+/).map(Number); return {pid, parent, group};
      });
      const descendants = new Set(children.filter(child => !child.result).map(child => child.process.pid));
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) {descendants.add(row.pid); changed = true;}
      }
      const ownGroup = rows.find(row => row.pid === process.pid)?.group;
      for (const row of rows) if (descendants.has(row.pid) && row.group > 0 && row.group !== ownGroup) ownedGroups.add(row.group);
    } catch (error) {report.cleanupObservationError = String(error);}
  };
  const killGroups = signal => {
    for (const group of ownedGroups) {
      try {process.kill(-group, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
  };
  const stopSignal = () => controller.abort(new Error('Video validation interrupted'));
  const start = async (name, command, args, cwd, env, server = false) => {
    controller.signal.throwIfAborted();
    const log = path.join(out, name + '.log'), handle = await fs.open(log, 'w');
    let child;
    try {child = spawn(command, args, {cwd, env: {...process.env, ...env}, detached: true, stdio: ['ignore', handle.fd, handle.fd]});}
    catch (error) {await handle.close(); throw error;}
    const step = {name, command, args, cwd, log, startedAt: new Date().toISOString(), pid: child.pid};
    report.steps.push(step);
    const record = {process: child, step, result: null, finished: null};
    record.finished = new Promise(resolve => {
      const complete = result => {
        if (record.result) return;
        record.result = result; Object.assign(step, result, {finishedAt: new Date().toISOString()}); resolve(result);
        if (server && !stopping) controller.abort(new Error(`${name} exited before verification completed; see ${log}`));
      };
      child.once('error', error => complete({exitCode: null, error: error.message}));
      child.once('exit', (exitCode, signal) => complete({exitCode, signal}));
    });
    children.push(record);
    await handle.close();
    progress('started', {name, log});
    return record;
  };
  const run = async (name, command, args, cwd, env) => {
    const child = await start(name, command, args, cwd, env);
    const result = await child.finished;
    controller.signal.throwIfAborted();
    assert.equal(result.exitCode, 0, `${name} failed (${result.error || result.signal || result.exitCode}); see ${child.step.log}`);
    return child;
  };
  const save = async (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  try {
    assert.notEqual(process.platform, 'win32', 'This launcher requires POSIX process groups');
    await fs.mkdir(out, {recursive: true});
    assert(process.env.VIDEO_BASELINE_ROOT, 'Set VIDEO_BASELINE_ROOT to the already-built accepted baseline checkout');
    assert.equal(process.env.VIDEO_BASELINE_COMMIT || ACCEPTED_BASELINE, ACCEPTED_BASELINE, 'Use the pinned accepted baseline');
    const roots = {baseline: await fs.realpath(path.resolve(process.env.VIDEO_BASELINE_ROOT)), candidate: await fs.realpath(candidate)};
    assert.notEqual(roots.baseline, roots.candidate, 'Baseline and candidate checkouts must be isolated');
    assert.equal(git(roots.baseline, 'rev-parse', 'HEAD'), ACCEPTED_BASELINE, 'Baseline checkout is not the accepted commit');
    git(roots.baseline, 'diff', '--exit-code', ACCEPTED_BASELINE, '--', 'app', 'worker', 'build', 'public', 'package.json', 'package-lock.json', 'vite.config.ts', '.openai');
    report.roots = roots;
    const timeout = Number(process.env.VIDEO_VALIDATION_TIMEOUT_MS || 2700000);
    assert(Number.isSafeInteger(timeout) && timeout >= 60000 && timeout <= 3600000, 'VIDEO_VALIDATION_TIMEOUT_MS must be 60000..3600000');
    report.timeoutMs = timeout;
    deadline = setTimeout(() => controller.abort(new Error('Video validation exceeded its total deadline')), timeout);
    deadline.unref();
    heartbeat = setInterval(() => progress('running', {mode: report.mode, active: children.filter(child => !child.result).map(child => child.step.name)}), 15000);
    heartbeat.unref();
    process.once('SIGINT', stopSignal); process.once('SIGTERM', stopSignal);
    controller.signal.addEventListener('abort', () => {rememberGroups(); killGroups('SIGTERM');}, {once: true});
    const manifests = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, JSON.parse(await fs.readFile(path.join(root, 'public/seed-catalog/manifest.json'), 'utf8'))])));
    assert.equal(validationMode(manifests.baseline), 'identical', 'The accepted baseline must be the unstamped original catalog');
    report.mode = validationMode(manifests.candidate);
    if (process.env.VIDEO_VALIDATION_MODE) assert.equal(process.env.VIDEO_VALIDATION_MODE, report.mode, 'Requested mode differs from the physical candidate manifest');
    report.sourceIdentity = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, sourceIdentity(root)]));
    const fixture = path.join(roots.candidate, 'public/test-fixtures/reference-face-motion.mp4');
    report.fixtureSha256 = await fileHash(fixture, controller.signal);
    assert.equal(report.fixtureSha256, FIXTURE_SHA256, 'The full original video fixture changed');
    progress('public-asset-integrity', {mode: report.mode});
    const assets = await verifyPublicAssets(roots, report.mode, controller.signal);
    await save('public-assets.json', assets);
    report.publicAssets = {...assets, rows: undefined};
    for (const root of Object.values(roots)) {
      for (const file of ['seed-catalog/manifest.json', 'wink-support/v1/catalog.json']) {
        const [source, built] = await Promise.all(['public', 'dist/client'].map(base => fileHash(path.join(root, base, file), controller.signal)));
        assert.equal(built, source, `Production assets are stale; build this checkout before running the launcher: ${root}/${file}`);
      }
    }
    const chromeChoices = [process.env.CHROME_PATH, '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
    let chrome;
    if (process.env.CHROME_PATH) assert(await exists(process.env.CHROME_PATH), 'The explicit CHROME_PATH does not exist');
    for (const file of chromeChoices) if (await exists(file)) {chrome = file; break;}
    assert(chrome, 'Set CHROME_PATH to the installed browser executable');
    report.chromePath = chrome;
    const env = {CHROME_PATH: chrome, VIDEO_BASELINE_COMMIT: ACCEPTED_BASELINE, GITHUB_SHA: report.sourceIdentity.candidate.revision};
    const cameraFixture = path.join(out, 'fixtures', 'moving.y4m');
    await fs.mkdir(path.dirname(cameraFixture), {recursive: true});
    await run('prepare-virtual-camera', 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', fixture, '-t', '8', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2,fps=30', '-pix_fmt', 'yuv420p', cameraFixture], roots.candidate, env);
    report.virtualCameraFixture = {path: cameraFixture, sourceSha256: FIXTURE_SHA256, durationSeconds: 8, usedFor: 'supplementary virtual-camera regression; comparison trials use the full unchanged MP4'};
    await Promise.all([4183, 4185].map(assertFreePort));
    const servers = {};
    for (const [name, port] of [['baseline', 4185], ['candidate', 4183]]) servers[name] = await start(name + '-server', 'npm', ['start'], roots[name], {...env, PORT: String(port), HOST: '127.0.0.1'}, true);
    report.runtimeIdentity = {};
    await Promise.all([['baseline', 4185], ['candidate', 4183]].map(async ([name, port]) => {
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        controller.signal.throwIfAborted();
        assert(!servers[name].result, `${name} server exited during startup`);
        let identity;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/runtime`, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])});
          if (response.ok) identity = await response.json();
        } catch {controller.signal.throwIfAborted();}
        if (identity) {
          assert.equal(identity.version, 'camera-arrival-v3');
          assert.equal(identity.build, report.sourceIdentity[name].build, `${name} server does not run the current checkout's compiled source`);
          report.runtimeIdentity[name] = identity;
          await save(name + '-identity.json', identity);
          return;
        }
        await pause(500);
      }
      throw new Error(`${name} server did not become ready within 120 seconds; see ${servers[name].step.log}`);
    }));
    progress('servers-ready', {mode: report.mode, identities: report.runtimeIdentity});
    report.reports = {};
    const checkReport = async (key, file) => {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(value.passed, true, `${key} did not produce a successful report: ${file}`);
      report.reports[key] = {path: file, passed: value.passed};
      return value;
    };
    if (report.mode === 'identical') {
      const speedOut = path.join(out, 'identical-output');
      await run('identical-output-abba', process.execPath, ['scripts/verify-video-speed.mjs'], roots.candidate, {...env, VIDEO_SPEED_REPORT_DIR: speedOut});
      const speed = await checkReport('identicalOutput', path.join(speedOut, 'report.json'));
      assert.equal(speed.baseline, ACCEPTED_BASELINE);
      assert.deepEqual(speed.trials.map(trial => trial.variant), ['before', 'after', 'after', 'before']);
      assert.equal(speed.sameFrameReplay.length, 2);
      await checkReport('pendingNetworkCancellation', path.join(speedOut, 'cancellation.json'));
    } else {
      const cleanOut = path.join(out, 'admitted-catalog');
      await run('admitted-catalog-comparison', process.execPath, ['scripts/verify-clean-catalog.mjs'], roots.candidate, {...env, CLEAN_BASELINE_APP_ROOT: roots.baseline, CLEAN_BASELINE_CATALOG_ROOT: path.join(roots.baseline, 'public/seed-catalog'), CLEAN_CANDIDATE_CATALOG_ROOT: path.join(roots.candidate, 'public/seed-catalog'), CLEAN_BASELINE_URL: 'http://127.0.0.1:4185', CLEAN_CANDIDATE_URL: 'http://127.0.0.1:4183', CLEAN_REPORT_DIR: cleanOut});
      const comparison = await checkReport('admittedCatalog', path.join(cleanOut, 'report.json'));
      report.comparisonContract = assertComparisonContract(comparison);
      for (const trial of comparison.trials) assert.deepEqual(trial.identity, report.runtimeIdentity[trial.name], 'Comparison report belongs to another running application');
      report.reports.admittedCatalog.comparisonContract = report.comparisonContract;
      const cancellationOut = path.join(out, 'cancellation');
      await run('pending-network-cancellation', process.execPath, ['scripts/verify-video-cancellation.mjs'], roots.candidate, {...env, VIDEO_SPEED_REPORT_DIR: cancellationOut});
      await checkReport('pendingNetworkCancellation', path.join(cancellationOut, 'cancellation.json'));
    }
    const fullscreenOut = path.join(out, 'fullscreen');
    await run('fullscreen-and-virtual-camera', process.execPath, ['scripts/verify-fullscreen-ui.mjs'], roots.candidate, {...env, MANY_FACES_BASE_URL: 'http://127.0.0.1:4183', FULLSCREEN_REPORT_DIR: fullscreenOut, MANY_FACES_CAMERA_FIXTURE: cameraFixture});
    const fullscreen = await checkReport('fullscreenAndVirtualCamera', path.join(fullscreenOut, 'report.json'));
    assert.equal(fullscreen.camera.catalogTotal, 70000); assert.equal(fullscreen.camera.phase, 'running');
    assert.equal(fullscreen.physicalCameraVerified, false);
    report.virtualCameraVerified = true;
    for (const [name, root] of Object.entries(roots)) assert.equal(sourceIdentity(root).build, report.sourceIdentity[name].build, `${name} application source changed during validation`);
    assert.equal(await fileHash(fixture, controller.signal), FIXTURE_SHA256);
    controller.signal.throwIfAborted();
    report.passed = true;
  } catch (error) {
    report.failures.push(error.stack || String(error));
    process.exitCode = 1;
  } finally {
    stopping = true; clearInterval(heartbeat); clearTimeout(deadline);
    process.removeListener('SIGINT', stopSignal); process.removeListener('SIGTERM', stopSignal);
    rememberGroups(); killGroups('SIGTERM');
    const until = Date.now() + 5000;
    while (children.some(child => !child.result) && Date.now() < until) await pause(100);
    killGroups('SIGKILL');
    report.cleanupProcessGroups = [...ownedGroups];
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(out, {recursive: true});
    await save('launcher-report.json', report);
    progress('finished', {passed: report.passed, mode: report.mode, report: path.join(out, 'launcher-report.json'), failures: report.failures.map(value => value.split('\n')[0])});
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('VIDEO_BASELINE_ROOT=/absolute/path/to/accepted-baseline node scripts/run-video-validation.mjs\nUses already-built checkouts; owns ports 4183/4185; requires ffmpeg, Playwright/esbuild and CHROME_PATH. Automatically selects exact-output ABBA or admitted-catalog comparison from the candidate manifest, then retains cancellation and fullscreen/virtual-camera checks. Does not build or publish.');
  } else await runVideoValidation();
}
