#!/usr/bin/env node
/** Extract every valid query from the fixed public sample, using production
 * IMAGE/CPU analysis and production WebCodecs/compatibility decoding. These
 * are diagnostic queries from an already-composited video, not a new dataset.
 * Raw face descriptors stay in ignored work/; only this recipe and aggregate
 * provenance should be published.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PIN = 'ec97e233003e272cc203580953a180377945228d';
const config = {
  out: path.join(root, 'work/face-search'),
  modules: path.join(root, 'node_modules'),
  playwrightModules: path.join(root, 'node_modules'),
  chromium: process.env.RESEARCH_CHROMIUM || undefined,
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = {'--out': 'out', '--modules': 'modules', '--playwright-modules': 'playwrightModules', '--chromium': 'chromium'}[process.argv[i]];
  if (!key || !process.argv[i + 1]) throw new Error(`Unknown or missing argument ${process.argv[i]}`);
  config[key] = path.resolve(process.argv[i + 1]);
}
const requireFrom = directory => createRequire(path.join(directory, '__research_require__.cjs'));
const {build} = requireFrom(config.modules)('esbuild');
const {chromium} = requireFrom(config.playwrightModules)('playwright');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (name, value) => fs.writeFile(path.join(config.out, name), JSON.stringify(value, null, 2) + '\n');
assert.equal(os.endianness(), 'LE', 'This export writes native Float64; only little-endian hosts are supported.');
await fs.mkdir(config.out, {recursive: true});

const sourceFiles = [
  'app/live/video-decoder.ts', 'app/live/video-frame.ts', 'app/live/review-face-analyzer.ts',
  'app/live/face-analysis-core.ts', 'app/live/face-analysis-engine.ts', 'app/live/stable-landmarker.ts',
  'app/live/asset-reader.ts', 'app/catalog-feature.ts', 'app/catalog-pose.ts', 'app/face-actions.ts',
  'app/offline-matching.ts', 'app/live/video-pose-continuity.ts', 'app/runtime-identity.ts',
];
const sourceHashes = {};
for (const file of sourceFiles) {
  const bytes = await fs.readFile(path.join(root, file));
  const pinned = execFileSync('git', ['show', `${PIN}:${file}`], {cwd: root, maxBuffer: 10 * 1024 * 1024});
  assert.deepEqual(bytes, pinned, `Source drift in ${file}; query definition must be reviewed before changing the pin.`);
  sourceHashes[file] = sha(bytes);
}
const fixture = path.join(root, 'public/demo/many-faces-sample-30fps.mp4');
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height,nb_frames,duration,avg_frame_rate:format=duration', '-of', 'json', fixture], {encoding: 'utf8'}));
const video = probe.streams[0];
assert.equal(Number(video.nb_frames), 1061, 'The fixed complete sample must contain 1061 frames.');
assert.equal(video.avg_frame_rate, '30/1');
assert.equal(video.width, 768); assert.equal(video.height, 768);
const assetHashes = {};
for (const file of ['public/demo/many-faces-sample-30fps.mp4', 'public/mediapipe/face_landmarker.task',
  'public/mediapipe/vision_wasm_internal.js', 'public/mediapipe/vision_wasm_internal.wasm',
  'public/mediapipe/vision_wasm_nosimd_internal.js', 'public/mediapipe/vision_wasm_nosimd_internal.wasm']) {
  const bytes = await fs.readFile(path.join(root, file));
  const gitHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const expected = execFileSync('git', ['rev-parse', `${PIN}:${file}`], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(gitHash, expected, `Pinned asset differs: ${file}`);
  assetHashes[file] = {bytes: bytes.length, sha256: sha(bytes), gitBlobSha1: gitHash};
}

const entry = `
import {decodeReviewFrames} from './app/live/video-decoder.ts';
import {createReviewFaceAnalyzer} from './app/live/review-face-analyzer.ts';
import {catalogFeatureFromResult} from './app/catalog-feature.ts';
import {faceGeometryFromLandmarks} from './app/offline-matching.ts';
import {filterVideoProfileIslands} from './app/live/video-pose-continuity.ts';
window.extractResearchQueries = async () => {
  const response = await fetch('/sample.mp4');
  if (!response.ok) throw new Error('Sample download failed');
  const blob = await response.blob(), url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const ready = new Promise((resolve,reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
  video.src = url; document.body.append(video); await ready; video.pause();
  const fps = 30, duration = video.duration;
  const count = Math.max(2, Math.floor(duration * fps));
  if (count !== 1061) throw new Error('Unexpected planned frame count: ' + count);
  const times = Array.from({length:count}, (_,i) => Math.max(0, Math.min(duration - .001, i/fps)));
  const analyzer = await createReviewFaceAnalyzer({mode:'IMAGE',delegate:'CPU',execution:'main-thread',
    onProgress: event => console.log('QUERY_ENGINE ' + JSON.stringify(event))});
  const frames = [], evidence = [], decoderEvents = [];
  let i = 0; const started = performance.now();
  try {
    for await (const captured of decodeReviewFrames(video, blob, times, {backend:'auto',onBackend:event=>decoderEvents.push(event)})) {
      const time=times[i], width=captured.bitmap.width, height=captured.bitmap.height;
      const observed=await analyzer.analyze(captured.bitmap,time);
      const result=observed.result, points=result.faceLandmarks[0];
      let reason='no-face-landmarks', frame=null;
      if(points && result.faceBlendshapes.length) {
        const geometry=faceGeometryFromLandmarks(points,width/height);
        reason='invalid-geometry';
        if(geometry) { frame={time,feature:catalogFeatureFromResult(result),geometry,compensateRoll:true,sourceFrameIndex:i}; frames.push(frame); reason=null; }
      } else if (points) reason='no-blendshapes';
      evidence.push({sourceFrameIndex:i,time,mediaTime:captured.mediaTime,backend:captured.backend,
        evidence:captured.evidence,width,height,valid:!!frame,reason});
      i++;
      if(i%100===0 || i===count) console.log('QUERY_PROGRESS '+JSON.stringify({frames:i,total:count,valid:frames.length}));
    }
    if(i!==count) throw new Error('Incomplete frame coverage');
    const filtered=filterVideoProfileIslands(frames,fps), admitted=new Set(filtered.frames.map(x=>x.sourceFrameIndex));
    for(const row of evidence) row.appAdmitted=admitted.has(row.sourceFrameIndex);
    return {fps,duration,plannedFrames:count,decodedFrames:i,analyzer:analyzer.info,decoderEvents,
      extractionMs:performance.now()-started,appProfileIntervals:filtered.intervals,evidence,
      frames:frames.map(x=>({sourceFrameIndex:x.sourceFrameIndex,time:x.time,compensateRoll:true,
        appAdmitted:admitted.has(x.sourceFrameIndex),feature:Array.from(x.feature),projection:Array.from(x.geometry.projection)}))};
  } finally { analyzer.close(); video.remove(); URL.revokeObjectURL(url); }
};
`;
const bundle = await build({stdin: {contents: entry, loader: 'ts', resolveDir: root},
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
  nodePaths: [config.modules], define: {__MF_BUILD_ID__: JSON.stringify('face-search-query-extraction-v1'), __MF_REVISION__: JSON.stringify(PIN)}});
const bundleBytes = Buffer.from(bundle.outputFiles[0].contents);
const errors = [];
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/bundle.js"></script>'); return; }
    if (pathname === '/bundle.js') { response.setHeader('Content-Type','text/javascript'); response.end(bundleBytes); return; }
    const file = pathname === '/sample.mp4' ? fixture : /^\/api\/mediapipe\/[A-Za-z0-9_.-]+$/.test(pathname)
      ? path.join(root,'public/mediapipe',path.basename(pathname)) : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    const stat=await fs.stat(file);
    const ext=path.extname(file);
    response.setHeader('Content-Type',({'.js':'text/javascript','.wasm':'application/wasm','.mp4':'video/mp4'})[ext]||'application/octet-stream');
    response.setHeader('Content-Length',stat.size); createReadStream(file).pipe(response);
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('Asset error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const startedAt = new Date().toISOString();
try {
  browser = await chromium.launch({headless:true, executablePath:config.chromium,
    args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:800,height:800}}), page=await context.newPage();
  page.on('console', message => { if (/^QUERY_/.test(message.text())) console.log(message.text()); });
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(origin);
  await page.waitForFunction(()=>typeof window.extractResearchQueries==='function', undefined, {timeout:60000});
  const result=await page.evaluate(()=>window.extractResearchQueries());
  assert.equal(result.decodedFrames, 1061); assert.equal(result.evidence.length, 1061);
  assert.equal(result.analyzer.mode,'IMAGE'); assert.equal(result.analyzer.delegate,'CPU');
  assert.equal(result.analyzer.execution,'main-thread');
  assert.equal(errors.length,0,errors.join('\n'));
  const features=new Float64Array(result.frames.length*55), projections=new Float64Array(result.frames.length*936);
  const metadata=[];
  for(let i=0;i<result.frames.length;i++) {
    const {feature,projection,...rest}=result.frames[i];
    assert.equal(feature.length,55); assert.equal(projection.length,936);
    assert.ok(feature.every(Number.isFinite)); assert.ok(projection.every(Number.isFinite));
    features.set(feature,i*55); projections.set(projection,i*936); metadata.push(rest);
  }
  const files={};
  for(const [name,array,shape] of [['queries.features.f64',features,[result.frames.length,55]],['queries.projections.f64',projections,[result.frames.length,936]]]) {
    const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength);
    await fs.writeFile(path.join(config.out,name),bytes); files[name]={shape,dtype:'<f8',bytes:bytes.length,sha256:sha(bytes)};
  }
  await writeJson('queries.json',metadata);
  files['queries.json']={bytes:(await fs.stat(path.join(config.out,'queries.json'))).size,sha256:sha(await fs.readFile(path.join(config.out,'queries.json')))};
  const {frames,...observed}=result;
  const moduleVersion = name => JSON.parse(execFileSync(process.execPath,['-e',`const fs=require('fs');let p=require.resolve(${JSON.stringify(name)},{paths:[${JSON.stringify(config.modules)}]});while(!fs.existsSync(require('path').join(p,'package.json')))p=require('path').dirname(p);process.stdout.write(fs.readFileSync(require('path').join(p,'package.json')));`],{encoding:'utf8'})).version;
  const manifest={schema:'many-faces-video-queries-v1',sourceCommit:PIN,startedAt,finishedAt:new Date().toISOString(),
    node:process.version,chromium:browser.version(),packages:{mediapipe:moduleVersion('@mediapipe/tasks-vision'),mediabunny:moduleVersion('mediabunny')},
    fixture:'public/demo/many-faces-sample-30fps.mp4',sourceHashes,assetHashes,ffprobe:probe,bundleSha256:sha(bundleBytes),
    queryCount:frames.length,appAdmittedCount:metadata.filter(x=>x.appAdmitted).length,files,...observed,
    primarySelection:'Every finite, geometrically valid detected frame, before the application profile-island filter. No interval, frame, or expression is selected using search results.',
    exclusionPolicy:'Only missing landmarks/blendshapes or invalid geometry prevents a query; every decoded frame and reason is retained in evidence.',
    appAdmittedPolicy:'Diagnostic flag from the existing noncausal profile-island filter; not used to select primary queries or passed to online search.',
    limitations:['One pre-existing, already-composited public sample; not an independent raw-video test corpus.','Feature extraction is prepared once and excluded from search timing.','CPU/IMAGE production inference and feature conversion, run on main thread; no claim of browser or MediaPipe output invariance across hosts.'],errors};
  await writeJson('queries.manifest.json',manifest);
  console.log('QUERY_COMPLETE '+JSON.stringify({queryCount:manifest.queryCount,plannedFrames:manifest.plannedFrames,appAdmittedCount:manifest.appAdmittedCount,out:config.out,querySha256:files['queries.features.f64'].sha256}));
} catch(error) {
  await writeJson('queries.failed.json',{startedAt,failedAt:new Date().toISOString(),error:String(error),errors}); throw error;
} finally {
  if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve));
}
